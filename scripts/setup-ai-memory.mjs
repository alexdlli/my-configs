#!/usr/bin/env node
// Set up ai-memory (https://github.com/akitaonrails/ai-memory) for this harness:
// long-term markdown-wiki memory + Hermes-style auto-improve for coding agents.
//
// Thin orchestrator around ai-memory's own (idempotent) installers, plus the
// local `claude -p` shim that lets ai-memory use your Claude *subscription*
// through the sanctioned CLI path instead of a paid API key.
//
// What it does (provider claude-sub or codex-sub):
//   1. Install the ai-memory CLI wrapper into ~/.local/bin if missing.
//   2. For claude-sub, install + load the local Claude subscription shim.
//      For codex-sub, use ai-memory's native ChatGPT/Codex OAuth provider.
//   3. Start the ai-memory server container on loopback with that provider.
//   4. Wire Claude Code: install-mcp + install-hooks + install-instructions.
//
// Usage:
//   node scripts/setup-ai-memory.mjs                      # claude-sub (default)
//   node scripts/setup-ai-memory.mjs --provider codex-sub # ChatGPT/Codex OAuth
//   node scripts/setup-ai-memory.mjs --provider anthropic # paid API key
//   node scripts/setup-ai-memory.mjs --provider local     # Ollama/LM Studio
//   node scripts/setup-ai-memory.mjs --provider none      # zero-LLM
//   node scripts/setup-ai-memory.mjs --dry-run            # print plan, run nothing
//   node scripts/setup-ai-memory.mjs --no-server          # client-only
//   node scripts/setup-ai-memory.mjs -h | --help
//
// Providers:
//   claude-sub      (default) openai-compat -> local claude -p shim -> your
//                   Claude subscription. Sanctioned CLI path; see
//                   docs/integrations/ai-memory.md for the (in-flux) policy note.
//                   Requires: `claude` in PATH, logged into your subscription,
//                   and NO ANTHROPIC_API_KEY exported (the shim strips it anyway).
//   anthropic       AI_MEMORY_LLM_PROVIDER=anthropic + ANTHROPIC_API_KEY (paid).
//   anthropic-oauth raw OAuth token vs /v1/messages. Unofficial / against ToS.
//   local           openai-compat -> http://host.docker.internal:11434/v1 (Ollama).
//   none            zero-LLM (FTS5 + rule-based summaries; no auto-improve).
//
// macOS only (LaunchAgent + Docker Desktop host.docker.internal). Node.js 24+.

import { argv, exit, platform, env, execPath } from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const HOME = os.homedir();
const LOCAL_BIN = path.join(HOME, '.local', 'bin');
const WRAPPER_PATH = path.join(LOCAL_BIN, 'ai-memory');
const WRAPPER_URL =
  'https://raw.githubusercontent.com/akitaonrails/ai-memory/main/bin/ai-memory';

const CONTAINER = 'ai-memory';
const BIND = '127.0.0.1:49374';
const IMAGE = 'akitaonrails/ai-memory:latest';

const SHIM_SCRIPT = path.join(REPO_ROOT, 'scripts', 'claude-openai-shim.mjs');
const SHIM_LABEL = 'com.my-configs.claude-openai-shim';
const SHIM_PLIST = path.join(HOME, 'Library', 'LaunchAgents', `${SHIM_LABEL}.plist`);
const SHIM_LOG_DIR = path.join(HOME, '.local', 'share', 'ai-memory');
const DEFAULT_PORT = 8787;
const MIN_PORT = 1;
const MAX_PORT = 65535;
const DEFAULT_CLAUDE_MODEL = 'claude-haiku-4-5';
const DEFAULT_CODEX_MODEL = 'gpt-5.5';
const LOCAL_MODEL = 'qwen3:8b';

const PROVIDERS = ['claude-sub', 'codex-sub', 'anthropic', 'anthropic-oauth', 'local', 'none'];

// Credentials are handed to child processes through the environment, never
// through argv: argv shows up in `ps`, and this script echoes every command it
// runs in --dry-run. Anything printed whose NAME looks like a credential is
// masked, so the next secret someone adds is covered too.
const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD/i;
const REDACTED = '***';

function usage() {
  console.log(`Set up ai-memory for the my-configs harness.

Usage:
  node scripts/setup-ai-memory.mjs [options]

Options:
  --provider <p>  one of: ${PROVIDERS.join(', ')}   (default: claude-sub)
  --port <n>      shim port for subscription backends (default: ${DEFAULT_PORT})
  --model <m>     LLM model override                  (provider-specific default)
  --no-server     skip starting the container (client-only)
  --dry-run       print every command; execute nothing
  -h, --help      show this help

See docs/integrations/ai-memory.md for the per-provider details and the
in-flux subscription-policy caveat.`);
}

function parseArgs(args) {
  const opts = {
    provider: 'claude-sub',
    port: DEFAULT_PORT,
    model: null,
    server: true,
    dryRun: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--no-server') opts.server = false;
    else if (a === '--provider') opts.provider = args[++i];
    else if (a === '--port') opts.port = parsePort(args[++i]);
    else if (a === '--model') opts.model = args[++i];
    else if (a === '-h' || a === '--help') {
      usage();
      exit(0);
    } else {
      console.error(`! error: unknown option: ${a}`);
      usage();
      exit(1);
    }
  }
  if (!PROVIDERS.includes(opts.provider)) {
    die(`unknown --provider "${opts.provider}". Choose: ${PROVIDERS.join(', ')}`);
  }
  if (!opts.model) {
    opts.model = opts.provider === 'local'
      ? LOCAL_MODEL
      : opts.provider === 'codex-sub'
        ? DEFAULT_CODEX_MODEL
        : DEFAULT_CLAUDE_MODEL;
  }
  return opts;
}

function die(msg) {
  console.error(`! error: ${msg}`);
  exit(1);
}

// An unvalidated port lands in the LaunchAgent plist and in the container's
// base URL, where "NaN" fails much later and much less clearly.
function parsePort(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_PORT || n > MAX_PORT) {
    die(`--port must be an integer between ${MIN_PORT} and ${MAX_PORT} (got "${raw}").`);
  }
  return n;
}

function escapeXml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function redactArg(arg) {
  const eq = arg.indexOf('=');
  if (eq <= 0) return arg;
  const name = arg.slice(0, eq);
  return SECRET_ENV_NAME.test(name) ? `${name}=${REDACTED}` : arg;
}

function run(cmd, args, { dryRun, allowFail = false, extraEnv } = {}) {
  const printable = `${cmd} ${args.map(redactArg).join(' ')}`.trim();
  if (dryRun) {
    console.log(`  $ ${printable}`);
    return { code: 0, stdout: '', stderr: '' };
  }
  const res = spawnSync(cmd, args, {
    stdio: 'inherit',
    encoding: 'utf8',
    env: extraEnv ? { ...env, ...extraEnv } : env,
  });
  if (res.error) {
    if (allowFail) return { code: 1, stdout: '', stderr: String(res.error) };
    die(`failed to run \`${printable}\`: ${res.error.message}`);
  }
  if (res.status !== 0 && !allowFail) {
    die(`\`${printable}\` exited with code ${res.status}`);
  }
  return { code: res.status ?? 0 };
}

function writeFile(p, content, { dryRun }) {
  if (dryRun) {
    console.log(`  > write ${p} (${Buffer.byteLength(content)} bytes)`);
    return;
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  console.log(`✓ wrote ${p}`);
}

function have(cmd) {
  return spawnSync('command', ['-v', cmd], { shell: true }).status === 0;
}

function which(cmd) {
  const r = spawnSync('command', ['-v', cmd], { shell: true, encoding: 'utf8' });
  return (r.stdout || '').trim();
}

function containerExists(name) {
  const r = spawnSync(
    'docker',
    ['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'],
    { encoding: 'utf8' },
  );
  return (r.stdout || '').trim() === name;
}

function ensureWrapper(opts) {
  if (fs.existsSync(WRAPPER_PATH)) {
    console.log(`✓ ai-memory wrapper present at ${WRAPPER_PATH}`);
    return;
  }
  console.log(`→ installing ai-memory wrapper → ${WRAPPER_PATH}`);
  run('mkdir', ['-p', LOCAL_BIN], opts);
  run('curl', ['-fsSL', WRAPPER_URL, '-o', WRAPPER_PATH], opts);
  run('chmod', ['+x', WRAPPER_PATH], opts);
}

// claude-sub only: install + (re)load a LaunchAgent that keeps the shim running.
function ensureShimAgent(opts) {
  if (!opts.dryRun && !have('claude')) {
    die(
      'provider claude-sub needs the `claude` CLI in PATH, logged into your\n' +
        '      subscription. Install Claude Code and run `claude` once to log in,\n' +
        '      then re-run. (Or pick --provider anthropic / local / none.)',
    );
  }
  const nodeBin = execPath; // absolute path to the node running this script
  const claudeBin = opts.dryRun ? 'claude' : which('claude') || 'claude';
  const agentPath = `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${LOCAL_BIN}`;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escapeXml(SHIM_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodeBin)}</string>
    <string>${escapeXml(SHIM_SCRIPT)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SHIM_PORT</key><string>${escapeXml(opts.port)}</string>
    <key>SHIM_HOST</key><string>127.0.0.1</string>
    <key>SHIM_MODEL</key><string>${escapeXml(opts.model)}</string>
    <key>CLAUDE_BIN</key><string>${escapeXml(claudeBin)}</string>
    <key>PATH</key><string>${escapeXml(agentPath)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(path.join(SHIM_LOG_DIR, 'shim.out.log'))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(path.join(SHIM_LOG_DIR, 'shim.err.log'))}</string>
</dict>
</plist>
`;
  run('mkdir', ['-p', SHIM_LOG_DIR], opts);
  console.log(`→ installing shim LaunchAgent (${SHIM_LABEL})`);
  writeFile(SHIM_PLIST, plist, opts);
  // unload-then-load makes re-runs idempotent
  run('launchctl', ['unload', SHIM_PLIST], { ...opts, allowFail: true });
  run('launchctl', ['load', '-w', SHIM_PLIST], opts);
  console.log(`✓ shim will keep running on login at http://127.0.0.1:${opts.port}`);
}

// Returns the docker `-e` flags for the chosen provider, plus the credentials
// those flags inherit by name. `-e NAME` (no value) tells docker to copy NAME
// from its own environment, so no secret ever reaches argv.
function providerDockerEnv(opts) {
  switch (opts.provider) {
    case 'claude-sub':
      return {
        flags: [
          '-e', 'AI_MEMORY_LLM_PROVIDER=openai-compat',
          '-e', `AI_MEMORY_LLM_BASE_URL=http://host.docker.internal:${opts.port}/v1`,
          '-e', `AI_MEMORY_LLM_MODEL=${opts.model}`,
        ],
        secretEnv: {},
      };
    case 'codex-sub':
      return {
        flags: [
          '-e', 'AI_MEMORY_LLM_PROVIDER=openai-oauth',
          '-e', `AI_MEMORY_LLM_MODEL=${opts.model}`,
        ],
        secretEnv: {},
      };
    case 'anthropic': {
      const key = env.ANTHROPIC_API_KEY;
      if (!key && !opts.dryRun) {
        die('provider anthropic needs ANTHROPIC_API_KEY exported in this shell.');
      }
      return {
        flags: [
          '-e', 'AI_MEMORY_LLM_PROVIDER=anthropic',
          '-e', 'ANTHROPIC_API_KEY',
          '-e', `AI_MEMORY_LLM_MODEL=${opts.model}`,
        ],
        secretEnv: key ? { ANTHROPIC_API_KEY: key } : {},
      };
    }
    case 'anthropic-oauth': {
      const tok = env.ANTHROPIC_OAUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN;
      if (!tok && !opts.dryRun) {
        die('provider anthropic-oauth needs CLAUDE_CODE_OAUTH_TOKEN (claude setup-token).');
      }
      console.log('! note: anthropic-oauth is unofficial / against Anthropic ToS.');
      return {
        flags: [
          '-e', 'AI_MEMORY_LLM_PROVIDER=anthropic-oauth',
          '-e', 'ANTHROPIC_OAUTH_TOKEN',
          '-e', `AI_MEMORY_LLM_MODEL=${opts.model}`,
        ],
        secretEnv: tok ? { ANTHROPIC_OAUTH_TOKEN: tok } : {},
      };
    }
    case 'local':
      console.log('! note: provider local needs Ollama running with the model pulled.');
      return {
        flags: [
          '-e', 'AI_MEMORY_LLM_PROVIDER=openai-compat',
          '-e', 'AI_MEMORY_LLM_BASE_URL=http://host.docker.internal:11434/v1',
          '-e', `AI_MEMORY_LLM_MODEL=${opts.model}`,
        ],
        secretEnv: {},
      };
    case 'none':
    default:
      return { flags: [], secretEnv: {} };
  }
}

function startServer(opts) {
  if (containerExists(CONTAINER) && !opts.dryRun) {
    console.log(
      `✓ container "${CONTAINER}" already exists — leaving it.\n` +
        `  Reconfigure: docker rm -f ${CONTAINER} && re-run this script.`,
    );
    return;
  }
  console.log(`→ starting ai-memory server (provider: ${opts.provider})`);
  const { flags, secretEnv } = providerDockerEnv(opts);
  run(
    'docker',
    [
      'run', '-d', '--name', CONTAINER,
      '--restart', 'unless-stopped',
      '-p', `${BIND}:49374`,
      '-v', 'ai-memory-data:/data',
      ...flags,
      IMAGE,
    ],
    { ...opts, extraEnv: secretEnv },
  );
}

function wireAgents(opts) {
  console.log('→ wiring Claude Code + Codex (MCP + hooks + instructions)');
  run('ai-memory', ['install-mcp', '--client', 'claude-code', '--apply'], opts);
  run('ai-memory', ['install-hooks', '--agent', 'claude-code', '--apply'], opts);
  run('ai-memory', ['install-mcp', '--client', 'codex', '--apply'], opts);
  run('ai-memory', ['install-hooks', '--agent', 'codex', '--apply'], opts);
  // Global skills scope on purpose: the default (`project`) writes ai-memory's
  // managed Agent Skills into <repo>/.claude/skills, the directory install.mjs
  // owns one entry at a time precisely so no tool takes over the namespace.
  run('ai-memory', ['install-instructions', '--skills-scope', 'global'], {
    ...opts,
    allowFail: true,
  });
}

function main() {
  if (platform === 'win32') {
    die('Windows is not supported here — use WSL2 and follow upstream docs/install.md.');
  }
  const opts = parseArgs(argv.slice(2));

  console.log(`ai-memory setup  (provider: ${opts.provider}, mode: ${opts.dryRun ? 'dry-run' : 'apply'})`);
  console.log(`server: ${opts.server ? `docker @ ${BIND}` : 'external (--no-server)'}`);
  if (opts.provider === 'claude-sub') console.log(`shim:   127.0.0.1:${opts.port} -> claude -p (model ${opts.model})`);
  if (opts.provider === 'codex-sub') console.log(`oauth:  ChatGPT/Codex native provider (model ${opts.model})`);
  console.log();

  if (!opts.dryRun && !have('docker') && opts.server) {
    die('docker not found. Install Docker Desktop, then re-run.');
  }

  ensureWrapper(opts);

  if (opts.provider === 'claude-sub') {
    ensureShimAgent(opts);
  }

  if (opts.server) {
    startServer(opts);
  }

  wireAgents(opts);

  console.log();
  if (opts.dryRun) {
    console.log('(dry-run) nothing changed.');
    return;
  }
  console.log('✓ Done. Verify:');
  if (opts.provider === 'claude-sub') {
    console.log(`    curl -s localhost:${opts.port}/healthz        # shim up`);
  }
  console.log('    ai-memory status                          # server + provider health');
  console.log('  Open a new Claude Code session — SessionStart fetches any handoff.');
  console.log('  Adopt an existing repo:  cd <repo> && ai-memory bootstrap');
}

main();
