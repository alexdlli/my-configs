#!/usr/bin/env node
// Read GitHub Issues through the `gh` CLI and emit the normalized ticket array
// the wave planner consumes:
//
//   { id, key, title, url, estimate, status, statusType, blockedBy, body, external }
//
// plus `blockedBySources`, a GitHub-only extra that records where each edge came
// from (`native` | `marker` | `both`). graph.mjs ignores it.
//
// `blockedBy` is the union of the native GitHub issue dependency (the `blockedBy`
// field of `gh issue list --json`) and an anchored body marker,
// `<!-- blocked-by: #12, owner/repo#34 -->`. Never inferred from titles,
// numbering or ordering. Read-only: this script never creates, moves, closes or
// comments on anything.
//
// Usage:
//   node tickets-github.mjs --repo <owner>/<repo> [--milestone <n>] [--label <l>] [--json]
//   node tickets-github.mjs -h | --help
//
// Exit codes: 0 success, 2 usage, 3 gh CLI missing, 4 GitHub unreachable or rate
// limited, 5 gh not authenticated or missing scope, 6 repo not found or issues
// disabled, 7 gh error (a truncated read included), 8 tickets emitted but the
// data behind them is bad.

import process from 'node:process';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const GH_COMMAND = process.env.GH_CLI_COMMAND ?? 'gh';
const GH_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

// `gh` documents 4 for "this command requires authentication"; every other
// failure is a plain 1 whose meaning only lives in stderr.
const GH_EXIT_AUTH_REQUIRED = 4;

// GitHub caps every issue relation connection; past it the `--json` nodes come
// back silently short of `totalCount`.
const GH_RELATION_NODE_CAP = 50;

const ISSUE_FETCH_LIMIT = 1000;
const ISSUE_FETCH_PROBE_LIMIT = ISSUE_FETCH_LIMIT + 1;

const ISSUE_LIST_FIELDS = 'number,title,url,state,stateReason,body,blockedBy,labels';
const ISSUE_VIEW_FIELDS = 'number,title,url,state,stateReason';

const EXTERNAL_FETCH_CONCURRENCY = 4;

const ALL_STATES = 'all';

const STATE_OPEN = 'OPEN';
const STATE_CLOSED = 'CLOSED';
const STATE_REASON_COMPLETED = 'COMPLETED';
const STATE_REASON_NOT_PLANNED = 'NOT_PLANNED';

const STATUS_OPEN = 'Open';
const STATUS_CLOSED_COMPLETED = 'Closed (completed)';
const STATUS_CLOSED_NOT_PLANNED = 'Closed (not planned)';
const STATUS_CLOSED_NO_REASON = 'Closed (no reason)';

// graph.mjs treats `completed` as "merged, satisfies whatever it blocks"; every
// other type leaves the blocker open.
const STATUS_TYPE_OPEN = 'open';
const STATUS_TYPE_COMPLETED = 'completed';
const STATUS_TYPE_CANCELED = 'canceled';

export const SOURCE_NATIVE = 'native';
export const SOURCE_MARKER = 'marker';
export const SOURCE_BOTH = 'both';

export const BAD_DATA_MARKER = 'blocked-by-marker';
export const BAD_DATA_BLOCKER_URL = 'blocker-url';
export const BAD_DATA_ESTIMATE_MALFORMED = 'estimate-label-malformed';
export const BAD_DATA_ESTIMATE_CONFLICT = 'estimate-label-conflict';
export const BAD_DATA_BLOCKER_NOT_AN_ISSUE = 'blocker-not-an-issue';

export const FAILURE_CLI_MISSING = 'cli-missing';
export const FAILURE_RATE_LIMITED = 'rate-limited';
export const FAILURE_NOT_AUTHENTICATED = 'not-authenticated';
export const FAILURE_INSUFFICIENT_SCOPE = 'insufficient-scope';
export const FAILURE_REPO_NOT_FOUND = 'repo-not-found';
export const FAILURE_ISSUES_DISABLED = 'issues-disabled';
export const FAILURE_TRUNCATED = 'truncated';
export const FAILURE_GH_ERROR = 'gh-error';

const EXIT_USAGE = 2;
const EXIT_CLI_MISSING = 3;
const EXIT_GITHUB_UNAVAILABLE = 4;
const EXIT_NOT_AUTHENTICATED = 5;
const EXIT_REPO_UNREADABLE = 6;
const EXIT_GH_ERROR = 7;
const EXIT_BAD_DATA = 8;

const EXIT_CODE_BY_FAILURE = {
  [FAILURE_CLI_MISSING]: EXIT_CLI_MISSING,
  [FAILURE_RATE_LIMITED]: EXIT_GITHUB_UNAVAILABLE,
  [FAILURE_NOT_AUTHENTICATED]: EXIT_NOT_AUTHENTICATED,
  [FAILURE_INSUFFICIENT_SCOPE]: EXIT_NOT_AUTHENTICATED,
  [FAILURE_REPO_NOT_FOUND]: EXIT_REPO_UNREADABLE,
  [FAILURE_ISSUES_DISABLED]: EXIT_REPO_UNREADABLE,
  [FAILURE_TRUNCATED]: EXIT_GH_ERROR,
  [FAILURE_GH_ERROR]: EXIT_GH_ERROR,
};

// Ordered: GitHub answers a secondary rate limit with 403, the same status as a
// scope problem, so the rate-limit wording has to win.
const GH_FAILURE_PATTERNS = [
  [/could not resolve to a repository|could not resolve to a user/i, FAILURE_REPO_NOT_FOUND],
  [/has disabled issues/i, FAILURE_ISSUES_DISABLED],
  [/rate limit|secondary rate|abuse detection|submitted too quickly/i, FAILURE_RATE_LIMITED],
  [/gh auth login|bad credentials|requires authentication|http 401/i, FAILURE_NOT_AUTHENTICATED],
  [/insufficient|missing.*scope|resource not accessible|http 403/i, FAILURE_INSUFFICIENT_SCOPE],
];

const REPO_ARGUMENT = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/;
const ISSUE_URL = /^https?:\/\/[^/]+\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/issues\/(\d+)(?:[/?#]|$)/i;
const ISSUE_REF_TOKEN = /^(?:([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+))?#(\d+)$/;
const BLOCKED_BY_MARKER = /<!--\s*blocked-by\s*:([\s\S]*?)-->/gi;
const MARKER_SEPARATOR = /[\s,;]+/;

const ESTIMATE_LABEL_PREFIX = /^est\s*:/i;
const ESTIMATE_LABEL_VALUE = /^est\s*:\s*(\d+(?:\.\d+)?)$/i;

const KEY_COLUMN_WIDTH = 12;
const STATUS_COLUMN_WIDTH = 22;

const STDOUT_EXCERPT_LENGTH = 200;

function unique(values) {
  return [...new Set(values)];
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Builds the id every source has to agree on: `<owner>/<repo>#<number>`.
 *
 * Lowercased because GitHub owner and repo names are case insensitive, and a
 * marker typed by hand would otherwise fail to dedupe against the API answer.
 *
 * @param {string} repo `owner/repo`
 * @param {number|string} number issue number
 * @returns {string}
 */
export function canonicalId(repo, number) {
  return `${String(repo).toLowerCase()}#${Number(number)}`;
}

/**
 * Splits a canonical id back into the pieces `gh` needs.
 *
 * @param {string} id canonical id
 * @returns {{repo: string, number: number}}
 */
export function splitCanonicalId(id) {
  const separator = String(id).lastIndexOf('#');
  return {
    repo: String(id).slice(0, separator),
    number: Number(String(id).slice(separator + 1)),
  };
}

/**
 * Reads the repo and number out of an issue URL.
 *
 * The nodes of the native `blockedBy` field carry no `repository`, so the URL is
 * the only place the blocker's repo is available through the CLI.
 *
 * @param {?string} url issue URL
 * @returns {?{repo: string, number: number}} null when it is not an issue URL
 */
export function refFromUrl(url) {
  const match = ISSUE_URL.exec(String(url ?? ''));
  if (!match) return null;
  return { repo: `${match[1]}/${match[2]}`, number: Number(match[3]) };
}

/**
 * Turns one marker token (`#12` or `owner/repo#12`) into a canonical id.
 *
 * @param {string} token single reference as typed in the marker
 * @param {string} defaultRepo repo assumed by a bare `#12`
 * @returns {?string} null when the token is not an issue reference
 */
export function parseIssueRefToken(token, defaultRepo) {
  const match = ISSUE_REF_TOKEN.exec(String(token).trim());
  if (!match) return null;
  const [, owner, name, number] = match;
  return canonicalId(owner ? `${owner}/${name}` : defaultRepo, number);
}

/**
 * Reads the anchored `<!-- blocked-by: ... -->` markers out of an issue body.
 *
 * An HTML comment is used on purpose: it does not render, and it anchors the
 * regex instead of hunting `#\d+` in free text, where prose, code blocks and
 * checklists all match. Several markers in one body are unioned — a body grown
 * in passes is not bad data, and the union is the same operation already applied
 * between the native and the textual source.
 *
 * @param {?string} body issue body
 * @param {string} defaultRepo repo assumed by a bare `#12`
 * @returns {{ids: string[], malformed: string[], markers: number}}
 */
export function parseBlockedByMarkers(body, defaultRepo) {
  const ids = [];
  const malformed = [];
  let markers = 0;

  for (const match of String(body ?? '').matchAll(BLOCKED_BY_MARKER)) {
    markers += 1;
    const payload = match[1].trim();
    if (payload.length === 0) {
      malformed.push(match[0]);
      continue;
    }
    for (const token of payload.split(MARKER_SEPARATOR)) {
      if (token.length === 0) continue;
      const id = parseIssueRefToken(token, defaultRepo);
      if (id === null) malformed.push(token);
      else ids.push(id);
    }
  }

  return { ids: unique(ids), malformed, markers };
}

/**
 * Reads the estimate off the conventional `est:<n>` label.
 *
 * @param {Array<{name: string}|string>} labels labels from `gh issue list --json labels`
 * @returns {{estimate: ?number, problem: ?string, labels: string[]}}
 */
export function readEstimate(labels) {
  const names = asArray(labels)
    .map((label) => (typeof label === 'string' ? label : label?.name))
    .filter((name) => typeof name === 'string' && ESTIMATE_LABEL_PREFIX.test(name.trim()))
    .map((name) => name.trim());

  if (names.length === 0) return { estimate: null, problem: null, labels: [] };

  const malformed = names.filter((name) => !ESTIMATE_LABEL_VALUE.test(name));
  if (malformed.length > 0) {
    return { estimate: null, problem: BAD_DATA_ESTIMATE_MALFORMED, labels: malformed };
  }

  const values = unique(names.map((name) => Number(ESTIMATE_LABEL_VALUE.exec(name)[1])));
  if (values.length > 1) {
    return { estimate: null, problem: BAD_DATA_ESTIMATE_CONFLICT, labels: names };
  }
  return { estimate: values[0], problem: null, labels: [] };
}

/**
 * Reads the native GitHub issue dependency connection.
 *
 * @param {?{nodes: object[], totalCount: number}} blockedBy `blockedBy` as `gh` returns it
 * @returns {{ids: string[], unreadable: string[], totalCount: number, truncated: boolean}}
 */
export function nativeBlockedBy(blockedBy) {
  const nodes = asArray(blockedBy?.nodes);
  const totalCount = Number(blockedBy?.totalCount ?? nodes.length);
  const ids = [];
  const unreadable = [];

  for (const node of nodes) {
    const ref = refFromUrl(node?.url);
    if (ref === null) unreadable.push(String(node?.url ?? node?.number ?? 'unknown'));
    else ids.push(canonicalId(ref.repo, ref.number));
  }

  return { ids: unique(ids), unreadable, totalCount, truncated: totalCount > nodes.length };
}

/**
 * Unions the native and the textual blocker lists, keeping the provenance.
 *
 * @param {string[]} nativeIds canonical ids from the native field
 * @param {string[]} markerIds canonical ids from the body marker
 * @returns {{ids: string[], sources: Object<string, string>}}
 */
export function mergeBlockedBy(nativeIds, markerIds) {
  const sources = new Map();
  for (const id of nativeIds) sources.set(id, SOURCE_NATIVE);
  for (const id of markerIds) {
    sources.set(id, sources.get(id) === SOURCE_NATIVE ? SOURCE_BOTH : SOURCE_MARKER);
  }
  return { ids: [...sources.keys()], sources: Object.fromEntries(sources) };
}

/**
 * Maps GitHub's `state` + `stateReason` onto the tracker-agnostic status pair.
 *
 * A closed issue with no reason is read as completed: GitHub backfilled the
 * pre-2022 closes as `COMPLETED` and only offers "not planned" as the opt-out,
 * so the blank reason means "closed, nobody said otherwise". The opposite
 * reading would hold dependents open behind a blocker that is visibly closed.
 *
 * @param {?string} state `OPEN` or `CLOSED`
 * @param {?string} stateReason `COMPLETED`, `NOT_PLANNED`, `REOPENED` or empty
 * @returns {{status: ?string, statusType: ?string}}
 */
export function mapState(state, stateReason) {
  const normalized = String(state ?? '').trim().toUpperCase();
  const reason = String(stateReason ?? '').trim().toUpperCase();

  if (normalized === STATE_OPEN) return { status: STATUS_OPEN, statusType: STATUS_TYPE_OPEN };
  if (normalized === STATE_CLOSED) {
    if (reason === STATE_REASON_NOT_PLANNED) {
      return { status: STATUS_CLOSED_NOT_PLANNED, statusType: STATUS_TYPE_CANCELED };
    }
    if (reason === STATE_REASON_COMPLETED) {
      return { status: STATUS_CLOSED_COMPLETED, statusType: STATUS_TYPE_COMPLETED };
    }
    return { status: STATUS_CLOSED_NO_REASON, statusType: STATUS_TYPE_COMPLETED };
  }
  return { status: null, statusType: null };
}

/**
 * Maps a `gh` issue payload onto the normalized ticket shape.
 *
 * @param {object} payload issue payload from `gh issue list` or `gh issue view`
 * @param {{repo: string, blockedBy?: string[], blockedBySources?: object,
 *   estimate?: ?number, external?: boolean}} options
 * @returns {object} normalized ticket
 */
export function normalizeIssue(payload, options) {
  const number = Number(payload?.number);
  if (!Number.isInteger(number) || number <= 0) {
    const keys = Object.keys(payload ?? {}).join(', ') || 'none';
    throw new Error(`gh returned an issue without a usable number (payload keys: ${keys})`);
  }
  const external = options.external === true;
  const id = canonicalId(options.repo, number);
  const { status, statusType } = mapState(payload.state, payload.stateReason);

  return {
    id,
    key: external ? id : `#${number}`,
    title: payload.title ?? null,
    url: payload.url ?? null,
    estimate: options.estimate ?? null,
    status,
    statusType,
    blockedBy: options.blockedBy ?? [],
    body: external ? null : (payload.body ?? null),
    external,
    blockedBySources: options.blockedBySources ?? {},
  };
}

/**
 * Turns the raw `gh issue list --json` array into normalized tickets.
 *
 * Pure: no process, no network. `externalRefs` are the blocker ids that fall
 * outside the requested slice; the caller reads them one by one.
 *
 * @param {object[]} issues raw issue payloads
 * @param {{repo: string}} options target repo as `owner/repo`
 * @returns {{tickets: object[], badData: object[], truncations: object[], externalRefs: string[]}}
 */
export function normalizeIssues(issues, options) {
  const { repo } = options;
  const tickets = [];
  const badData = [];
  const truncations = [];

  for (const payload of asArray(issues)) {
    const native = nativeBlockedBy(payload?.blockedBy);
    const marker = parseBlockedByMarkers(payload?.body, repo);
    const estimate = readEstimate(payload?.labels);
    const merged = mergeBlockedBy(native.ids, marker.ids);
    const ticket = normalizeIssue(payload, {
      repo,
      blockedBy: merged.ids,
      blockedBySources: merged.sources,
      estimate: estimate.estimate,
    });
    tickets.push(ticket);

    if (native.truncated) {
      truncations.push({
        id: ticket.id,
        returned: asArray(payload?.blockedBy?.nodes).length,
        totalCount: native.totalCount,
      });
    }
    for (const url of native.unreadable) {
      badData.push({
        id: ticket.id,
        kind: BAD_DATA_BLOCKER_URL,
        detail: `native blocker has no readable issue URL: ${url}`,
      });
    }
    for (const token of marker.malformed) {
      badData.push({
        id: ticket.id,
        kind: BAD_DATA_MARKER,
        detail: `blocked-by marker entry is not an issue reference: ${token}`,
      });
    }
    if (estimate.problem === BAD_DATA_ESTIMATE_MALFORMED) {
      badData.push({
        id: ticket.id,
        kind: estimate.problem,
        detail: `est: label carries no number: ${estimate.labels.join(', ')}`,
      });
    }
    if (estimate.problem === BAD_DATA_ESTIMATE_CONFLICT) {
      badData.push({
        id: ticket.id,
        kind: estimate.problem,
        detail: `conflicting est: labels, estimate left null: ${estimate.labels.join(', ')}`,
      });
    }
  }

  const known = new Set(tickets.map((ticket) => ticket.id));
  const externalRefs = unique(tickets.flatMap((ticket) => ticket.blockedBy)).filter(
    (id) => !known.has(id),
  );

  return { tickets, badData, truncations, externalRefs };
}

/**
 * Classifies one `gh` invocation as usable JSON or a named failure.
 *
 * `gh` answers an empty match with exit 0 and `[]`, and every failure with a
 * non-zero exit — so an array only ever reaches the caller after a real read.
 *
 * @param {{error: ?Error, stdout: string, stderr: string}} result
 * @returns {{data: *}|{failure: string, message: string}}
 */
export function classifyGhResult(result) {
  if (result.error?.code === 'ENOENT') {
    return {
      failure: FAILURE_CLI_MISSING,
      message: `the gh CLI was not found (tried "${GH_COMMAND}"; set GH_CLI_COMMAND to override)`,
    };
  }

  const stderr = String(result.stderr ?? '').trim();

  if (result.error) {
    for (const [pattern, failure] of GH_FAILURE_PATTERNS) {
      if (pattern.test(stderr)) return { failure, message: stderr };
    }
    if (result.error.code === GH_EXIT_AUTH_REQUIRED) {
      return {
        failure: FAILURE_NOT_AUTHENTICATED,
        message: stderr || 'gh requires authentication — run `gh auth login`',
      };
    }
    return { failure: FAILURE_GH_ERROR, message: stderr || result.error.message };
  }

  try {
    return { data: JSON.parse(result.stdout) };
  } catch {
    const excerpt = String(result.stdout ?? '').trim().slice(0, STDOUT_EXCERPT_LENGTH);
    return {
      failure: FAILURE_GH_ERROR,
      message: `gh exited 0 but produced no JSON (stdout: ${excerpt || 'empty'})`,
    };
  }
}

/**
 * Reads app-level readiness out of a `gh auth status` invocation.
 *
 * @param {{error: ?Error, stdout: string, stderr: string}} result
 * @returns {?{failure: string, message: string}} null when gh is usable
 */
export function checkGhReadiness(result) {
  if (result.error?.code === 'ENOENT') {
    return {
      failure: FAILURE_CLI_MISSING,
      message: `the gh CLI was not found (tried "${GH_COMMAND}"; set GH_CLI_COMMAND to override)`,
    };
  }
  if (result.error) {
    const output = String(result.stderr || result.stdout || '').trim();
    return {
      failure: FAILURE_NOT_AUTHENTICATED,
      message: output || 'gh is not authenticated — run `gh auth login`',
    };
  }
  return null;
}

/**
 * Parses the command line.
 *
 * @param {string[]} args argv without node and script
 * @returns {{repo: ?string, milestone: ?string, labels: string[], json: boolean,
 *   help: boolean}|{error: string}}
 */
export function parseArgs(args) {
  const opts = { repo: null, milestone: null, labels: [], json: false, help: false };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--repo' || arg === '--milestone' || arg === '--label') {
      i += 1;
      if (args[i] === undefined) return { error: `missing value for ${arg}` };
      if (arg === '--repo') opts.repo = args[i];
      else if (arg === '--milestone') opts.milestone = args[i];
      else opts.labels.push(args[i]);
    } else if (arg.startsWith('-')) {
      return { error: `unknown option: ${arg}` };
    } else {
      return { error: `unexpected positional argument: ${arg} (the repo goes after --repo)` };
    }
  }

  if (opts.help) return opts;
  if (opts.repo === null) return { error: '--repo <owner>/<repo> is required' };
  if (!REPO_ARGUMENT.test(opts.repo)) {
    return { error: `--repo must look like <owner>/<repo>, got: ${opts.repo}` };
  }
  return opts;
}

/**
 * Describes the slice inside the repo, or null when the slice is the whole repo.
 *
 * @param {{milestone: ?string, labels: string[]}} opts parsed options
 * @returns {?string}
 */
export function describeScope(opts) {
  const parts = [];
  if (opts.milestone) parts.push(`milestone ${opts.milestone}`);
  for (const label of opts.labels) parts.push(`label ${label}`);
  return parts.length > 0 ? parts.join(' + ') : null;
}

function usage() {
  console.log(`Read GitHub Issues and emit normalized tickets for the wave planner.

Usage:
  node tickets-github.mjs --repo <owner>/<repo> [--milestone <n>] [--label <l>] [--json]

Options:
  --repo <owner>/<repo>  Repository to read (required)
  --milestone <n>        Narrow the scope to a milestone (number or title)
  --label <l>            Narrow the scope to a label (repeatable)
  --json                 Emit the ticket array as JSON on stdout (nothing else)
  -h, --help             Show this help

Without --milestone and --label the scope is EVERY issue in the repo, in every
state. The scope is always announced on stderr.

Dependencies come from two sources, unioned and de-duplicated:
  native   the GitHub issue dependency ("blocked by") shown in the issue sidebar
  marker   an anchored HTML comment in the body:
             <!-- blocked-by: #12, owner/repo#34 -->

Estimates come from the conventional label \`est:<n>\` (\`est:3\`, \`est:0.5\`).

Examples:
  node tickets-github.mjs --repo acme/api --milestone 7
  node tickets-github.mjs --repo acme/api --label waves --json

Exit codes:
  0 success   2 usage   3 gh CLI missing   4 GitHub unreachable or rate limited
  5 not authenticated or missing scope   6 repo not found or issues disabled
  7 gh error (truncated read included)    8 tickets emitted, data behind them bad`);
}

function fail(failure) {
  console.error(`! error: ${failure.failure}: ${failure.message}`);
  process.exit(EXIT_CODE_BY_FAILURE[failure.failure] ?? EXIT_GH_ERROR);
}

function runGh(args) {
  return new Promise((resolve) => {
    execFile(GH_COMMAND, args, { maxBuffer: GH_MAX_BUFFER_BYTES }, (error, stdout, stderr) => {
      resolve({ error, stdout, stderr });
    });
  });
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const current = next;
      next += 1;
      results[current] = await worker(items[current]);
    }
  });
  await Promise.all(runners);
  return results;
}

async function assertGhUsable() {
  const readiness = checkGhReadiness(await runGh(['auth', 'status']));
  if (readiness) fail(readiness);
}

async function listIssues(opts) {
  const args = [
    'issue',
    'list',
    '--repo',
    opts.repo,
    '--state',
    ALL_STATES,
    '--limit',
    String(ISSUE_FETCH_PROBE_LIMIT),
    '--json',
    ISSUE_LIST_FIELDS,
  ];
  if (opts.milestone) args.push('--milestone', opts.milestone);
  for (const label of opts.labels) args.push('--label', label);

  const classified = classifyGhResult(await runGh(args));
  if (classified.failure) {
    fail({ ...classified, message: `\`${GH_COMMAND} issue list\` failed: ${classified.message}` });
  }
  if (!Array.isArray(classified.data)) {
    fail({
      failure: FAILURE_GH_ERROR,
      message: `expected a JSON array from \`${GH_COMMAND} issue list\`, got ${typeof classified.data}`,
    });
  }
  if (classified.data.length > ISSUE_FETCH_LIMIT) {
    fail({
      failure: FAILURE_TRUNCATED,
      message: `more than ${ISSUE_FETCH_LIMIT} issues match this scope — narrow it with --milestone or --label instead of planning waves over a truncated repo`,
    });
  }
  return classified.data;
}

function announceScope(opts, count) {
  const slice = describeScope(opts);
  console.error(
    slice
      ? `scope: ${opts.repo}, ${slice} — ${count} issue(s), every state`
      : `scope: ${opts.repo}, THE WHOLE REPO (no --milestone, no --label) — ${count} issue(s), every state`,
  );
  if (count === 0) {
    console.error(
      'read succeeded and matched 0 issue(s) — an empty plan here means an empty scope, not a failed read',
    );
  }
}

// An external blocker we could not read still belongs in the registry: the
// dependent stays unschedulable and the unknown status keeps it open.
function unreadableExternal(id) {
  return {
    id,
    key: id,
    title: null,
    url: null,
    estimate: null,
    status: null,
    statusType: null,
    blockedBy: [],
    body: null,
    external: true,
    blockedBySources: {},
  };
}

async function readExternals(refs) {
  if (refs.length === 0) return { tickets: [], badData: [] };
  console.error(`reading ${refs.length} blocker(s) outside the scope...`);
  const badData = [];

  const tickets = await mapWithConcurrency(refs, EXTERNAL_FETCH_CONCURRENCY, async (id) => {
    const { repo, number } = splitCanonicalId(id);
    const classified = classifyGhResult(
      await runGh(['issue', 'view', String(number), '--repo', repo, '--json', ISSUE_VIEW_FIELDS]),
    );
    if (classified.failure) {
      console.error(`! could not read external blocker ${id}: ${classified.message}`);
      return unreadableExternal(id);
    }
    if (refFromUrl(classified.data?.url) === null) {
      badData.push({
        id,
        kind: BAD_DATA_BLOCKER_NOT_AN_ISSUE,
        detail: `blocker ${id} is not an issue (${classified.data?.url ?? 'no URL'}) — a pull request cannot be read as a blocker`,
      });
      return unreadableExternal(id);
    }
    return normalizeIssue(classified.data, { repo, external: true });
  });

  return { tickets, badData };
}

function renderSummary(opts, tickets) {
  const owned = tickets.filter((ticket) => !ticket.external);
  const externals = tickets.filter((ticket) => ticket.external);
  const labelOf = (id) => tickets.find((ticket) => ticket.id === id)?.key ?? id;
  const slice = describeScope(opts);
  const lines = [
    `repo: ${opts.repo} (${slice ?? 'whole repo'})`,
    `tickets: ${owned.length} in scope, ${externals.length} blocker(s) outside it`,
    '',
  ];

  for (const ticket of owned) {
    const blockers =
      ticket.blockedBy.length > 0
        ? ticket.blockedBy
            .map((id) => `${labelOf(id)} [${ticket.blockedBySources[id]}]`)
            .join(', ')
        : '-';
    lines.push(
      `${String(ticket.key).padEnd(KEY_COLUMN_WIDTH)}` +
        `${String(ticket.status ?? '?').padEnd(STATUS_COLUMN_WIDTH)}` +
        `est ${ticket.estimate ?? '-'}   blockedBy: ${blockers}`,
    );
  }
  for (const ticket of externals) {
    lines.push(
      `${String(ticket.key).padEnd(KEY_COLUMN_WIDTH)}` +
        `${String(ticket.status ?? '?').padEnd(STATUS_COLUMN_WIDTH)}external`,
    );
  }
  return lines.join('\n');
}

function reportTruncations(truncations) {
  const detail = truncations
    .map((entry) => `${entry.id} (${entry.returned} of ${entry.totalCount})`)
    .join(', ');
  fail({
    failure: FAILURE_TRUNCATED,
    message: `GitHub returned fewer blockers than it counted — the relation connection caps at ${GH_RELATION_NODE_CAP} nodes per issue and a truncated graph produces a wrong wave plan: ${detail}`,
  });
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.error) {
    console.error(`! error: ${opts.error}`);
    console.error('');
    usage();
    process.exit(EXIT_USAGE);
  }
  if (opts.help) {
    usage();
    return;
  }

  await assertGhUsable();
  const issues = await listIssues(opts);
  announceScope(opts, issues.length);

  const normalized = normalizeIssues(issues, { repo: opts.repo });
  if (normalized.truncations.length > 0) reportTruncations(normalized.truncations);

  const externals = await readExternals(normalized.externalRefs);
  const tickets = [...normalized.tickets, ...externals.tickets];

  console.log(opts.json ? JSON.stringify(tickets, null, 2) : renderSummary(opts, tickets));

  const badData = [...normalized.badData, ...externals.badData];
  for (const entry of badData) console.error(`! bad data: ${entry.id}: ${entry.detail}`);
  if (badData.length > 0) {
    console.error(
      `! ${badData.length} piece(s) of bad data — the tickets above are what could be read, not what was meant`,
    );
    process.exit(EXIT_BAD_DATA);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`! error: ${err.message}`);
    process.exit(EXIT_GH_ERROR);
  });
}
