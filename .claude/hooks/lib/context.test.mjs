import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HOST_MAESTRI, HOST_PLAIN, detectContext } from './context.mjs';

const HOME = '/Users/tester';
const OUTSIDE_WORK_CWD = `${HOME}/Developer/my-configs`;
const WORK_CWD = `${HOME}/work/some-repo`;

const maestriEnv = {
  HOME,
  MAESTRI_TERMINAL_ID: 'terminal-42',
  MAESTRI_SOCKET: '/tmp/maestri-abc/maestri.sock',
  MAESTRI_CLI: '/tmp/maestri-abc/maestri',
};

const plainEnv = { HOME };

test('detects Maestri from its per-terminal id', () => {
  const ctx = detectContext(maestriEnv, OUTSIDE_WORK_CWD);
  assert.equal(ctx.host, HOST_MAESTRI);
  assert.equal(ctx.hostDetail.terminalId, 'terminal-42');
  assert.equal(ctx.hostDetail.cliPath, '/tmp/maestri-abc/maestri');
});

test('falls back to plain when no host var is set', () => {
  const ctx = detectContext({ HOME, TERM_PROGRAM: 'Apple_Terminal' }, OUTSIDE_WORK_CWD);
  assert.equal(ctx.host, HOST_PLAIN);
  assert.deepEqual(ctx.hostDetail, {});
});

test('a cwd under ~/work resolves to the work account and jira', () => {
  const ctx = detectContext(plainEnv, WORK_CWD);
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

test('the context carries no dispatch surface', () => {
  const ctx = detectContext(maestriEnv, OUTSIDE_WORK_CWD);
  assert.equal('dispatch' in ctx, false);
});
