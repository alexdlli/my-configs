import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CONTEXT_INDETERMINATE,
  CONTEXT_OTHER,
  CONTEXT_WORKER,
  PROJECT_DIR_VAR,
  WORKER_MARKER_PATH,
  detectWorkerContext,
} from './worker-context.mjs';

let root;

// One tree, shaped like a real dispatch: a repo checkout with a worker worktree
// nested inside it, which is where Orca puts them.
//
//   root/repo/.git/                    main checkout
//   root/repo/docs/
//   root/repo/w1-issue-3/.git          linked worktree, marker present
//   root/repo/w1-issue-3/scripts/
//   root/repo/w1-issue-9/.git          linked worktree, marker is not JSON
//   root/loose/                        no repo anywhere above it
before(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'worker-context-'));

  mkdirSync(path.join(root, 'repo', '.git'), { recursive: true });
  mkdirSync(path.join(root, 'repo', 'docs'), { recursive: true });

  const worker = path.join(root, 'repo', 'w1-issue-3');
  mkdirSync(path.join(worker, '.wave'), { recursive: true });
  mkdirSync(path.join(worker, 'scripts'), { recursive: true });
  writeFileSync(path.join(worker, '.git'), 'gitdir: /elsewhere/.git/worktrees/w1-issue-3\n');
  writeFileSync(
    path.join(worker, WORKER_MARKER_PATH),
    JSON.stringify({ ticket: '3', branch: 'wave/3', createdAt: '2026-07-27T00:00:00Z' }),
  );

  const broken = path.join(root, 'repo', 'w1-issue-9');
  mkdirSync(path.join(broken, '.wave'), { recursive: true });
  writeFileSync(path.join(broken, '.git'), 'gitdir: /elsewhere/.git/worktrees/w1-issue-9\n');
  writeFileSync(path.join(broken, WORKER_MARKER_PATH), '{"ticket": "9"');

  mkdirSync(path.join(root, 'loose'), { recursive: true });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function repo(...parts) {
  return path.join(root, 'repo', ...parts);
}

test('a worktree carrying the marker is a worker', () => {
  const worker = repo('w1-issue-3');
  assert.equal(detectWorkerContext({ [PROJECT_DIR_VAR]: worker }, worker), CONTEXT_WORKER);
});

test('the marker is found from a subdirectory of the worktree', () => {
  const worker = repo('w1-issue-3');
  const deep = repo('w1-issue-3', 'scripts');
  assert.equal(detectWorkerContext({ [PROJECT_DIR_VAR]: worker }, deep), CONTEXT_WORKER);
});

test('the coordinator checkout that holds the worktrees is not a worker', () => {
  assert.equal(detectWorkerContext({ [PROJECT_DIR_VAR]: repo() }, repo()), CONTEXT_OTHER);
  assert.equal(detectWorkerContext({ [PROJECT_DIR_VAR]: repo() }, repo('docs')), CONTEXT_OTHER);
});

// The measured escape: the payload cwd follows `cd`, so a worker that steps out
// of its worktree reports the parent checkout. CLAUDE_PROJECT_DIR does not move,
// and it is why the answer stays "worker".
test('a worker that has cd-ed out of its worktree is still a worker', () => {
  const env = { [PROJECT_DIR_VAR]: repo('w1-issue-3') };
  assert.equal(detectWorkerContext(env, repo()), CONTEXT_WORKER);
  assert.equal(detectWorkerContext(env, os.tmpdir()), CONTEXT_WORKER);
});

test('either anchor alone is enough to see the marker', () => {
  const worker = repo('w1-issue-3');
  assert.equal(detectWorkerContext({}, worker), CONTEXT_WORKER);
  assert.equal(detectWorkerContext({ [PROJECT_DIR_VAR]: worker }, undefined), CONTEXT_WORKER);
});

test('the walk stops at the repo root and does not leak into its parent', () => {
  mkdirSync(path.join(root, '.wave'), { recursive: true });
  writeFileSync(path.join(root, WORKER_MARKER_PATH), JSON.stringify({ ticket: 'stray' }));
  try {
    assert.equal(detectWorkerContext({ [PROJECT_DIR_VAR]: repo() }, repo('docs')), CONTEXT_OTHER);
  } finally {
    rmSync(path.join(root, '.wave'), { recursive: true, force: true });
  }
});

test('a directory outside any repo is searched to the file system root', () => {
  const loose = path.join(root, 'loose');
  assert.equal(detectWorkerContext({ [PROJECT_DIR_VAR]: loose }, loose), CONTEXT_OTHER);
});

test('no usable anchor is undetermined, never "other"', () => {
  assert.equal(detectWorkerContext({}, undefined), CONTEXT_INDETERMINATE);
  assert.equal(detectWorkerContext({}, ''), CONTEXT_INDETERMINATE);
  assert.equal(detectWorkerContext({ [PROJECT_DIR_VAR]: '   ' }, null), CONTEXT_INDETERMINATE);
  assert.equal(detectWorkerContext(undefined, undefined), CONTEXT_INDETERMINATE);
  assert.equal(detectWorkerContext({ [PROJECT_DIR_VAR]: 42 }, 42), CONTEXT_INDETERMINATE);
});

test('a marker that is not JSON is undetermined, never "other"', () => {
  const broken = repo('w1-issue-9');
  assert.equal(detectWorkerContext({ [PROJECT_DIR_VAR]: broken }, broken), CONTEXT_INDETERMINATE);
});

test('an empty marker is a half-written marker, not the absence of one', () => {
  const empty = repo('w1-issue-empty');
  mkdirSync(path.join(empty, '.wave'), { recursive: true });
  writeFileSync(path.join(empty, WORKER_MARKER_PATH), '');
  try {
    assert.equal(detectWorkerContext({ [PROJECT_DIR_VAR]: empty }, empty), CONTEXT_INDETERMINATE);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('a marker the process cannot read is undetermined', { skip: process.getuid?.() === 0 }, () => {
  const locked = repo('w1-issue-locked');
  const markerPath = path.join(locked, WORKER_MARKER_PATH);
  mkdirSync(path.join(locked, '.wave'), { recursive: true });
  writeFileSync(markerPath, JSON.stringify({ ticket: 'locked' }));
  chmodSync(markerPath, 0o000);
  try {
    assert.equal(detectWorkerContext({ [PROJECT_DIR_VAR]: locked }, locked), CONTEXT_INDETERMINATE);
  } finally {
    chmodSync(markerPath, 0o600);
    rmSync(locked, { recursive: true, force: true });
  }
});

test('one undetermined anchor poisons an otherwise clean verdict', () => {
  const env = { [PROJECT_DIR_VAR]: repo('w1-issue-9') };
  assert.equal(detectWorkerContext(env, repo()), CONTEXT_INDETERMINATE);
});

test('a worker verdict beats an undetermined one', () => {
  const env = { [PROJECT_DIR_VAR]: repo('w1-issue-3') };
  assert.equal(detectWorkerContext(env, repo('w1-issue-9')), CONTEXT_WORKER);
});
