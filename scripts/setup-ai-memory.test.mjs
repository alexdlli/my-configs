import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETUP = path.join(__dirname, 'setup-ai-memory.mjs');

// Runs the real script as a child against a throwaway HOME, with a stub
// `ai-memory` first in PATH. The stub exits non-zero only for the subcommands
// listed in failOn; every other invocation succeeds. `--provider none
// --no-server` keeps docker, curl and the shim out of the path under test, and
// a pre-created wrapper file short-circuits the download.
function runSetup({ failOn = [] } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'setup-ai-memory-test-'));
  try {
    const home = path.join(root, 'home');
    const stubBin = path.join(root, 'bin');
    mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    writeFileSync(path.join(home, '.local', 'bin', 'ai-memory'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    mkdirSync(stubBin, { recursive: true });
    const failCase = failOn.map((sub) => `[ "$1" = "${sub}" ] && exit 1`).join('\n');
    writeFileSync(path.join(stubBin, 'ai-memory'), `#!/bin/sh\n${failCase}\nexit 0\n`, { mode: 0o755 });
    return spawnSync(process.execPath, [SETUP, '--provider', 'none', '--no-server'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, PATH: `${stubBin}:${process.env.PATH}` },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a clean wiring run exits 0', () => {
  const res = runSetup();
  assert.equal(res.status, 0, res.stderr);
});

test('a failing install-instructions fails the setup instead of being swallowed', () => {
  const res = runSetup({ failOn: ['install-instructions'] });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /install-instructions/);
});

test('a failing install-hooks fails the setup', () => {
  const res = runSetup({ failOn: ['install-hooks'] });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /install-hooks/);
});
