// gh.mjs — how the two PR readers talk to the `gh` CLI, and the exit-code table
// they both honour, so a caller of either script reads one contract.
//
// It runs `gh`, classifies a failed invocation, and reads the repo slug off a
// PR url. That is all it knows. It has no opinion about CI — what a check state
// means lives in pr-state.mjs — and none about review — what a feedback thread
// means lives in fetch-pr-threads.mjs. Neither may be imported from here; the
// dependency runs one way, from the scripts to this module.
//
// tickets-github.mjs also talks to `gh` and is deliberately not a caller: it
// reads issues rather than pull requests, and carries its own exit-code table
// where 4 is "unreachable or rate limited", 5 "not authenticated" and 6 "repo
// not found". Those meanings collide with the ones below, so the two tables
// must never be read as one.
//
// Exit codes:
//   0  the query succeeded
//   1  gh failed for a reason we could not classify
//   2  bad usage
//   3  gh is not on PATH
//   4  gh is not authenticated
//   5  no such pull request
//   6  GitHub rate limit / abuse detection
//
// Zero deps, Node stdlib only (repo convention). Read-only: nothing here writes
// to GitHub.

import { spawnSync } from 'node:child_process';

export const EXIT_OK = 0;
export const EXIT_GH_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_GH_MISSING = 3;
export const EXIT_GH_UNAUTHENTICATED = 4;
export const EXIT_PR_NOT_FOUND = 5;
export const EXIT_RATE_LIMITED = 6;

const GH_TIMEOUT_MS = 60000;

/**
 * Turn a failed `gh` invocation into an exit code plus a message that says
 * which failure it was. Reading a broken query as a successful one is the one
 * outcome this module exists to prevent.
 */
export function classifyGhFailure(result) {
  if (result.missing) {
    return { exitCode: EXIT_GH_MISSING, message: 'gh is not on PATH — install the GitHub CLI' };
  }
  if (result.timedOut) {
    return { exitCode: EXIT_GH_FAILED, message: `gh timed out after ${GH_TIMEOUT_MS}ms` };
  }
  const stderr = result.stderr || '';
  if (/rate limit|secondary rate|abuse detection/i.test(stderr)) {
    return { exitCode: EXIT_RATE_LIMITED, message: `GitHub rate limit: ${stderr}` };
  }
  if (/gh auth login|not logged in|bad credentials|requires authentication|401/i.test(stderr)) {
    return { exitCode: EXIT_GH_UNAUTHENTICATED, message: `gh is not authenticated: ${stderr}` };
  }
  if (/no pull requests found|could not resolve to a pullrequest|not found|http 404/i.test(stderr)) {
    return { exitCode: EXIT_PR_NOT_FOUND, message: `pull request not found: ${stderr}` };
  }
  return { exitCode: EXIT_GH_FAILED, message: stderr || `gh exited with code ${result.code}` };
}

export function repoFromPullUrl(url) {
  const match = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(url || '');
  return match ? `${match[1]}/${match[2]}` : null;
}

export function gh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', timeout: GH_TIMEOUT_MS });
  return {
    ok: result.status === 0,
    code: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    missing: Boolean(result.error && result.error.code === 'ENOENT'),
    timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
  };
}
