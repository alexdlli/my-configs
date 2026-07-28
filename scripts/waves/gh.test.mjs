import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyGhFailure, repoFromPullUrl } from './gh.mjs';

test('gh failures are classified instead of swallowed', () => {
  assert.equal(classifyGhFailure({ missing: true }).exitCode, 3);
  assert.equal(
    classifyGhFailure({ stderr: 'gh auth login required to use this command' }).exitCode,
    4,
  );
  assert.equal(classifyGhFailure({ stderr: 'no pull requests found for branch "x"' }).exitCode, 5);
  assert.equal(classifyGhFailure({ stderr: 'API rate limit exceeded for user' }).exitCode, 6);
  assert.equal(classifyGhFailure({ stderr: 'something else broke', code: 1 }).exitCode, 1);
});

test('rate limiting is not mistaken for a missing PR', () => {
  const failure = classifyGhFailure({ stderr: 'HTTP 403: API rate limit exceeded (not found)' });
  assert.equal(failure.exitCode, 6);
});

test('the repo slug comes from the PR url', () => {
  assert.equal(repoFromPullUrl('https://github.com/cli/cli/pull/13982'), 'cli/cli');
  assert.equal(repoFromPullUrl(''), null);
});
