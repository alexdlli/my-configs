// Drives the hook script itself, as a process, the way Claude Code runs it.
// The lib tests next door prove the classification; this one proves the wiring
// that turns a verdict into a permission decision — including the one decision
// that GRANTS rather than refuses, which no unit test can observe.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../guard-destructive.mjs', import.meta.url));

let root;
let integ;
let repo;
let worker;

function worktree(name, head) {
  const gitDir = path.join(root, 'repo', '.git', 'worktrees', name);
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(path.join(gitDir, 'HEAD'), head);
  const tree = path.join(root, name);
  mkdirSync(tree, { recursive: true });
  writeFileSync(path.join(tree, '.git'), `gitdir: ${gitDir}\n`);
  return tree;
}

before(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'guard-hook-'));
  repo = path.join(root, 'repo');
  mkdirSync(path.join(repo, '.git'), { recursive: true });
  writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');

  integ = worktree('integ', 'ref: refs/heads/integration/harness-cleanup\n');
  worktree('feature', 'ref: refs/heads/feature/login\n');

  worker = worktree('w3', 'ref: refs/heads/wave/3\n');
  mkdirSync(path.join(worker, '.wave'), { recursive: true });
  writeFileSync(path.join(worker, '.wave', 'worker.json'), JSON.stringify({ ticket: '3' }));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

// `null` means the hook printed nothing: no decision, so the command falls
// through to the permission layer. That silence is a real outcome here, not an
// error, and it is how "ask Alex" is expressed.
function runHook(command, cwd) {
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, CLAUDE_SETUP_SKIP_GUARD_DESTRUCTIVE: '0' },
  });
  assert.equal(result.status, 0, 'the hook always exits 0, even when it denies');
  if (result.stdout.trim() === '') return null;
  return JSON.parse(result.stdout).hookSpecificOutput;
}

test('merging into a control branch is granted outright, not merely allowed to prompt', () => {
  const decision = runHook('git merge feat/opencode-harness', integ);
  assert.equal(decision.permissionDecision, 'allow');
  assert.match(decision.permissionDecisionReason, /control branch/);
});

test('merging into a protected branch is denied and says where to go instead', () => {
  const decision = runHook('git merge feat/opencode-harness', repo);
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(decision.permissionDecisionReason, /git merge/);
  assert.match(decision.permissionDecisionReason, /integration\/\*/);
});

test('the wrapped merge into a protected branch is denied too', () => {
  const decision = runHook('bash -c "git merge main"', repo);
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(decision.permissionDecisionReason, /wrapped in a shell/);
});

test('merging on a branch that is on neither list falls through to the prompt', () => {
  assert.equal(runHook('git merge main', path.join(root, 'feature')), null);
});

test('a merge pointed at another repository is refused as unverifiable', () => {
  const decision = runHook('git -C /elsewhere merge main', integ);
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(decision.permissionDecisionReason, /another repository/);
});

test('finishing a merge in progress is never blocked, on any branch', () => {
  assert.equal(runHook('git merge --abort', repo), null);
  assert.equal(runHook('git merge --continue', repo), null);
});

// The whole point of granting git merge is that it did NOT grant gh pr merge.
// A control branch changes nothing for it: its destination is the PR's base on
// GitHub, which this hook never reads.
test('gh pr merge is untouched by the control-branch allowance', () => {
  assert.equal(runHook('gh pr merge 16', integ), null, 'non-worker still reaches the prompt');
  const fromWorker = runHook('gh pr merge 16', worker);
  assert.equal(fromWorker.permissionDecision, 'deny');
  assert.match(fromWorker.permissionDecisionReason, /wave worker never merges/);
});

test('force-push and --no-verify stay denied on a control branch', () => {
  for (const command of ['git push --force origin main', 'git commit --no-verify -m wip']) {
    assert.equal(runHook(command, integ).permissionDecision, 'deny', command);
  }
});

test('a harmless command produces no decision at all', () => {
  assert.equal(runHook('git status --porcelain', integ), null);
  assert.equal(runHook('git merge-base main HEAD', repo), null);
});

test('the opt-out silences the hook entirely', () => {
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git merge main' }, cwd: repo }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo, CLAUDE_SETUP_SKIP_GUARD_DESTRUCTIVE: '1' },
  });
  assert.equal(result.stdout.trim(), '');
});
