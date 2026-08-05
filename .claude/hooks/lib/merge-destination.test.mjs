import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DESTINATION_CONTROL,
  DESTINATION_INDETERMINATE,
  DESTINATION_OTHER,
  DESTINATION_PROTECTED,
  PROJECT_DIR_VAR,
  classifyBranch,
  classifyMergeDestination,
} from './merge-destination.mjs';

let root;

// One tree shaped like a real wave: a main checkout sitting on main, with
// linked worktrees beside it. A linked worktree keeps its HEAD in the main
// repo's .git/worktrees/<name>, which is the case that decides whether this
// module reads the worker's branch or the checkout it was cut from.
//
//   root/repo/.git/HEAD                          -> main
//   root/repo/.git/worktrees/integ/HEAD          -> integration/harness-cleanup
//   root/repo/.git/worktrees/w3/HEAD             -> wave/3
//   root/repo/.git/worktrees/feature/HEAD        -> feature/login
//   root/repo/.git/worktrees/detached/HEAD       -> raw sha
//   root/integ/.git                              -> gitdir pointer
//   root/loose/                                  no repo anywhere above it
function linkedWorktree(name, headContents) {
  const gitDir = path.join(root, 'repo', '.git', 'worktrees', name);
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(path.join(gitDir, 'HEAD'), headContents);
  const tree = path.join(root, name);
  mkdirSync(path.join(tree, 'scripts'), { recursive: true });
  writeFileSync(path.join(tree, '.git'), `gitdir: ${gitDir}\n`);
  return tree;
}

let integ;
let wave;
let feature;
let detached;

before(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'merge-destination-'));

  mkdirSync(path.join(root, 'repo', '.git'), { recursive: true });
  mkdirSync(path.join(root, 'repo', 'docs'), { recursive: true });
  writeFileSync(path.join(root, 'repo', '.git', 'HEAD'), 'ref: refs/heads/main\n');

  integ = linkedWorktree('integ', 'ref: refs/heads/integration/harness-cleanup\n');
  wave = linkedWorktree('w3', 'ref: refs/heads/wave/3\n');
  feature = linkedWorktree('feature', 'ref: refs/heads/feature/login\n');
  detached = linkedWorktree('detached', '9f2c1ab3d4e5f60718293a4b5c6d7e8f90a1b2c3\n');

  mkdirSync(path.join(root, 'loose'), { recursive: true });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function destination(projectDir, cwd) {
  return classifyMergeDestination({ [PROJECT_DIR_VAR]: projectDir }, cwd);
}

test('the control prefixes are what an agent may merge into', () => {
  assert.equal(classifyBranch('integration/harness-cleanup'), DESTINATION_CONTROL);
  assert.equal(classifyBranch('wave/3'), DESTINATION_CONTROL);
});

// Named one by one, never "everything not on the allowlist". A protected name
// that stops being listed is the bug this asserts against.
test('the protected branches are denied by name', () => {
  for (const branch of ['main', 'master', 'prod', 'staging']) {
    assert.equal(classifyBranch(branch), DESTINATION_PROTECTED, branch);
  }
});

test('a branch on neither list is neither granted nor refused', () => {
  assert.equal(classifyBranch('feature/login'), DESTINATION_OTHER);
  assert.equal(classifyBranch('alexdlli/lessons-loop'), DESTINATION_OTHER);
});

// A prefix must not become a way to smuggle a protected name back in.
test('the protected check runs before the prefix check', () => {
  assert.equal(classifyBranch('integration/main'), DESTINATION_CONTROL);
  assert.equal(classifyBranch('main'), DESTINATION_PROTECTED);
});

test('a linked worktree reports its own branch, not the checkout it came from', () => {
  assert.equal(destination(integ, integ), DESTINATION_CONTROL);
  assert.equal(destination(wave, wave), DESTINATION_CONTROL);
  assert.equal(destination(feature, feature), DESTINATION_OTHER);
});

test('a nested directory inside a worktree resolves to the same branch', () => {
  assert.equal(destination(integ, path.join(integ, 'scripts')), DESTINATION_CONTROL);
});

test('the main checkout on main is protected', () => {
  const repo = path.join(root, 'repo');
  assert.equal(destination(repo, repo), DESTINATION_PROTECTED);
  assert.equal(destination(repo, path.join(repo, 'docs')), DESTINATION_PROTECTED);
});

// The anchors disagree when the shell walked out of the directory the session
// opened in. The restrictive answer wins, in both directions.
test('a protected anchor beats a control anchor whichever side it is on', () => {
  const repo = path.join(root, 'repo');
  assert.equal(destination(integ, repo), DESTINATION_PROTECTED);
  assert.equal(destination(repo, integ), DESTINATION_PROTECTED);
});

test('a control branch is only granted when both anchors agree on one', () => {
  assert.equal(destination(integ, wave), DESTINATION_CONTROL);
  assert.equal(destination(integ, feature), DESTINATION_OTHER);
});

test('a detached HEAD names no branch, so the answer is that it cannot tell', () => {
  assert.equal(destination(detached, detached), DESTINATION_INDETERMINATE);
});

test('no repository and no anchor both fail closed', () => {
  const loose = path.join(root, 'loose');
  assert.equal(destination(loose, loose), DESTINATION_INDETERMINATE);
  assert.equal(classifyMergeDestination({}, undefined), DESTINATION_INDETERMINATE);
  assert.equal(classifyMergeDestination({}, '   '), DESTINATION_INDETERMINATE);
  assert.equal(classifyMergeDestination(undefined, undefined), DESTINATION_INDETERMINATE);
});

test('a gitdir pointer aimed at nothing fails closed', () => {
  const orphan = path.join(root, 'orphan');
  mkdirSync(orphan, { recursive: true });
  writeFileSync(path.join(orphan, '.git'), 'gitdir: /nowhere/.git/worktrees/gone\n');
  assert.equal(destination(orphan, orphan), DESTINATION_INDETERMINATE);
});
