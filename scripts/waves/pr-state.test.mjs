import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CI_FAIL,
  CI_NONE,
  CI_PASS,
  CI_RUNNING,
  CI_REASON_CHECKS_CANCELLED,
  CI_REASON_CHECKS_FAILED,
  CI_REASON_CHECKS_IN_FLIGHT,
  CI_REASON_CHECKS_PASSED,
  CI_REASON_NO_CHECKS,
  CI_REASON_SUPERSEDED,
  buildCiKey,
  deriveCiConclusion,
} from './pr-state.mjs';

const OLD_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NEW_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const check = (state, name = state.toLowerCase()) => ({ state, name, workflow: 'ci', link: null });
const run = (headSha, status) => ({ headSha, status, workflowName: 'ci' });

test('no checks at all is NONE, not PASS', () => {
  const ci = deriveCiConclusion({ checks: [], commits: [{ oid: OLD_SHA }], headSha: OLD_SHA });
  assert.equal(ci.conclusion, CI_NONE);
  assert.equal(ci.reason, CI_REASON_NO_CHECKS);
});

test('fully empty input is NONE', () => {
  const ci = deriveCiConclusion();
  assert.equal(ci.conclusion, CI_NONE);
  assert.equal(ci.reason, CI_REASON_NO_CHECKS);
  assert.deepEqual(ci.counts, { total: 0, failing: 0, cancelled: 0, pending: 0, passing: 0 });
});

test('all green is PASS', () => {
  const ci = deriveCiConclusion({
    checks: [check('SUCCESS'), check('SKIPPED'), check('NEUTRAL')],
    commits: [{ oid: OLD_SHA }],
    headSha: OLD_SHA,
  });
  assert.equal(ci.conclusion, CI_PASS);
  assert.equal(ci.reason, CI_REASON_CHECKS_PASSED);
  assert.equal(ci.counts.passing, 3);
});

test('a real failure is FAIL and names the blocking check', () => {
  const ci = deriveCiConclusion({
    checks: [check('SUCCESS'), check('FAILURE', 'unit')],
    commits: [{ oid: OLD_SHA }],
    runs: [run(OLD_SHA, 'completed')],
    headSha: OLD_SHA,
  });
  assert.equal(ci.conclusion, CI_FAIL);
  assert.equal(ci.reason, CI_REASON_CHECKS_FAILED);
  assert.deepEqual(
    ci.blocking.map((entry) => entry.name),
    ['unit'],
  );
  assert.equal(ci.supersededBy, null);
});

test('ERROR blocks the same way FAILURE does', () => {
  const ci = deriveCiConclusion({ checks: [check('ERROR')], headSha: OLD_SHA });
  assert.equal(ci.conclusion, CI_FAIL);
  assert.equal(ci.reason, CI_REASON_CHECKS_FAILED);
});

test('a run cancelled by force-push is RUNNING when a newer commit is in flight', () => {
  const ci = deriveCiConclusion({
    checks: [check('CANCELLED', 'unit')],
    commits: [{ oid: OLD_SHA }, { oid: NEW_SHA }],
    runs: [run(OLD_SHA, 'completed'), run(NEW_SHA, 'in_progress')],
    headSha: OLD_SHA,
  });
  assert.equal(ci.conclusion, CI_RUNNING);
  assert.equal(ci.reason, CI_REASON_SUPERSEDED);
  assert.equal(ci.supersededBy, NEW_SHA);
});

test('a cancelled run with no newer commit is FAIL, reported as cancelled', () => {
  const ci = deriveCiConclusion({
    checks: [check('CANCELLED', 'unit')],
    commits: [{ oid: OLD_SHA }],
    runs: [run(OLD_SHA, 'completed')],
    headSha: OLD_SHA,
  });
  assert.equal(ci.conclusion, CI_FAIL);
  assert.equal(ci.reason, CI_REASON_CHECKS_CANCELLED);
  assert.equal(ci.supersededBy, null);
});

test('a newer commit whose run already finished does not rescue a cancelled build', () => {
  const ci = deriveCiConclusion({
    checks: [check('CANCELLED', 'unit')],
    commits: [{ oid: OLD_SHA }, { oid: NEW_SHA }],
    runs: [run(NEW_SHA, 'completed')],
    headSha: OLD_SHA,
  });
  assert.equal(ci.conclusion, CI_FAIL);
  assert.equal(ci.reason, CI_REASON_CHECKS_CANCELLED);
});

test('an in-flight run on an OLDER commit never supersedes', () => {
  const ci = deriveCiConclusion({
    checks: [check('FAILURE', 'unit')],
    commits: [{ oid: OLD_SHA }, { oid: NEW_SHA }],
    runs: [run(OLD_SHA, 'in_progress')],
    headSha: NEW_SHA,
  });
  assert.equal(ci.conclusion, CI_FAIL);
  assert.equal(ci.reason, CI_REASON_CHECKS_FAILED);
});

test('checks for a SHA force-pushed out of the branch are superseded by any in-flight run', () => {
  const ci = deriveCiConclusion({
    checks: [check('CANCELLED', 'unit')],
    commits: [{ oid: NEW_SHA }],
    runs: [run(NEW_SHA, 'queued')],
    headSha: OLD_SHA,
  });
  assert.equal(ci.conclusion, CI_RUNNING);
  assert.equal(ci.supersededBy, NEW_SHA);
});

test('a real failure is still FAIL when the newer commit is only pending in the run list', () => {
  const ci = deriveCiConclusion({
    checks: [check('FAILURE', 'unit')],
    commits: [{ oid: OLD_SHA }, { oid: NEW_SHA }],
    runs: [],
    headSha: OLD_SHA,
  });
  assert.equal(ci.conclusion, CI_FAIL);
  assert.equal(ci.reason, CI_REASON_CHECKS_FAILED);
});

test('mixed PASS and PENDING is RUNNING', () => {
  const ci = deriveCiConclusion({
    checks: [check('SUCCESS'), check('IN_PROGRESS'), check('QUEUED')],
    commits: [{ oid: OLD_SHA }],
    headSha: OLD_SHA,
  });
  assert.equal(ci.conclusion, CI_RUNNING);
  assert.equal(ci.reason, CI_REASON_CHECKS_IN_FLIGHT);
  assert.equal(ci.counts.pending, 2);
});

test('failure wins over pending', () => {
  const ci = deriveCiConclusion({
    checks: [check('IN_PROGRESS'), check('FAILURE', 'unit')],
    commits: [{ oid: OLD_SHA }],
    headSha: OLD_SHA,
  });
  assert.equal(ci.conclusion, CI_FAIL);
});

test('a mix of failed and cancelled reports the failure, not the cancellation', () => {
  const ci = deriveCiConclusion({
    checks: [check('CANCELLED', 'lint'), check('FAILURE', 'unit')],
    commits: [{ oid: OLD_SHA }],
    headSha: OLD_SHA,
  });
  assert.equal(ci.reason, CI_REASON_CHECKS_FAILED);
  assert.equal(ci.counts.failing, 1);
  assert.equal(ci.counts.cancelled, 1);
});

test('the CI key carries branch, SHA and conclusion so a repeat failure is a new key', () => {
  const first = buildCiKey({ branch: 'feat/x', sha: OLD_SHA, conclusion: CI_FAIL });
  const second = buildCiKey({ branch: 'feat/x', sha: NEW_SHA, conclusion: CI_FAIL });
  assert.notEqual(first, second);
  assert.equal(first, `feat/x@${OLD_SHA}:FAIL`);
});
