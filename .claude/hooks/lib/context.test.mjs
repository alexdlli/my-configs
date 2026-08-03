import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HOST_MAESTRI, HOST_PLAIN, describeDispatch, detectContext } from './context.mjs';

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

// Every host the detector can return. A new host must be added here, which is
// what makes the two whole-set dispatch assertions below act as a tripwire.
const everyHostEnv = [maestriEnv, plainEnv];

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

test('no host advertises an automatic wave driver', () => {
  for (const env of everyHostEnv) {
    const { dispatch } = detectContext(env, OUTSIDE_WORK_CWD);
    assert.equal(dispatch.available, false);
    assert.equal(dispatch.driver, null);
  }
});

test('a Maestri session names the manual dispatch it replaces the driver with', () => {
  const ctx = detectContext(maestriEnv, OUTSIDE_WORK_CWD);
  assert.match(ctx.dispatch.reason, /MAESTRI_CLI/);
  assert.match(ctx.dispatch.reason, /floor/);
});

test('a plain terminal points at a human instead of a driver', () => {
  const ctx = detectContext(plainEnv, OUTSIDE_WORK_CWD);
  assert.match(ctx.dispatch.reason, /manual|by hand/);
});

test('every host explains its dispatch, available or not', () => {
  for (const env of everyHostEnv) {
    const { dispatch } = detectContext(env, OUTSIDE_WORK_CWD);
    assert.notEqual(dispatch.reason.trim(), '');
  }
});

// The list above is kept by hand, so it cannot catch a host added to detectHost
// and nowhere else. This one does: the reason is a string for any host at all.
test('a host with no reason of its own still explains its dispatch', () => {
  const dispatch = describeDispatch('a-host-nobody-mapped');
  assert.equal(dispatch.available, false);
  assert.equal(dispatch.driver, null);
  assert.equal(typeof dispatch.reason, 'string');
  assert.notEqual(dispatch.reason.trim(), '');
});

test('dispatch availability does not depend on the working directory', () => {
  const personal = detectContext(maestriEnv, OUTSIDE_WORK_CWD);
  const work = detectContext(maestriEnv, WORK_CWD);
  assert.deepEqual(personal.dispatch, work.dispatch);
});
