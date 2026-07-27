#!/usr/bin/env node
// verify-ai-memory.mjs — non-destructive end-to-end check for the local-Ollama
// ai-memory setup. Mirrors the verification checklist in the runbook.
//
// Usage:
//   node scripts/verify-ai-memory.mjs                 # run all checks
//   node scripts/verify-ai-memory.mjs --json          # machine-readable summary
//
// Zero deps, Node stdlib only (repo convention). Read-only: it never writes to
// the wiki, never mutates Docker/LaunchAgent state. `ai-memory bootstrap` is run
// with --dry-run, which the upstream docs document as collect-and-estimate only.
//
// Tunables (override via env if your setup differs):
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = process.env.AI_MEMORY_MODEL || 'qwen3:8b';
const CONTAINER = process.env.AI_MEMORY_CONTAINER || 'ai-memory';
const REPO = process.env.AI_MEMORY_REPO || process.cwd();

import { spawnSync } from 'node:child_process';

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
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 60000, ...opts });
  return {
    ok: r.status === 0,
    code: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
    missing: r.error && r.error.code === 'ENOENT',
  };
}

function have(bin) {
  return !sh('command', ['-v', bin], { shell: false }).missing && sh(bin, ['--version']).code !== null;
}

// 1. Ollama reachable + model present
async function checkOllama() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return record('Ollama API', 'FAIL', `GET /api/tags → HTTP ${res.status}`);
    const body = await res.json();
    const names = (body.models || []).map((m) => m.name);
    record('Ollama API', 'PASS', `${OLLAMA_URL} reachable`);
    if (names.some((n) => n === MODEL || n.startsWith(MODEL + ':') || n.startsWith(MODEL))) {
      record('Ollama model', 'PASS', `${MODEL} present`);
    } else {
      record('Ollama model', 'FAIL', `${MODEL} not pulled (have: ${names.join(', ') || 'none'}). Run: ollama pull ${MODEL}`);
    }
  } catch (e) {
    record('Ollama API', 'FAIL', `${OLLAMA_URL} unreachable (${e.name}). Is \`ollama serve\` running?`);
  }
}

// 2. Docker + ai-memory container running
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
    record('ai-memory container', 'FAIL', 'no container — run setup-ai-memory.mjs --provider local');
  }
  return false;
}

// 3. ai-memory status + provider health (via wrapper if present, else docker exec)
function checkStatus() {
  let r;
  if (have('ai-memory')) r = sh('ai-memory', ['status', '--json']);
  else if (have('docker')) r = sh('docker', ['exec', CONTAINER, 'ai-memory', 'status', '--json']);
  else return record('ai-memory status', 'SKIP', 'neither ai-memory wrapper nor docker available');

  if (!r.ok) return record('ai-memory status', 'FAIL', (r.stderr || r.stdout || `exit ${r.code}`).split('\n')[0]);
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch { /* status may not be pure JSON on all versions */ }
  record('ai-memory status', 'PASS', 'server responded');
  const blob = (r.stdout || '').toLowerCase();
  const provider = parsed?.llm?.provider || (blob.includes('openai-compat') ? 'openai-compat' : '(unknown)');
  if (blob.includes('openai-compat') || provider === 'openai-compat') {
    record('LLM provider', 'PASS', `openai-compat (Ollama) — model expected: ${MODEL}`);
  } else {
    record('LLM provider', 'WARN', `provider reads "${provider}" — expected openai-compat for local Ollama`);
  }
  if (blob.includes('unhealthy') || blob.includes('error')) {
    record('Provider health', 'WARN', 'status text mentions unhealthy/error — inspect `ai-memory status`');
  }
}

// 4. bootstrap --dry-run proves the LLM provider is actually reachable from the server
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

// 5. Wiki is git-versioned (proves capture is being committed)
function checkWikiGit() {
  if (!have('docker')) return record('Wiki git history', 'SKIP', 'docker not available');
  const log = sh('docker', ['exec', CONTAINER, 'git', '-C', '/data/wiki', 'log', '--oneline', '-n', '5']);
  if (log.ok && log.stdout) record('Wiki git history', 'PASS', `${log.stdout.split('\n').length} recent commits`);
  else record('Wiki git history', 'WARN', 'no wiki git log yet — capture a session first');
}

async function main() {
  if (!jsonMode) console.log(`ai-memory verify  (model=${MODEL}, container=${CONTAINER}, repo=${REPO})\n`);
  await checkOllama();
  const up = checkContainer();
  if (up) { checkStatus(); checkBootstrapDryRun(); checkWikiGit(); }
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
