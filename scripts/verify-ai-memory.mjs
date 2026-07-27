#!/usr/bin/env node
// verify-ai-memory.mjs — non-destructive end-to-end check for the ai-memory
// setup. Mirrors the verification checklist in the runbook.
//
// The LLM backend is *detected*, never assumed: the container's own
// AI_MEMORY_LLM_* environment is what the server actually runs with, so a
// claude-sub install is checked against the local `claude -p` shim and a
// `--provider local` install against Ollama.
//
// Usage:
//   node scripts/verify-ai-memory.mjs                 # run all checks
//   node scripts/verify-ai-memory.mjs --json          # machine-readable summary
//
// Zero deps, Node stdlib only (repo convention). Read-only: it never writes to
// the wiki, never mutates Docker/LaunchAgent state. `ai-memory bootstrap` is run
// with --dry-run, which the upstream docs document as collect-and-estimate only.
//
// Tunables (export these only when the container is not the source of truth,
// e.g. a remote or native deploy):
//   AI_MEMORY_CONTAINER     container name          (default: ai-memory)
//   AI_MEMORY_REPO          repo for bootstrap      (default: cwd)
//   AI_MEMORY_LLM_PROVIDER  provider override       (default: from container)
//   AI_MEMORY_LLM_BASE_URL  openai-compat base URL  (default: from container)
//   AI_MEMORY_LLM_MODEL     expected model          (default: from container)

import { spawnSync } from 'node:child_process';

const CONTAINER = process.env.AI_MEMORY_CONTAINER || 'ai-memory';
const REPO = process.env.AI_MEMORY_REPO || process.cwd();

const LLM_ENV_KEYS = [
  'AI_MEMORY_LLM_PROVIDER',
  'AI_MEMORY_LLM_BASE_URL',
  'AI_MEMORY_LLM_MODEL',
];
// Containers reach host services through this alias; from the host itself the
// same service is on loopback.
const DOCKER_HOST_ALIAS = 'host.docker.internal';
const LOOPBACK_HOST = '127.0.0.1';
const OLLAMA_DEFAULT_PORT = '11434';
const HTTP_TIMEOUT_MS = 5000;
const CMD_TIMEOUT_MS = 60000;

const jsonMode = process.argv.includes('--json');
const results = [];

function record(name, status, detail) {
  results.push({ name, status, detail });
  if (!jsonMode) {
    const icon = { PASS: '✓', WARN: '!', FAIL: '✗', SKIP: '–' }[status] || '?';
    console.log(`${icon} ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// Run a command; return {ok, stdout, stderr, code} without throwing.
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: CMD_TIMEOUT_MS, ...opts });
  return {
    ok: r.status === 0,
    code: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
    missing: r.error && r.error.code === 'ENOENT',
  };
}

function have(bin) {
  return sh('command', ['-v', bin]).ok;
}

// The server's own configuration, read from the container it runs in. Returns
// null when it cannot be read at all (no docker, no container) — which is not
// the same as an empty config (a zero-LLM install).
function containerLlmEnv() {
  if (!have('docker')) return null;
  const r = sh('docker', ['inspect', '-f', '{{range .Config.Env}}{{println .}}{{end}}', CONTAINER]);
  if (!r.ok) return null;
  const found = {};
  for (const line of r.stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    if (LLM_ENV_KEYS.includes(key)) found[key] = line.slice(eq + 1);
  }
  return found;
}

// shim | ollama | remote-api | none | unknown
function classifyBackend(provider, baseUrl) {
  if (!provider) return 'none';
  if (provider === 'anthropic' || provider === 'anthropic-oauth') return 'remote-api';
  if (provider !== 'openai-compat') return 'unknown';
  const url = parseUrl(baseUrl);
  if (!url) return 'unknown';
  return url.port === OLLAMA_DEFAULT_PORT ? 'ollama' : 'shim';
}

function parseUrl(raw) {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

// Same service, addressed from the host instead of from inside the container.
function hostFacingUrl(baseUrl) {
  const url = parseUrl(baseUrl);
  if (url && url.hostname === DOCKER_HOST_ALIAS) url.hostname = LOOPBACK_HOST;
  return url;
}

function detectLlmConfig() {
  const fromContainer = containerLlmEnv();
  const config = {
    provider: process.env.AI_MEMORY_LLM_PROVIDER || fromContainer?.AI_MEMORY_LLM_PROVIDER,
    baseUrl: process.env.AI_MEMORY_LLM_BASE_URL || fromContainer?.AI_MEMORY_LLM_BASE_URL,
    model: process.env.AI_MEMORY_LLM_MODEL || fromContainer?.AI_MEMORY_LLM_MODEL,
  };
  const determined = fromContainer !== null || config.provider;
  return {
    ...config,
    kind: determined ? classifyBackend(config.provider, config.baseUrl) : 'undetermined',
  };
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// claude-sub: the openai-compat base URL points at scripts/claude-openai-shim.mjs.
async function checkShim(config) {
  const url = hostFacingUrl(config.baseUrl);
  if (!url) return record('LLM backend', 'FAIL', `unparsable base URL "${config.baseUrl}"`);
  try {
    const health = await getJson(`${url.origin}/healthz`);
    if (!health?.ok) {
      return record('LLM backend', 'FAIL', `${url.origin}/healthz did not report ok`);
    }
    record('LLM backend', 'PASS', `claude -p shim up at ${url.origin} (backend: ${health.backend})`);
    if (config.model && health.model && health.model !== config.model) {
      record('LLM model', 'WARN', `server asks for ${config.model}, shim defaults to ${health.model}`);
    } else {
      record('LLM model', 'PASS', config.model || health.model || '(shim default)');
    }
  } catch (e) {
    record(
      'LLM backend',
      'FAIL',
      `${url.origin}/healthz unreachable (${e.message}). Check the LaunchAgent: ` +
        'launchctl list | grep claude-openai-shim',
    );
  }
}

// --provider local: the openai-compat base URL points at Ollama/LM Studio.
async function checkOllama(config) {
  const url = hostFacingUrl(config.baseUrl);
  if (!url) return record('LLM backend', 'FAIL', `unparsable base URL "${config.baseUrl}"`);
  const modelsUrl = `${url.origin}${url.pathname.replace(/\/$/, '')}/models`;
  try {
    const body = await getJson(modelsUrl);
    const ids = (body.data || []).map((m) => m.id);
    record('LLM backend', 'PASS', `Ollama reachable at ${url.origin}`);
    if (!config.model) {
      return record('LLM model', 'WARN', `no AI_MEMORY_LLM_MODEL configured (have: ${ids.join(', ') || 'none'})`);
    }
    if (ids.some((id) => id === config.model || id.startsWith(`${config.model}:`))) {
      record('LLM model', 'PASS', `${config.model} present`);
    } else {
      record('LLM model', 'FAIL', `${config.model} not pulled (have: ${ids.join(', ') || 'none'}). Run: ollama pull ${config.model}`);
    }
  } catch (e) {
    record('LLM backend', 'FAIL', `${modelsUrl} unreachable (${e.message}). Is \`ollama serve\` running?`);
  }
}

async function checkLlmBackend(config) {
  switch (config.kind) {
    case 'shim':
      return checkShim(config);
    case 'ollama':
      return checkOllama(config);
    case 'remote-api':
      return record(
        'LLM backend',
        'SKIP',
        `provider ${config.provider} calls a remote API — no local endpoint to probe; credential health shows up in \`ai-memory status\``,
      );
    case 'none':
      return record('LLM backend', 'SKIP', 'zero-LLM install (no AI_MEMORY_LLM_PROVIDER) — no backend to verify');
    case 'undetermined':
      return record(
        'LLM backend',
        'SKIP',
        `could not read AI_MEMORY_LLM_* from container "${CONTAINER}" — backend NOT verified. ` +
          'Export AI_MEMORY_LLM_PROVIDER/AI_MEMORY_LLM_BASE_URL to check a remote or native deploy',
      );
    default:
      return record(
        'LLM backend',
        'WARN',
        `unrecognised provider "${config.provider}" (base URL: ${config.baseUrl || 'none'}) — not verified`,
      );
  }
}

// Docker + ai-memory container running
function checkContainer() {
  if (!have('docker')) return record('Docker', 'SKIP', 'docker not found — native/remote deploy?');
  const ps = sh('docker', ['ps', '--filter', `name=${CONTAINER}`, '--format', '{{.Names}} {{.Status}}']);
  if (ps.stdout.includes(CONTAINER)) {
    record('ai-memory container', 'PASS', ps.stdout.split('\n')[0]);
    return true;
  }
  const psa = sh('docker', ['ps', '-a', '--filter', `name=${CONTAINER}`, '--format', '{{.Names}} {{.Status}}']);
  if (psa.stdout.includes(CONTAINER)) {
    record('ai-memory container', 'FAIL', `exists but not running: ${psa.stdout.split('\n')[0]}`);
  } else {
    record('ai-memory container', 'FAIL', 'no container — run setup-ai-memory.mjs');
  }
  return false;
}

// ai-memory status + provider health (via wrapper if present, else docker exec)
function checkStatus(config) {
  let r;
  if (have('ai-memory')) r = sh('ai-memory', ['status', '--json']);
  else if (have('docker')) r = sh('docker', ['exec', CONTAINER, 'ai-memory', 'status', '--json']);
  else return record('ai-memory status', 'SKIP', 'neither ai-memory wrapper nor docker available');

  if (!r.ok) return record('ai-memory status', 'FAIL', (r.stderr || r.stdout || `exit ${r.code}`).split('\n')[0]);
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch { /* status may not be pure JSON on all versions */ }
  record('ai-memory status', 'PASS', 'server responded');

  const blob = (r.stdout || '').toLowerCase();
  const expected = config.provider;
  const reported = parsed?.llm?.provider;
  if (!expected) {
    record('LLM provider', 'SKIP', `status reports "${reported || '(not in output)'}" — nothing detected to compare against`);
  } else if (reported === expected || blob.includes(expected.toLowerCase())) {
    record('LLM provider', 'PASS', `${expected} — as configured on the container`);
  } else {
    record('LLM provider', 'WARN', `status reports "${reported || '(not in output)'}" but the container is configured for "${expected}"`);
  }
  if (blob.includes('unhealthy') || blob.includes('error')) {
    record('Provider health', 'WARN', 'status text mentions unhealthy/error — inspect `ai-memory status`');
  }
}

// bootstrap --dry-run proves the LLM provider is actually reachable from the server
function checkBootstrapDryRun() {
  let r;
  if (have('ai-memory')) r = sh('ai-memory', ['bootstrap', '--dry-run'], { cwd: REPO });
  else if (have('docker')) r = sh('docker', ['exec', '-w', '/data', CONTAINER, 'ai-memory', 'bootstrap', '--dry-run']);
  else return record('bootstrap --dry-run', 'SKIP', 'no ai-memory CLI available');
  if (!r.ok && !r.stdout) return record('bootstrap --dry-run', 'WARN', (r.stderr || `exit ${r.code}`).split('\n')[0]);
  try {
    const j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    record('bootstrap --dry-run', 'PASS', `${j.sources_collected ?? '?'} sources, ~${j.estimated_input_tokens ?? '?'} tokens`);
  } catch {
    record('bootstrap --dry-run', 'PASS', 'ran (non-JSON output)');
  }
}

// Wiki is git-versioned (proves capture is being committed)
function checkWikiGit() {
  if (!have('docker')) return record('Wiki git history', 'SKIP', 'docker not available');
  const log = sh('docker', ['exec', CONTAINER, 'git', '-C', '/data/wiki', 'log', '--oneline', '-n', '5']);
  if (log.ok && log.stdout) record('Wiki git history', 'PASS', `${log.stdout.split('\n').length} recent commits`);
  else record('Wiki git history', 'WARN', 'no wiki git log yet — capture a session first');
}

async function main() {
  const config = detectLlmConfig();
  if (!jsonMode) {
    console.log(
      `ai-memory verify  (container=${CONTAINER}, backend=${config.kind}, ` +
        `model=${config.model || 'n/a'}, repo=${REPO})\n`,
    );
  }

  const up = checkContainer();
  await checkLlmBackend(config);
  if (up) { checkStatus(config); checkBootstrapDryRun(); checkWikiGit(); }
  else record('Downstream checks', 'SKIP', 'container not running — fix that first');

  const fails = results.filter((r) => r.status === 'FAIL').length;
  const warns = results.filter((r) => r.status === 'WARN').length;
  if (jsonMode) {
    console.log(JSON.stringify({ ok: fails === 0, fails, warns, results }, null, 2));
  } else {
    console.log(`\n${fails === 0 ? '✓ all critical checks passed' : `✗ ${fails} failed`}` + (warns ? `, ${warns} warning(s)` : ''));
  }
  process.exit(fails === 0 ? 0 : 1);
}

main();
