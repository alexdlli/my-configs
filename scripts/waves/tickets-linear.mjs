#!/usr/bin/env node
// Read a Linear project through the `orca linear` CLI and emit the normalized
// ticket array the wave planner consumes:
//
//   { id, key, title, url, estimate, status, statusType, blockedBy, body, external }
//
// `blockedBy` comes from the real Linear relations (`orca linear issue
// --relations`), never from titles, numbering or ordering. Read-only: this
// script never creates, moves or comments on anything.
//
// Usage:
//   node tickets-linear.mjs <project-url-or-name> [--json] [--workspace <id>]
//   node tickets-linear.mjs -h | --help
//
// Exit codes: 0 success, 2 usage, 3 orca CLI missing, 4 Orca app unavailable,
// 5 Linear not connected, 6 project not found or ambiguous, 7 orca error.

import process from 'node:process';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// The Orca CLI is `orca-ide` on Linux and can be pinned by env; the orca-cli
// skill owns those resolution rules.
const ORCA_COMMAND = process.env.ORCA_CLI_COMMAND ?? 'orca';
const ORCA_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

const LINEAR_NOT_CONNECTED_CODE = 'linear_not_connected';
const ALL_WORKSPACES = 'all';

const PROJECT_SEARCH_LIMIT = 50;
const ISSUE_PAGE_LIMIT = 250;
const MAX_ISSUE_PAGES = 20;
const RELATION_FETCH_CONCURRENCY = 4;

const CURSOR_META_KEYS = ['nextCursor', 'cursor', 'endCursor'];

const ISSUE_KEY_FIELDS = ['identifier', 'key'];
const ISSUE_STATUS_FIELDS = ['state', 'status', 'workflowState'];
const ISSUE_BODY_FIELDS = ['description', 'body'];

const RELATION_CONTAINER_KEYS = ['relations', 'relationships'];
const RELATION_GROUP_KEYS = ['blockedBy', 'blocked_by', 'blockedByIssues'];
const RELATION_ISSUE_KEYS = ['issue', 'relatedIssue', 'related', 'target'];
const BLOCKED_BY_RELATION_TYPES = new Set(['blockedby', 'isblockedby']);

export const FAILURE_CLI_MISSING = 'cli-missing';
export const FAILURE_APP_UNAVAILABLE = 'app-unavailable';
export const FAILURE_LINEAR_NOT_CONNECTED = 'linear-not-connected';
export const FAILURE_PROJECT_NOT_FOUND = 'project-not-found';
export const FAILURE_PROJECT_AMBIGUOUS = 'project-ambiguous';
export const FAILURE_ORCA_ERROR = 'orca-error';

const EXIT_USAGE = 2;
const EXIT_CLI_MISSING = 3;
const EXIT_APP_UNAVAILABLE = 4;
const EXIT_LINEAR_NOT_CONNECTED = 5;
const EXIT_PROJECT_NOT_FOUND = 6;
const EXIT_ORCA_ERROR = 7;

const EXIT_CODE_BY_FAILURE = {
  [FAILURE_CLI_MISSING]: EXIT_CLI_MISSING,
  [FAILURE_APP_UNAVAILABLE]: EXIT_APP_UNAVAILABLE,
  [FAILURE_LINEAR_NOT_CONNECTED]: EXIT_LINEAR_NOT_CONNECTED,
  [FAILURE_PROJECT_NOT_FOUND]: EXIT_PROJECT_NOT_FOUND,
  [FAILURE_PROJECT_AMBIGUOUS]: EXIT_PROJECT_NOT_FOUND,
  [FAILURE_ORCA_ERROR]: EXIT_ORCA_ERROR,
};

const KEY_COLUMN_WIDTH = 12;
const STATUS_COLUMN_WIDTH = 14;

const PROJECT_URL_ID_SUFFIX = /-[0-9a-f]{8,}$/i;
const PROJECT_URL_TAIL_SEGMENTS = new Set([
  'overview',
  'issues',
  'documents',
  'updates',
  'activity',
  'settings',
]);

function unique(values) {
  return [...new Set(values)];
}

function firstPresentField(source, fields) {
  for (const field of fields) {
    const value = source?.[field];
    if (value !== undefined && value !== null) return value;
  }
  return null;
}

/**
 * Turns a project URL or name into the text to search the tracker with.
 *
 * @param {string} input project URL or name as typed by the user
 * @returns {string}
 */
export function deriveProjectQuery(input) {
  const raw = String(input).trim();
  if (!/^https?:\/\//i.test(raw)) return raw;
  let segments;
  try {
    segments = new URL(raw).pathname.split('/').filter(Boolean);
  } catch {
    return raw;
  }
  while (segments.length > 0 && PROJECT_URL_TAIL_SEGMENTS.has(segments.at(-1).toLowerCase())) {
    segments.pop();
  }
  const slug = segments.at(-1);
  if (!slug) return raw;
  return slug.replace(PROJECT_URL_ID_SUFFIX, '').replaceAll('-', ' ');
}

/**
 * Picks the single project the input refers to.
 *
 * @param {object[]} projects projects returned by `orca linear project list`
 * @param {string} input project URL or name as typed by the user
 * @returns {{project: object}|{failure: string, candidates: object[]}}
 */
export function matchProject(projects, input) {
  const raw = String(input).trim();
  const lowered = raw.toLowerCase();
  const query = deriveProjectQuery(raw).toLowerCase();
  const text = (value) => String(value ?? '').toLowerCase();

  const rounds = [
    (project) =>
      project.id === raw ||
      project.url === raw ||
      text(project.slugId) === lowered ||
      text(project.slug) === lowered ||
      text(project.name) === lowered,
    (project) => text(project.name) === query,
    (project) => text(project.name).includes(query) || text(project.url).includes(lowered),
  ];

  for (const matches of rounds) {
    const hits = projects.filter(matches);
    if (hits.length === 1) return { project: hits[0] };
    if (hits.length > 1) return { failure: FAILURE_PROJECT_AMBIGUOUS, candidates: hits };
  }
  return { failure: FAILURE_PROJECT_NOT_FOUND, candidates: projects };
}

/**
 * Reads the ids of the issues that block this one, from the real relations.
 *
 * @param {object} payload issue payload from `orca linear issue --relations`
 * @returns {string[]}
 */
export function extractBlockedBy(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const found = [];
  const containers = [payload, ...RELATION_CONTAINER_KEYS.map((key) => payload[key])];

  for (const container of containers) {
    if (!container || typeof container !== 'object') continue;
    if (Array.isArray(container)) {
      for (const entry of container) {
        if (!isBlockedByRelation(entry)) continue;
        const id = relationCounterpartId(entry);
        if (id) found.push(id);
      }
      continue;
    }
    for (const key of RELATION_GROUP_KEYS) {
      for (const ref of Array.isArray(container[key]) ? container[key] : []) {
        const id = issueRefId(ref);
        if (id) found.push(id);
      }
    }
  }
  return unique(found);
}

function isBlockedByRelation(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const type = String(entry.type ?? '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  return BLOCKED_BY_RELATION_TYPES.has(type);
}

function relationCounterpartId(entry) {
  for (const key of RELATION_ISSUE_KEYS) {
    const id = issueRefId(entry[key]);
    if (id) return id;
  }
  return null;
}

function issueRefId(ref) {
  if (typeof ref === 'string') return ref;
  if (!ref || typeof ref !== 'object') return null;
  const id = ref.id ?? ref.identifier ?? ref.key;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function readStatus(payload) {
  const state = firstPresentField(payload, ISSUE_STATUS_FIELDS);
  if (typeof state === 'string') return { status: state, statusType: null };
  if (state && typeof state === 'object') {
    return { status: state.name ?? null, statusType: state.type ?? null };
  }
  return { status: null, statusType: null };
}

/**
 * Maps an `orca linear` issue payload onto the normalized ticket shape.
 *
 * @param {object} payload issue payload
 * @param {{blockedBy?: string[], external?: boolean}} [options]
 * @returns {object} normalized ticket
 */
export function normalizeIssue(payload, options = {}) {
  const id = payload?.id;
  if (typeof id !== 'string' || id.length === 0) {
    const keys = Object.keys(payload ?? {}).join(', ') || 'none';
    throw new Error(`orca returned an issue without a string id (payload keys: ${keys})`);
  }
  const { status, statusType } = readStatus(payload);
  const external = options.external === true;
  return {
    id,
    key: firstPresentField(payload, ISSUE_KEY_FIELDS),
    title: payload.title ?? null,
    url: payload.url ?? null,
    estimate: payload.estimate ?? null,
    status,
    statusType,
    blockedBy: options.blockedBy ?? [],
    body: external ? null : firstPresentField(payload, ISSUE_BODY_FIELDS),
    external,
  };
}

/**
 * Classifies one `orca` invocation as usable output or a named failure.
 *
 * @param {{error: ?Error, stdout: string, stderr: string}} result
 * @returns {{envelope: object}|{failure: string, message: string, code?: string, nextSteps?: string[]}}
 */
export function classifyOrcaResult(result) {
  if (result.error?.code === 'ENOENT') {
    return {
      failure: FAILURE_CLI_MISSING,
      message: `the orca CLI was not found (tried "${ORCA_COMMAND}"; set ORCA_CLI_COMMAND to override)`,
    };
  }

  let envelope = null;
  try {
    envelope = JSON.parse(result.stdout);
  } catch {
    envelope = null;
  }

  if (envelope?.ok === true) return { envelope };
  if (envelope?.ok === false) {
    const code = envelope.error?.code ?? 'unknown';
    const message = envelope.error?.message ?? 'orca returned an error without a message';
    const nextSteps = envelope.error?.data?.nextSteps ?? [];
    const failure =
      code === LINEAR_NOT_CONNECTED_CODE ? FAILURE_LINEAR_NOT_CONNECTED : FAILURE_ORCA_ERROR;
    return { failure, message, code, nextSteps };
  }

  const output = (result.stderr || result.stdout || '').trim();
  return {
    failure: FAILURE_ORCA_ERROR,
    message: output || `orca produced no JSON output (${result.error?.message ?? 'unknown error'})`,
  };
}

/**
 * Reads app + runtime readiness out of an `orca status --json` envelope.
 *
 * @param {object} envelope successful status envelope
 * @returns {?{failure: string, message: string}} null when Orca is usable
 */
export function checkOrcaReadiness(envelope) {
  const app = envelope?.result?.app ?? {};
  const runtime = envelope?.result?.runtime ?? {};
  if (app.running !== true) {
    return {
      failure: FAILURE_APP_UNAVAILABLE,
      message: 'the Orca app is not running — start it with `orca open` and retry',
    };
  }
  if (runtime.reachable !== true) {
    return {
      failure: FAILURE_APP_UNAVAILABLE,
      message: `the Orca runtime is not reachable (state: ${runtime.state ?? 'unknown'})`,
    };
  }
  return null;
}

/**
 * Parses the command line.
 *
 * @param {string[]} args argv without node and script
 * @returns {{project: ?string, json: boolean, workspace: ?string, help: boolean}|{error: string}}
 */
export function parseArgs(args) {
  const opts = { project: null, json: false, workspace: null, help: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--workspace') {
      i += 1;
      if (args[i] === undefined) return { error: 'missing value for --workspace' };
      opts.workspace = args[i];
    } else if (arg.startsWith('-')) {
      return { error: `unknown option: ${arg}` };
    } else if (opts.project === null) {
      opts.project = arg;
    } else {
      return { error: `unexpected extra argument: ${arg}` };
    }
  }
  if (!opts.help && opts.project === null) {
    return { error: 'a project identifier (URL or name) is required' };
  }
  return opts;
}

function usage() {
  console.log(`Read a Linear project and emit normalized tickets for the wave planner.

Usage:
  node tickets-linear.mjs <project-url-or-name> [--json] [--workspace <id>]

Options:
  --json              Emit the ticket array as JSON on stdout (nothing else)
  --workspace <id>    Connected Linear workspace id (default: all)
  -h, --help          Show this help

Examples:
  node tickets-linear.mjs "Waves harness"
  node tickets-linear.mjs https://linear.app/acme/project/waves-harness-0a1b2c3d4e5f --json

Exit codes:
  0 success   2 usage   3 orca CLI missing   4 Orca app unavailable
  5 Linear not connected   6 project not found or ambiguous   7 orca error`);
}

function fail(failure) {
  console.error(`! error: ${failure.failure}: ${failure.message}`);
  for (const step of failure.nextSteps ?? []) console.error(`  next: ${step}`);
  process.exit(EXIT_CODE_BY_FAILURE[failure.failure] ?? EXIT_ORCA_ERROR);
}

function runOrca(args) {
  return new Promise((resolve) => {
    execFile(
      ORCA_COMMAND,
      args,
      { maxBuffer: ORCA_MAX_BUFFER_BYTES },
      (error, stdout, stderr) => {
        resolve({ error, stdout, stderr });
      },
    );
  });
}

async function orcaJson(args) {
  const classified = classifyOrcaResult(await runOrca(args));
  if (classified.failure) {
    fail({
      ...classified,
      message: `\`${ORCA_COMMAND} ${args.join(' ')}\` failed: ${classified.message}`,
    });
  }
  return classified.envelope;
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

function workspaceArgs(workspace, fallback) {
  const value = workspace ?? fallback;
  return value ? ['--workspace', value] : [];
}

async function assertOrcaUsable() {
  const statusResult = classifyOrcaResult(await runOrca(['status', '--json']));
  if (statusResult.failure) fail(statusResult);
  const readiness = checkOrcaReadiness(statusResult.envelope);
  if (readiness) fail(readiness);
}

async function assertLinearConnected(workspace) {
  const probe = classifyOrcaResult(
    await runOrca([
      'linear',
      'list-issues',
      '--limit',
      '1',
      ...workspaceArgs(workspace, null),
      '--json',
    ]),
  );
  if (probe.failure === FAILURE_LINEAR_NOT_CONNECTED) {
    fail({
      ...probe,
      message: 'Orca is running but Linear is not connected — connect it in Orca settings',
    });
  }
  if (probe.failure) fail(probe);
}

async function resolveProject(input, workspace) {
  const envelope = await orcaJson([
    'linear',
    'project',
    'list',
    '--query',
    deriveProjectQuery(input),
    '--limit',
    String(PROJECT_SEARCH_LIMIT),
    ...workspaceArgs(workspace, ALL_WORKSPACES),
    '--json',
  ]);
  const projects = envelope.result?.projects;
  if (!Array.isArray(projects)) {
    fail({
      failure: FAILURE_ORCA_ERROR,
      message: `expected result.projects from \`${ORCA_COMMAND} linear project list\`, got keys: ${Object.keys(envelope.result ?? {}).join(', ') || 'none'}`,
    });
  }

  const match = matchProject(projects, input);
  if (match.failure === FAILURE_PROJECT_AMBIGUOUS) {
    fail({
      failure: FAILURE_PROJECT_AMBIGUOUS,
      message: `"${input}" matches ${match.candidates.length} projects: ${match.candidates
        .map((project) => project.name ?? project.id)
        .join(', ')} — pass the project URL or the exact name`,
    });
  }
  if (match.failure) {
    const seen = projects.map((project) => project.name ?? project.id).join(', ') || 'none';
    fail({
      failure: FAILURE_PROJECT_NOT_FOUND,
      message: `no Linear project matches "${input}" (projects visible for this query: ${seen})`,
    });
  }
  return match.project;
}

async function listProjectIssues(project, workspace) {
  const issues = [];
  let cursor = null;

  for (let page = 0; page < MAX_ISSUE_PAGES; page += 1) {
    const args = [
      'linear',
      'list-issues',
      '--project',
      project.id ?? project.name,
      '--limit',
      String(ISSUE_PAGE_LIMIT),
      ...workspaceArgs(workspace, ALL_WORKSPACES),
      '--json',
    ];
    if (cursor) args.push('--cursor', cursor);

    const envelope = await orcaJson(args);
    const result = envelope.result ?? {};
    if (!Array.isArray(result.issues)) {
      fail({
        failure: FAILURE_ORCA_ERROR,
        message: `expected result.issues from \`${ORCA_COMMAND} linear list-issues\`, got keys: ${Object.keys(result).join(', ') || 'none'}`,
      });
    }
    issues.push(...result.issues);

    const meta = result.meta ?? {};
    if (meta.partial === true || (meta.workspaceErrors ?? []).length > 0) {
      fail({
        failure: FAILURE_ORCA_ERROR,
        message: `Linear returned a partial issue list for "${project.name ?? project.id}" — a wave plan built on it would lie (${JSON.stringify(meta.workspaceErrors ?? [])})`,
      });
    }
    if (meta.hasMore !== true) return issues;

    cursor = firstPresentField(meta, CURSOR_META_KEYS);
    if (!cursor) {
      fail({
        failure: FAILURE_ORCA_ERROR,
        message: 'Linear reports more issues than one page but returned no cursor — refusing to emit a truncated project',
      });
    }
  }

  fail({
    failure: FAILURE_ORCA_ERROR,
    message: `stopped after ${MAX_ISSUE_PAGES} pages of issues — refusing to emit a truncated project`,
  });
  return issues;
}

function issuePayload(envelope) {
  const result = envelope.result ?? {};
  return result.issue ?? result;
}

// An external blocker we could not read still belongs in the registry: the
// dependent stays unschedulable and the unknown status keeps it open.
function unreadableExternal(id) {
  return {
    id,
    key: null,
    title: null,
    url: null,
    estimate: null,
    status: null,
    statusType: null,
    blockedBy: [],
    body: null,
    external: true,
  };
}

async function readTickets(project, workspace) {
  const listed = await listProjectIssues(project, workspace);
  console.error(`reading relations for ${listed.length} issue(s)...`);

  const tickets = await mapWithConcurrency(listed, RELATION_FETCH_CONCURRENCY, async (issue) => {
    if (typeof issue.id !== 'string' || issue.id.length === 0) {
      fail({
        failure: FAILURE_ORCA_ERROR,
        message: `list-issues returned an issue without a string id (keys: ${Object.keys(issue ?? {}).join(', ') || 'none'})`,
      });
    }
    const envelope = await orcaJson([
      'linear',
      'issue',
      issue.id,
      '--relations',
      ...workspaceArgs(workspace, null),
      '--json',
    ]);
    const payload = issuePayload(envelope);
    return normalizeIssue({ ...issue, ...payload }, { blockedBy: extractBlockedBy(payload) });
  });

  const known = new Set();
  for (const ticket of tickets) {
    known.add(ticket.id);
    if (ticket.key) known.add(ticket.key);
  }
  const externalIds = unique(
    tickets.flatMap((ticket) => ticket.blockedBy).filter((id) => !known.has(id)),
  );

  const externals = await mapWithConcurrency(
    externalIds,
    RELATION_FETCH_CONCURRENCY,
    async (id) => {
      const classified = classifyOrcaResult(
        await runOrca(['linear', 'issue', id, ...workspaceArgs(workspace, null), '--json']),
      );
      if (classified.failure) {
        console.error(`! could not read external blocker ${id}: ${classified.message}`);
        return unreadableExternal(id);
      }
      return normalizeIssue(issuePayload(classified.envelope), { external: true });
    },
  );

  return [...tickets, ...externals];
}

function renderSummary(project, tickets) {
  const owned = tickets.filter((ticket) => !ticket.external);
  const externals = tickets.filter((ticket) => ticket.external);
  const labelOf = (id) => tickets.find((ticket) => ticket.id === id)?.key ?? id;
  const lines = [
    `project: ${project.name ?? project.id} (${project.id})`,
    `tickets: ${owned.length} in project, ${externals.length} external blocker(s)`,
    '',
  ];
  for (const ticket of owned) {
    const blockers = ticket.blockedBy.length > 0 ? ticket.blockedBy.map(labelOf).join(', ') : '-';
    lines.push(
      `${String(ticket.key ?? ticket.id).padEnd(KEY_COLUMN_WIDTH)}` +
        `${String(ticket.status ?? '?').padEnd(STATUS_COLUMN_WIDTH)}` +
        `est ${ticket.estimate ?? '-'}   blockedBy: ${blockers}`,
    );
  }
  for (const ticket of externals) {
    lines.push(
      `${String(ticket.key ?? ticket.id).padEnd(KEY_COLUMN_WIDTH)}` +
        `${String(ticket.status ?? '?').padEnd(STATUS_COLUMN_WIDTH)}external`,
    );
  }
  return lines.join('\n');
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

  await assertOrcaUsable();
  await assertLinearConnected(opts.workspace);
  const project = await resolveProject(opts.project, opts.workspace);
  const tickets = await readTickets(project, opts.workspace);

  console.log(opts.json ? JSON.stringify(tickets, null, 2) : renderSummary(project, tickets));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`! error: ${err.message}`);
    process.exit(EXIT_ORCA_ERROR);
  });
}
