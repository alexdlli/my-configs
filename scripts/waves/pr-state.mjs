#!/usr/bin/env node
// pr-state.mjs — the CI half of a pull request's state, as JSON.
//
// Babysitting a PR means tracking two *independent* states, and conflating them
// is the classic mistake:
//
//   CI      keyed by branch + SHA + conclusion            (this script)
//   review  keyed by branch + SHA + feedback fingerprint  (fetch-pr-threads.mjs)
//
// Keying CI by branch + conclusion alone silently swallows the second failure on
// the same branch: the key never changes, so the agent thinks it already handled
// it. `ciKey` in the output carries all three parts so callers cannot get it
// wrong by accident.
//
// The subtle case this script exists for: a force-push cancels the run that was
// in flight, and GitHub reports the cancelled run, which reads exactly like a
// failure. Before concluding FAIL we look for a newer commit whose run is still
// going — if there is one, the agent already self-corrected and the honest
// conclusion is RUNNING. `ci.reason` says which of the two happened.
//
// Usage:
//   node scripts/waves/pr-state.mjs <number|url|branch> [--repo owner/name] [--compact]
//
// Exit codes are the shared wave table from gh.mjs. The CI conclusion is
// deliberately NOT an exit code — a failed query must never be readable as a CI
// verdict. Read `.ci.conclusion` for that.
//
// Zero deps, Node stdlib only (repo convention). Read-only: it never writes to
// the PR, never checks anything out.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  EXIT_GH_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  classifyGhFailure,
  gh,
  repoFromPullUrl,
} from './gh.mjs';

export const CI_PASS = 'PASS';
export const CI_FAIL = 'FAIL';
export const CI_RUNNING = 'RUNNING';
export const CI_NONE = 'NONE';

export const CI_REASON_NO_CHECKS = 'no-checks';
export const CI_REASON_CHECKS_PASSED = 'checks-passed';
export const CI_REASON_CHECKS_IN_FLIGHT = 'checks-in-flight';
export const CI_REASON_CHECKS_FAILED = 'checks-failed';
export const CI_REASON_CHECKS_CANCELLED = 'checks-cancelled';
export const CI_REASON_SUPERSEDED = 'superseded-by-newer-commit';

// GitHub check states, as reported by `gh pr checks --json state`.
const FAILING_CHECK_STATES = new Set([
  'FAILURE',
  'ERROR',
  'TIMED_OUT',
  'STARTUP_FAILURE',
  'ACTION_REQUIRED',
]);
// Cancelled is not a verdict about the code: a force-push cancels whatever was
// running. Blocking like a failure, but reported apart so the caller can tell a
// self-corrected agent from a red build.
const CANCELLED_CHECK_STATES = new Set(['CANCELLED', 'STALE']);
const PENDING_CHECK_STATES = new Set([
  'IN_PROGRESS',
  'QUEUED',
  'PENDING',
  'WAITING',
  'REQUESTED',
  'EXPECTED',
]);
// `gh run list --json status` lowercases these.
const RUN_IN_FLIGHT_STATUSES = new Set([
  'queued',
  'in_progress',
  'waiting',
  'requested',
  'pending',
]);

const RUN_LIST_LIMIT = 50;
const PR_VIEW_FIELDS =
  'number,title,url,state,isDraft,author,headRefName,headRefOid,baseRefName,mergeable,reviewDecision,commits';
const CHECK_FIELDS = 'name,state,workflow,link,startedAt,completedAt';
// Only what the supersession check reads: which commit a run belongs to, and
// whether it is still going.
const RUN_FIELDS = 'headSha,status';

const SCHEMA = 'wave.pr-state/1';

// ---------------------------------------------------------------------------
// Pure logic — no I/O below this line until `main`.
// ---------------------------------------------------------------------------

function commitPosition(commits, sha) {
  if (!sha) return -1;
  return commits.findIndex((commit) => commit && commit.oid === sha);
}

// A run supersedes the checks we are holding when it is still in flight on a
// commit that is strictly newer than the one those checks describe. When the
// head SHA is not in the commit list at all, it was force-pushed away, so any
// in-flight run on a known commit supersedes it.
function findSupersedingRun({ commits, runs, headSha }) {
  const inFlight = runs.filter((run) => run && RUN_IN_FLIGHT_STATUSES.has(String(run.status)));
  if (inFlight.length === 0) return null;

  const headIndex = commitPosition(commits, headSha);
  let best = null;
  let bestIndex = -1;

  for (const run of inFlight) {
    if (run.headSha === headSha) continue;
    const index = commitPosition(commits, run.headSha);
    if (index < 0) continue;
    if (headIndex >= 0 && index <= headIndex) continue;
    if (index > bestIndex) {
      best = run;
      bestIndex = index;
    }
  }
  return best;
}

function checkSummary(check) {
  return {
    name: check.name ?? null,
    state: check.state ?? null,
    workflow: check.workflow ?? null,
    link: check.link ?? null,
  };
}

/**
 * Derive the CI conclusion from a check list plus enough context to tell a
 * cancelled-by-force-push run from a real failure.
 *
 * @param {object} input
 * @param {Array<object>} [input.checks]  `gh pr checks --json`
 * @param {Array<object>} [input.commits] `gh pr view --json commits`, oldest first
 * @param {Array<object>} [input.runs]    `gh run list --json`
 * @param {string|null} [input.headSha]   the SHA the checks describe
 */
export function deriveCiConclusion({ checks = [], commits = [], runs = [], headSha = null } = {}) {
  const failing = checks.filter((check) => FAILING_CHECK_STATES.has(String(check.state)));
  const cancelled = checks.filter((check) => CANCELLED_CHECK_STATES.has(String(check.state)));
  const pending = checks.filter((check) => PENDING_CHECK_STATES.has(String(check.state)));
  const blocking = [...failing, ...cancelled];

  const counts = {
    total: checks.length,
    failing: failing.length,
    cancelled: cancelled.length,
    pending: pending.length,
    passing: checks.length - blocking.length - pending.length,
  };
  const base = {
    supersededBy: null,
    blocking: blocking.map(checkSummary),
    pending: pending.map(checkSummary),
    counts,
  };

  if (checks.length === 0) {
    return { ...base, conclusion: CI_NONE, reason: CI_REASON_NO_CHECKS };
  }

  if (blocking.length > 0) {
    const superseding = findSupersedingRun({ commits, runs, headSha });
    if (superseding) {
      return {
        ...base,
        conclusion: CI_RUNNING,
        reason: CI_REASON_SUPERSEDED,
        supersededBy: superseding.headSha,
      };
    }
    return {
      ...base,
      conclusion: CI_FAIL,
      reason: failing.length > 0 ? CI_REASON_CHECKS_FAILED : CI_REASON_CHECKS_CANCELLED,
    };
  }

  if (pending.length > 0) {
    return { ...base, conclusion: CI_RUNNING, reason: CI_REASON_CHECKS_IN_FLIGHT };
  }
  return { ...base, conclusion: CI_PASS, reason: CI_REASON_CHECKS_PASSED };
}

export function buildCiKey({ branch, sha, conclusion }) {
  return `${branch ?? '?'}@${sha ?? '?'}:${conclusion}`;
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

function die(exitCode, message) {
  process.stderr.write(`pr-state: ${message}\n`);
  process.exit(exitCode);
}

function ghJson(args) {
  const result = gh(args);
  if (!result.ok) {
    const failure = classifyGhFailure(result);
    die(failure.exitCode, failure.message);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    die(EXIT_GH_FAILED, `gh returned output that is not JSON: ${result.stdout.slice(0, 200)}`);
  }
}

// `gh pr checks` exits non-zero when checks are failing (1) or pending (8), and
// again when the branch has no checks at all. None of those are query failures,
// so the exit code cannot be trusted here — parse stdout first. Never dies: the
// caller decides whether an unreadable check list is fatal.
function fetchChecks(args) {
  const result = gh(args);
  if (result.stdout.startsWith('[')) {
    try {
      return { checks: JSON.parse(result.stdout), known: true };
    } catch {
      // fall through to the failure classification below
    }
  }
  if (/no checks reported|no required checks reported/i.test(result.stderr)) {
    return { checks: [], known: true };
  }
  return { checks: [], known: false, failure: classifyGhFailure(result) };
}

function parseArgs(argv) {
  const options = { ref: null, repo: null, compact: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repo' || arg === '-R') {
      options.repo = argv[i + 1];
      i += 1;
    } else if (arg === '--compact') {
      options.compact = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg.startsWith('-')) {
      die(EXIT_USAGE, `unknown flag ${arg}`);
    } else if (options.ref === null) {
      options.ref = arg;
    } else {
      die(EXIT_USAGE, `unexpected argument ${arg}`);
    }
  }
  return options;
}

const USAGE = `usage: pr-state.mjs <number|url|branch> [--repo owner/name] [--compact]

Emits the CI half of a PR's state as JSON. Exit code 0 means the query worked;
read .ci.conclusion for the CI verdict.`;

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(EXIT_OK);
  }
  if (!options.ref) die(EXIT_USAGE, USAGE);

  const repoArgs = options.repo ? ['--repo', options.repo] : [];
  const notes = [];

  const pr = ghJson(['pr', 'view', options.ref, ...repoArgs, '--json', PR_VIEW_FIELDS]);
  const repo = options.repo || repoFromPullUrl(pr.url);
  const branch = pr.headRefName ?? null;
  const headSha = pr.headRefOid ?? null;
  const commits = Array.isArray(pr.commits) ? pr.commits : [];

  const all = fetchChecks(['pr', 'checks', options.ref, ...repoArgs, '--json', CHECK_FIELDS]);
  if (!all.known) die(all.failure.exitCode, `could not read checks: ${all.failure.message}`);

  const required = fetchChecks([
    'pr',
    'checks',
    options.ref,
    ...repoArgs,
    '--required',
    '--json',
    CHECK_FIELDS,
  ]);
  if (!required.known) {
    notes.push(
      `required-check list unavailable (${required.failure.message}) — treat every check as required`,
    );
  }

  let runs = [];
  const runsResult = branch
    ? gh([
        'run',
        'list',
        ...repoArgs,
        '--branch',
        branch,
        '--limit',
        String(RUN_LIST_LIMIT),
        '--json',
        RUN_FIELDS,
      ])
    : null;
  if (runsResult && runsResult.ok && runsResult.stdout.startsWith('[')) {
    runs = JSON.parse(runsResult.stdout);
  } else {
    notes.push(
      'workflow runs unavailable — a FAIL here could not be checked against a newer commit still running',
    );
  }

  const ci = deriveCiConclusion({ checks: all.checks, commits, runs, headSha });
  const requiredNames = new Set(required.checks.map((check) => check.name));
  const requiredBlocking = required.known
    ? ci.blocking.filter((check) => requiredNames.has(check.name))
    : ci.blocking;

  const output = {
    schema: SCHEMA,
    repo,
    number: pr.number ?? null,
    url: pr.url ?? null,
    title: pr.title ?? null,
    author: pr.author?.login ?? null,
    state: pr.state ?? null,
    isDraft: pr.isDraft ?? null,
    branch,
    baseBranch: pr.baseRefName ?? null,
    sha: headSha,
    mergeable: pr.mergeable ?? null,
    reviewDecision: pr.reviewDecision || null,
    checkedAt: new Date().toISOString(),
    ci: {
      ...ci,
      requiredKnown: required.known,
      requiredBlocking,
      requiredCount: required.known ? requiredNames.size : null,
    },
    ciKey: buildCiKey({ branch, sha: headSha, conclusion: ci.conclusion }),
    checks: all.checks.map((check) => ({
      ...checkSummary(check),
      required: required.known ? requiredNames.has(check.name) : null,
      startedAt: check.startedAt ?? null,
      completedAt: check.completedAt ?? null,
    })),
    notes,
  };

  process.stdout.write(`${JSON.stringify(output, null, options.compact ? 0 : 2)}\n`);
  process.exit(EXIT_OK);
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
