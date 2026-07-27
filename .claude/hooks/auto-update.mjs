#!/usr/bin/env node
// SessionStart hook: keep the harness checkout fresh.
//
// On `startup`, `resume`, and `clear`, this hook:
//   1. Resolves the harness root via the script's realpath (works under symlinks).
//   2. Throttles to at most one check every 6 hours, using a per-user cache file.
//   3. Verifies the harness is a git checkout on `main` with a clean tree.
//   4. `git fetch origin main`, fast-forwards if behind, prints a one-line summary.
//   5. If the applied diff touched the installer's inputs (skills or
//      settings.json), suggests re-running the installer. It never runs it.
//
// The hook never blocks a session — every failure path exits 0. Network/git
// problems print a one-line stderr warning at most. The pre-fetch timestamp
// touch ensures flaky networks only retry once per 6h, not on every session.
//
// Git runs non-interactively: a missing credential or an unknown host key fails
// fast instead of hanging the session on a prompt.
//
// macOS/Linux only. Cache file lives at:
//   - macOS: ~/Library/Caches/claude-setup/last-check
//   - Linux: ${XDG_CACHE_HOME:-~/.cache}/claude-setup/last-check
//
// Opt out by exporting CLAUDE_SETUP_SKIP_AUTOUPDATE=1. Also auto-skips when
// the CI env var is set.
//
// Requires Node.js 24+.

import process from 'node:process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const GIT_TIMEOUT_MS = 10_000;
const GIT_VERSION_TIMEOUT_MS = 5_000;

// A credential or host-key prompt inside a SessionStart hook hangs the whole
// session with no visible prompt, so force git to fail instead of asking.
const NON_INTERACTIVE_GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: 'ssh -oBatchMode=yes',
};

// Paths whose contents only reach ~/.claude through scripts/install.mjs.
const INSTALLER_MANAGED_PATHS = ['.claude/skills/', '.claude/settings.json'];

function softWarn(msg) {
  process.stderr.write(`claude-setup: ${msg}\n`);
}

function git(...args) {
  return spawnSync('git', args, {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    env: NON_INTERACTIVE_GIT_ENV,
  });
}

function resolveCacheDir() {
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg) return path.join(xdg, 'claude-setup');
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'claude-setup');
  }
  return path.join(os.homedir(), '.cache', 'claude-setup');
}

function lockIsHeld(lockFile) {
  let pid;
  try {
    pid = Number(readFileSync(lockFile, 'utf8').trim());
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // The holder exists but belongs to another user — still a live lock.
    return err.code === 'EPERM';
  }
}

// A SIGKILLed hook never runs its cleanup, so the lock outlives its holder and
// would disable auto-update forever. Break it only once the holder is gone.
function acquireLock(lockFile) {
  try {
    writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  if (lockIsHeld(lockFile)) return false;
  try {
    unlinkSync(lockFile);
    writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    // Another session broke the same stale lock first; let it do the work.
    return false;
  }
}

function touchesInstallerInputs(harnessDir, oldSha, newSha) {
  const res = git('-C', harnessDir, 'diff', '--name-only', `${oldSha}..${newSha}`);
  if (res.status !== 0) return false;
  return res.stdout
    .split('\n')
    .some((file) => INSTALLER_MANAGED_PATHS.some((managed) => file.startsWith(managed)));
}

async function main() {
  if (process.env.CLAUDE_SETUP_SKIP_AUTOUPDATE === '1') return;
  if (process.env.CI) return;

  const args = process.argv.slice(2);
  const force = args.includes('--force') || args.includes('-f');

  const selfReal = await fs.realpath(fileURLToPath(import.meta.url));
  const harnessDir = path.resolve(selfReal, '..', '..', '..');

  const cacheDir = resolveCacheDir();
  const cacheFile = path.join(cacheDir, 'last-check');
  const lockFile = path.join(cacheDir, 'last-check.lock');
  await fs.mkdir(cacheDir, { recursive: true });

  let last = 0;
  try {
    last = Number(readFileSync(cacheFile, 'utf8')) || 0;
  } catch {
    last = 0;
  }
  if (!force && Date.now() - last < SIX_HOURS_MS) return;

  if (!existsSync(path.join(harnessDir, '.git'))) return;

  const versionRes = spawnSync('git', ['--version'], {
    encoding: 'utf8',
    timeout: GIT_VERSION_TIMEOUT_MS,
    env: NON_INTERACTIVE_GIT_ENV,
  });
  if (versionRes.status !== 0) {
    softWarn('git not found on PATH');
    return;
  }

  const branchRes = git('-C', harnessDir, 'rev-parse', '--abbrev-ref', 'HEAD');
  const branch = (branchRes.stdout || '').trim();
  if (branch !== 'main') {
    if (force) {
      process.stdout.write(
        `claude-setup: harness on branch '${branch}', not 'main' — skipping\n`
      );
    }
    return;
  }

  if (!acquireLock(lockFile)) return;

  const cleanupLock = () => {
    try {
      unlinkSync(lockFile);
    } catch {
      // best-effort
    }
  };
  process.on('exit', cleanupLock);

  try {
    // Touch the throttle BEFORE the fetch so a flaky network doesn't make every
    // session for the next 6h retry. Skipped under --force: if the user invoked
    // /sync-harness explicitly, a failure here shouldn't gate the normal
    // SessionStart hook for the next 6h.
    if (!force) writeFileSync(cacheFile, String(Date.now()));

    const fetchRes = git('-C', harnessDir, 'fetch', '--quiet', 'origin', 'main');
    if (fetchRes.status !== 0) {
      softWarn('claude-setup auto-update: fetch failed (offline?)');
      return;
    }

    const oldSha = git('-C', harnessDir, 'rev-parse', 'HEAD').stdout.trim();
    const newSha = git('-C', harnessDir, 'rev-parse', 'origin/main').stdout.trim();
    // Differing shas are not enough: with unpushed local commits the tree is
    // ahead, --ff-only no-ops, and reporting an "update" would be a lie.
    const incomingCount = Number(
      git('-C', harnessDir, 'rev-list', '--count', `${oldSha}..${newSha}`).stdout.trim()
    );
    if (!incomingCount) {
      if (force) {
        process.stdout.write(
          `claude-setup: already up-to-date (${oldSha.slice(0, 7)})\n`
        );
      }
      return;
    }

    const dirty =
      git('-C', harnessDir, 'status', '--porcelain').stdout.trim() !== '';
    if (dirty) {
      process.stderr.write(
        'claude-setup: harness has uncommitted changes; skipping auto-update — pull manually\n'
      );
      return;
    }

    const pullRes = git(
      '-C',
      harnessDir,
      'pull',
      '--ff-only',
      '--quiet',
      'origin',
      'main'
    );
    if (pullRes.status !== 0) {
      softWarn('claude-setup auto-update: ff-only pull failed');
      return;
    }

    process.stdout.write(
      `claude-setup updated: ${oldSha.slice(0, 7)}..${newSha.slice(0, 7)} (${incomingCount} commits)\n`
    );

    if (touchesInstallerInputs(harnessDir, oldSha, newSha)) {
      process.stdout.write(
        `claude-setup: update touched skills/settings — run 'node ${path.join(harnessDir, 'scripts', 'install.mjs')}' to apply\n`
      );
    }
  } finally {
    cleanupLock();
  }
}

try {
  await main();
} catch (err) {
  softWarn(`auto-update error: ${err.message}`);
}
process.exit(0);
