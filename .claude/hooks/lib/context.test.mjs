import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DISPATCH_DRIVER_ORCA,
  HOST_MAESTRI,
  HOST_ORCA,
  HOST_PLAIN,
  detectContext,
} from './context.mjs';

const HOME = '/Users/tester';
const OUTSIDE_WORK_CWD = `${HOME}/Developer/my-configs`;
const WORK_CWD = `${HOME}/work/some-repo`;

const maestriEnv = {
  HOME,
  MAESTRI_TERMINAL_ID: 'terminal-42',
  MAESTRI_SOCKET: '/tmp/maestri-abc/maestri.sock',
  MAESTRI_CLI: '/tmp/maestri-abc/maestri',
};

const orcaEnv = {
  HOME,
  TERM_PROGRAM: 'Orca',
  ORCA_TERMINAL_HANDLE: 'term_b4d8fa36-6d78-4f2b-91d3-4c45b54f1a19',
  ORCA_WORKTREE_ID: `abc3d9a4-f9dd-48d6-97fa-2854592a57b8::${OUTSIDE_WORK_CWD}`,
};

test('detects Maestri from its per-terminal id', () => {
  const ctx = detectContext(maestriEnv, OUTSIDE_WORK_CWD);
  assert.equal(ctx.host, HOST_MAESTRI);
  assert.equal(ctx.hostDetail.terminalId, 'terminal-42');
  assert.equal(ctx.hostDetail.cliPath, '/tmp/maestri-abc/maestri');
  assert.equal(ctx.repoRoot, null);
});

test('detects Orca from the terminal handle', () => {
  const ctx = detectContext({ HOME, ORCA_TERMINAL_HANDLE: 'term_x' }, OUTSIDE_WORK_CWD);
  assert.equal(ctx.host, HOST_ORCA);
  assert.equal(ctx.hostDetail.terminalHandle, 'term_x');
});

test('detects Orca from TERM_PROGRAM alone', () => {
  const ctx = detectContext({ HOME, TERM_PROGRAM: 'Orca' }, OUTSIDE_WORK_CWD);
  assert.equal(ctx.host, HOST_ORCA);
  assert.equal(ctx.hostDetail.terminalHandle, null);
});

test('Maestri wins when both families of vars are present', () => {
  const ctx = detectContext({ ...orcaEnv, ...maestriEnv }, OUTSIDE_WORK_CWD);
  assert.equal(ctx.host, HOST_MAESTRI);
});

test('falls back to plain when no host var is set', () => {
  const ctx = detectContext({ HOME, TERM_PROGRAM: 'Apple_Terminal' }, OUTSIDE_WORK_CWD);
  assert.equal(ctx.host, HOST_PLAIN);
  assert.deepEqual(ctx.hostDetail, {});
  assert.equal(ctx.repoRoot, null);
});

test('splits ORCA_WORKTREE_ID into repo id and worktree path', () => {
  const ctx = detectContext(orcaEnv, OUTSIDE_WORK_CWD);
  assert.equal(ctx.hostDetail.repoId, 'abc3d9a4-f9dd-48d6-97fa-2854592a57b8');
  assert.equal(ctx.hostDetail.worktreePath, OUTSIDE_WORK_CWD);
  assert.equal(ctx.repoRoot, OUTSIDE_WORK_CWD);
});

test('splits ORCA_WORKTREE_ID on the first separator so paths may contain "::"', () => {
  const weirdPath = `${HOME}/Developer/we::ird`;
  const ctx = detectContext(
    { ...orcaEnv, ORCA_WORKTREE_ID: `repo-id::${weirdPath}` },
    OUTSIDE_WORK_CWD
  );
  assert.equal(ctx.hostDetail.repoId, 'repo-id');
  assert.equal(ctx.hostDetail.worktreePath, weirdPath);
});

test('keeps a separator-less ORCA_WORKTREE_ID raw instead of guessing', () => {
  const ctx = detectContext({ ...orcaEnv, ORCA_WORKTREE_ID: 'just-an-id' }, OUTSIDE_WORK_CWD);
  assert.equal(ctx.hostDetail.worktreeId, 'just-an-id');
  assert.equal(ctx.hostDetail.repoId, null);
  assert.equal(ctx.hostDetail.worktreePath, null);
  assert.equal(ctx.repoRoot, null);
});

test('a cwd under ~/work resolves to the work account and jira', () => {
  const ctx = detectContext(orcaEnv, WORK_CWD);
  assert.equal(ctx.account, 'work');
  assert.equal(ctx.tracker, 'jira');
  assert.equal(ctx.trackerSource, 'cwd-work');
});

test('the ~/work root itself counts as work', () => {
  const ctx = detectContext({ HOME }, `${HOME}/work`);
  assert.equal(ctx.tracker, 'jira');
});

test('a sibling directory sharing the "work" prefix is not work', () => {
  const ctx = detectContext({ HOME }, `${HOME}/workspace/repo`);
  assert.equal(ctx.tracker, null);
  assert.equal(ctx.account, 'unknown');
});

test('outside ~/work no tracker is claimed', () => {
  for (const cwd of [OUTSIDE_WORK_CWD, '/tmp/scratch', `${HOME}/Desktop`]) {
    const ctx = detectContext({ HOME }, cwd);
    assert.equal(ctx.tracker, null);
    assert.equal(ctx.account, 'unknown');
    assert.equal(ctx.trackerSource, 'unknown');
  }
});

test('an Orca session advertises wave dispatch through the orca CLI', () => {
  const ctx = detectContext(orcaEnv, OUTSIDE_WORK_CWD);
  assert.equal(ctx.dispatch.available, true);
  assert.equal(ctx.dispatch.driver, DISPATCH_DRIVER_ORCA);
});

test('a Maestri session reports dispatch unavailable and names the missing adapter', () => {
  const ctx = detectContext(maestriEnv, OUTSIDE_WORK_CWD);
  assert.equal(ctx.dispatch.available, false);
  assert.equal(ctx.dispatch.driver, null);
  assert.match(ctx.dispatch.reason, /MAESTRI_CLI/);
});

test('a plain terminal reports dispatch unavailable and manual', () => {
  const ctx = detectContext({ HOME }, OUTSIDE_WORK_CWD);
  assert.equal(ctx.dispatch.available, false);
  assert.equal(ctx.dispatch.driver, null);
  assert.match(ctx.dispatch.reason, /manual|by hand/);
});

test('every host explains its dispatch, available or not', () => {
  for (const env of [orcaEnv, maestriEnv, { HOME }]) {
    const { dispatch } = detectContext(env, OUTSIDE_WORK_CWD);
    assert.notEqual(dispatch.reason.trim(), '');
  }
});

test('dispatch availability does not depend on the working directory', () => {
  const personal = detectContext(orcaEnv, OUTSIDE_WORK_CWD);
  const work = detectContext(orcaEnv, WORK_CWD);
  assert.deepEqual(personal.dispatch, work.dispatch);
});
