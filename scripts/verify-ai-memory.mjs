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
// Exit codes:
//   0  everything that applies to this install was checked and passed
//   1  at least one check failed
//   2  nothing failed, but a missing prerequisite (docker, the CLI, the
//      container) left part of the setup unverified — an unverified setup is
//      not a verified setup, so it never reports success
//
// Zero deps, Node stdlib only (repo convention). Read-only: it never writes to
// the wiki, never mutates Docker/LaunchAgent state. `ai-memory bootstrap` is run
// with --dry-run, which the upstream docs document as collect-and-estimate only.
//
// Tunables (export these only when the container is not the source of truth,
// e.g. a remote or native deploy):
//   AI_MEMORY_CONTAINER     container name          (default: ai-memory)
//   AI_MEMORY_REPO          repo for bootstrap      (default: cwd)
//   AI_MEMORY_IMAGE         image the server runs   (default: akitaonrails/ai-memory:2.0.2)
//   AI_MEMORY_LLM_PROVIDER  provider override       (default: from container)
//   AI_MEMORY_LLM_BASE_URL  openai-compat base URL  (default: from container)
//   AI_MEMORY_LLM_MODEL     expected model          (default: from container)
//   CLAUDE_CONFIG_DIR       Claude Code config root (default: ~/.claude)

import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const CONTAINER = process.env.AI_MEMORY_CONTAINER || 'ai-memory';
const REPO = process.env.AI_MEMORY_REPO || process.cwd();
// Kept in lockstep with AI_MEMORY_VERSION in setup-ai-memory.mjs.
const IMAGE = process.env.AI_MEMORY_IMAGE || 'akitaonrails/ai-memory:2.0.2';

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const CLAUDE_SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const GLOBAL_SKILLS_DIR = path.join(CLAUDE_DIR, 'skills');
const PROJECT_SKILLS_DIR = path.join(REPO, '.claude', 'skills');

// Both hook forms ai-memory stages — a vendored shell script and the CLI's own
// `hook` subcommand — carry the product name in the command string.
const HOOK_COMMAND_HINT = 'ai-memory';
const HOOK_SCRIPT_PATTERN = /\S*ai-memory\S*\.sh/;

// Every managed skill carries this marker; an unmanaged skill of the same name
// does not, which is how ai-memory itself decides what it may overwrite.
const MANAGED_SKILL_MARKER = 'ai-memory-managed';
const SKILL_FILE = 'SKILL.md';

const VERSION_PATTERN = /\d+\.\d+\.\d+/;

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

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_INCOMPLETE = 2;

const jsonMode = process.argv.includes('--json');
const results = [];

// SKIP    — the check does not apply to this install (nothing to verify).
// BLOCKED — the check applies but a prerequisite was missing, so it could not
//           run. Never counted as success; see the exit codes above.
function record(name, status, detail) {
  results.push({ name, status, detail });
  if (!jsonMode) {
    const icon = { PASS: '✓', WARN: '!', FAIL: '✗', SKIP: '–', BLOCKED: '?' }[status] || '?';
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
  if (provider === 'anthropic' || provider === 'anthropic-oauth' || provider === 'openai-oauth') return 'remote-api';
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
  let health;
  try {
    health = await getJson(`${url.origin}/healthz`);
  } catch (e) {
    return reportShimFailure(url, config, `is unreachable (${e.message})`);
  }
  if (!health?.ok) return reportShimFailure(url, config, 'did not report ok');

  record('LLM backend', 'PASS', `claude -p shim up at ${url.origin} (backend: ${health.backend})`);
  if (config.model && health.model && health.model !== config.model) {
    record('LLM model', 'WARN', `server asks for ${config.model}, shim defaults to ${health.model}`);
  } else {
    record('LLM model', 'PASS', config.model || health.model || '(shim default)');
  }
}

// A non-Ollama openai-compat base URL is this harness's shim by convention, but
// it can also be a third-party server (LM Studio and friends) with no /healthz.
// Probe the endpoint the ai-memory server itself uses before blaming the shim.
async function reportShimFailure(url, config, healthzProblem) {
  const modelsUrl = `${url.origin}${url.pathname.replace(/\/$/, '')}/models`;
  try {
    await getJson(modelsUrl);
    record(
      'LLM backend',
      'WARN',
      `${modelsUrl} answers but ${url.origin}/healthz ${healthzProblem} — an openai-compat backend other than this harness's shim`,
    );
    record('LLM model', 'SKIP', `${config.model || 'model'} not checked against an unknown backend`);
  } catch {
    record(
      'LLM backend',
      'FAIL',
      `${url.origin}/healthz ${healthzProblem} — check the LaunchAgent: ` +
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
        'BLOCKED',
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
  if (!have('docker')) {
    record('Docker', 'BLOCKED', 'docker not found — cannot inspect the server container');
    return false;
  }
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
  else return record('ai-memory status', 'BLOCKED', 'neither the ai-memory wrapper nor docker is available');

  if (!r.ok) return record('ai-memory status', 'FAIL', (r.stderr || r.stdout || `exit ${r.code}`).split('\n')[0]);
  let parsed;
  // The wrapper prefixes a startup log line before the JSON (measured 2.0.2).
  try { parsed = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))); } catch { /* not JSON */ }
  record('ai-memory status', 'PASS', 'server responded');

  const blob = (r.stdout || '').toLowerCase();
  const expected = config.provider;
  const reported = parsed?.llm?.provider ?? parsed?.providers?.llm?.provider;
  if (!expected) {
    record('LLM provider', 'SKIP', `status reports "${reported || '(not in output)'}" — nothing detected to compare against`);
  } else if (reported === expected || blob.includes(expected.toLowerCase())) {
    record('LLM provider', 'PASS', `${expected} — as configured on the container`);
  } else {
    record('LLM provider', 'WARN', `status reports "${reported || '(not in output)'}" but the container is configured for "${expected}"`);
  }
  const sick = unhealthyProviders(parsed?.providers);
  if (sick === null) {
    // No structured provider block — fall back to the textual heuristic.
    if (blob.includes('unhealthy') || blob.includes('error')) {
      record('Provider health', 'WARN', 'status text mentions unhealthy/error — inspect `ai-memory status`');
    }
  } else if (sick.length > 0) {
    record('Provider health', 'WARN', sick.join('; '));
  } else {
    record('Provider health', 'PASS', Object.entries(parsed.providers).map(([n, p]) => `${n} ${p?.status}`).join(', '));
  }
}

// `status` keys like last_error_at exist even when null, so grepping the JSON
// for "error" flags a healthy server. Only a recorded error message or an
// explicitly bad status counts; "unknown" just means no call was made yet.
export function unhealthyProviders(providers) {
  if (!providers || typeof providers !== 'object') return null;
  return Object.entries(providers)
    .filter(([, p]) => p?.last_error_message || p?.status === 'unhealthy' || p?.status === 'error')
    .map(([name, p]) => `${name}: ${p.status}${p.last_error_message ? ` (${p.last_error_message})` : ''}`);
}

// bootstrap --dry-run proves the LLM provider is actually reachable from the server
function checkBootstrapDryRun() {
  let r;
  if (have('ai-memory')) r = sh('ai-memory', ['bootstrap', '--dry-run'], { cwd: REPO });
  else if (have('docker')) r = sh('docker', ['exec', '-w', '/data', CONTAINER, 'ai-memory', 'bootstrap', '--dry-run']);
  else return record('bootstrap --dry-run', 'BLOCKED', 'no ai-memory CLI available');
  if (!r.ok && !r.stdout) return record('bootstrap --dry-run', 'WARN', (r.stderr || `exit ${r.code}`).split('\n')[0]);
  try {
    const j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    record('bootstrap --dry-run', 'PASS', `${j.sources_collected ?? '?'} sources, ~${j.estimated_input_tokens ?? '?'} tokens`);
  } catch {
    record('bootstrap --dry-run', 'PASS', 'ran (non-JSON output)');
  }
}

// Wiki is git-versioned (proves capture is being committed). The container
// ships libgit2 only — no git CLI (measured 2026-09-04, image 2.0.2) — so the
// history cannot be read with `docker exec git`. What can be read is the one
// failure mode measured in 2026-08: commits dying silently on zero-size loose
// objects while reads keep working. Absence of that signature is the check.
export function wikiFreezeSignature(zeroSizeObjects, parseErrors) {
  return zeroSizeObjects > 0 || parseErrors > 0 ? 'frozen' : 'ok';
}

function checkWikiGit() {
  if (!have('docker')) return record('Wiki git history', 'BLOCKED', 'docker not available');
  const head = sh('docker', ['exec', CONTAINER, 'sh', '-c', 'test -f /data/wiki/.git/HEAD']);
  if (!head.ok) {
    return record('Wiki git history', 'WARN', 'no git repo at /data/wiki yet — capture a session first');
  }
  const zero = sh('docker', [
    'exec', CONTAINER, 'sh', '-c', 'find /data/wiki/.git/objects -type f -size 0 | wc -l',
  ]);
  const zeroCount = Number(zero.stdout) || 0;
  const logs = sh('docker', ['logs', CONTAINER]);
  const parseErrors = ((logs.stdout + logs.stderr).match(/failed to parse loose object/g) || []).length;
  if (wikiFreezeSignature(zeroCount, parseErrors) === 'frozen') {
    return record(
      'Wiki git history',
      'FAIL',
      `${zeroCount} zero-size loose object(s), ${parseErrors} libgit2 parse error(s) — ` +
        'the silent wiki git freeze; back up first, then repair (docs/integrations/ai-memory.md)',
    );
  }
  record('Wiki git history', 'PASS', 'repo present, no freeze signature');
}

// The version the server actually serves, plus whether it is still the image
// the tag points at. `ai-memory upgrade` pulls a new image but leaves the
// running container alone, so an upgrade takes effect only after a recreate.
function checkVersion() {
  const running = sh('docker', ['exec', CONTAINER, 'ai-memory', '--version']);
  const version = running.stdout.match(VERSION_PATTERN)?.[0];
  if (!version) {
    const why = (running.stderr || running.stdout || `exit ${running.code}`).split('\n')[0];
    return record('ai-memory version', 'FAIL', `container "${CONTAINER}" reported no version (${why})`);
  }
  const inUse = sh('docker', ['inspect', '-f', '{{.Image}}', CONTAINER]).stdout;
  const pulled = sh('docker', ['image', 'inspect', '-f', '{{.Id}}', IMAGE]).stdout;
  if (inUse && pulled && inUse !== pulled) {
    record(
      'ai-memory version',
      'WARN',
      `server runs ${version}, from an image that is no longer ${IMAGE} — ` +
        `\`ai-memory upgrade\` pulls without recreating the container: ` +
        `docker rm -f ${CONTAINER} && node scripts/setup-ai-memory.mjs`,
    );
    return version;
  }
  record('ai-memory version', 'PASS', `${version} (${IMAGE})`);
  return version;
}

// The wrapper's `run` subcommand executes a separate native client that
// self-updates daily from the latest GitHub release, independently of the
// container — so "which version am I on" has two answers that can drift apart.
// A mixed major is unsupported upstream (a pre-2.0 binary refuses a migrated
// data dir), which makes it a failure here rather than at the next `run`.
export function versionSkew(containerRaw, nativeRaw) {
  const container = containerRaw?.match(VERSION_PATTERN)?.[0] ?? null;
  const native = nativeRaw?.match(VERSION_PATTERN)?.[0] ?? null;
  const skew = !container || !native
    ? null
    : container === native
      ? 'match'
      : container.split('.')[0] === native.split('.')[0]
        ? 'drift'
        : 'major';
  return { skew, container, native };
}

function checkNativeRunner(containerVersion) {
  const bin = process.env.AI_MEMORY_NATIVE_BIN
    || path.join(os.homedir(), '.cache', 'ai-memory', 'native-runner', 'ai-memory');
  if (!existsSync(bin)) {
    return record('Native runner version', 'SKIP', 'no native run client installed');
  }
  const { skew, container, native } = versionSkew(containerVersion, sh(bin, ['--version']).stdout);
  const pair = `container ${container ?? '?'}, runner ${native ?? '?'}`;
  if (skew === null) {
    return record('Native runner version', 'WARN', `could not compare versions (${pair})`);
  }
  if (skew === 'major') {
    return record(
      'Native runner version',
      'FAIL',
      `${pair} — mixed majors are unsupported; upgrade both together or pin AI_MEMORY_NATIVE_BIN`,
    );
  }
  if (skew === 'drift') {
    return record('Native runner version', 'WARN', `${pair} — same major, drifting apart`);
  }
  record('Native runner version', 'PASS', pair);
}

function isExecutable(file) {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function collectAiMemoryHooks(settings) {
  const events = new Set();
  const broken = [];
  for (const [event, matchers] of Object.entries(settings.hooks ?? {})) {
    for (const matcher of matchers) {
      for (const hook of matcher.hooks ?? []) {
        const command = hook.command ?? '';
        if (!command.includes(HOOK_COMMAND_HINT)) continue;
        events.add(event);
        const script = command.match(HOOK_SCRIPT_PATTERN)?.[0];
        if (script && !isExecutable(script)) broken.push(script);
      }
    }
  }
  return { events: [...events].sort(), broken };
}

// Capture lives or dies with these: no hook entry means nothing reaches the
// server, however healthy the server is.
function checkStagedHooks() {
  if (!existsSync(CLAUDE_SETTINGS)) {
    return record('Staged hooks', 'BLOCKED', `no agent settings at ${CLAUDE_SETTINGS} — hook wiring NOT verified`);
  }
  let found;
  try {
    found = collectAiMemoryHooks(JSON.parse(readFileSync(CLAUDE_SETTINGS, 'utf8')));
  } catch (e) {
    return record('Staged hooks', 'FAIL', `could not read hook wiring from ${CLAUDE_SETTINGS} (${e.message})`);
  }
  if (found.events.length === 0) {
    return record(
      'Staged hooks',
      'FAIL',
      `no ai-memory hook in ${CLAUDE_SETTINGS} — nothing is captured. ` +
        'Run: ai-memory install-hooks --agent claude-code --apply',
    );
  }
  if (found.broken.length > 0) {
    return record(
      'Staged hooks',
      'FAIL',
      `staged but missing or not executable: ${found.broken.join(', ')} — re-stage with \`ai-memory upgrade\``,
    );
  }
  record('Staged hooks', 'PASS', found.events.join(', '));
}

function managedSkillNames(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((name) => readSkill(path.join(dir, name)).includes(MANAGED_SKILL_MARKER)).sort();
}

function readSkill(skillDir) {
  try {
    return readFileSync(path.join(skillDir, SKILL_FILE), 'utf8');
  } catch {
    return '';
  }
}

// Since 1.18.0 `install-instructions` also writes Agent Skills, and its default
// scope is the project — i.e. the repo's own .claude/skills, a directory the
// harness installer owns one entry at a time. The harness asks for `global`.
function checkManagedSkills() {
  const projectScoped = managedSkillNames(PROJECT_SKILLS_DIR);
  if (projectScoped.length > 0) {
    return record(
      'Managed skills',
      'FAIL',
      `${projectScoped.join(', ')} landed in ${PROJECT_SKILLS_DIR}, which belongs to the harness — ` +
        'delete them and re-run: ai-memory install-instructions --skills-scope global',
    );
  }
  const globalScoped = managedSkillNames(GLOBAL_SKILLS_DIR);
  if (globalScoped.length === 0) {
    return record(
      'Managed skills',
      'FAIL',
      `none in ${GLOBAL_SKILLS_DIR} — run: ai-memory install-skills --scope global`,
    );
  }
  record('Managed skills', 'PASS', `${globalScoped.length} in ${GLOBAL_SKILLS_DIR}`);
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
  if (up) {
    checkNativeRunner(checkVersion());
    checkStatus(config);
    checkBootstrapDryRun();
    checkWikiGit();
  } else {
    record(
      'Server-side checks',
      'BLOCKED',
      'no running container — version, status, bootstrap reachability and wiki git history were not checked',
    );
  }
  checkStagedHooks();
  checkManagedSkills();

  const fails = results.filter((r) => r.status === 'FAIL').length;
  const warns = results.filter((r) => r.status === 'WARN').length;
  const blocked = results.filter((r) => r.status === 'BLOCKED');
  const ok = fails === 0 && blocked.length === 0;

  if (jsonMode) {
    console.log(JSON.stringify({ ok, fails, warns, blocked: blocked.length, results }, null, 2));
  } else {
    let summary;
    if (fails > 0) summary = `✗ ${fails} failed`;
    else if (blocked.length > 0) {
      summary = `? incomplete — not verified: ${blocked.map((r) => r.name).join(', ')}`;
    } else summary = '✓ all critical checks passed';
    console.log(`\n${summary}${warns ? `, ${warns} warning(s)` : ''}`);
  }

  if (fails > 0) process.exit(EXIT_FAILED);
  process.exit(ok ? EXIT_OK : EXIT_INCOMPLETE);
}

// Importable for the versionSkew unit tests; runs only as a CLI entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
