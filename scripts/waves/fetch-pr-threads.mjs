#!/usr/bin/env node
// fetch-pr-threads.mjs — every feedback surface of a pull request in one JSON
// document, plus the fingerprint that says whether the feedback changed.
//
// GitHub scatters PR feedback across three endpoints, and reading only one of
// them loses whole conversations:
//
//   issues/<n>/comments   top-level comments on the PR conversation
//   pulls/<n>/reviews     submitted reviews (APPROVED / CHANGES_REQUESTED / ...)
//   pulls/<n>/comments    inline comments anchored to a file and line
//
// The fingerprint hashes ids *and* update timestamps across all three, so an
// edited comment produces a new fingerprint even though no id changed and no
// commit was pushed. That is the whole point: new feedback arrives without a
// new SHA, so the SHA alone can never tell you the review state is stale.
//
// `isResolved` / `isOutdated` do not exist in the REST payloads; they only come
// from the GraphQL `reviewThreads` connection. When GraphQL is unavailable the
// output says so (`resolutionSource: "unavailable"`, `resolved: null`) instead
// of pretending every thread is open.
//
// The consumer is the `pr-triage` agent, which has no Bash on purpose. This
// file is its only data path, so it carries the full body, author and anchor of
// every comment — nothing here may require a follow-up command to interpret.
//
// Usage:
//   node scripts/waves/fetch-pr-threads.mjs <number|url|branch> [--repo owner/name]
//                                           [--out threads.json] [--compact]
//
// Exit codes are the shared wave table from gh.mjs.
//
// Zero deps, Node stdlib only (repo convention). Read-only: it never posts,
// resolves or replies to anything.

import { createHash } from 'node:crypto';
import { realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  EXIT_GH_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  classifyGhFailure,
  gh,
  repoFromPullUrl,
} from './gh.mjs';

const SCHEMA = 'wave.pr-threads/1';

export const SURFACE_ISSUE_COMMENT = 'issue-comment';
export const SURFACE_REVIEW = 'review';
export const SURFACE_INLINE = 'inline';

export const RESOLUTION_FROM_GRAPHQL = 'graphql';
export const RESOLUTION_UNAVAILABLE = 'unavailable';

const REST_PAGE_SIZE = 100;
const GRAPHQL_THREADS_PER_PAGE = 100;
const GRAPHQL_COMMENTS_PER_THREAD = 100;
const GRAPHQL_MAX_PAGES = 20;
// A CodeRabbit review body can run to tens of thousands of characters. The
// triage agent still needs the text, so we cut rather than drop, and say so.
const MAX_BODY_CHARS = 20000;

const PR_VIEW_FIELDS = 'number,url,title,state,isDraft,author,headRefName,headRefOid,reviewDecision';

const REVIEW_THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviewThreads(first:${GRAPHQL_THREADS_PER_PAGE},after:$cursor){
        pageInfo{hasNextPage endCursor}
        nodes{
          id isResolved isOutdated isCollapsed path line startLine originalLine diffSide
          comments(first:${GRAPHQL_COMMENTS_PER_THREAD}){nodes{databaseId}}
        }
      }
    }
  }
}`;

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

function updatedAtOf(entry) {
  return entry.updated_at || entry.submitted_at || entry.created_at || '';
}

/**
 * Stable hash over ids + update timestamps of the three REST surfaces. Sorted
 * so pagination order, which GitHub does not guarantee, cannot move it.
 */
export function computeFingerprint(surfaces) {
  const lines = [];
  for (const [surface, entries] of Object.entries(surfaces)) {
    for (const entry of entries) {
      lines.push(`${surface}\t${entry.id}\t${updatedAtOf(entry)}`);
    }
  }
  lines.sort();
  return `sha256:${createHash('sha256').update(lines.join('\n')).digest('hex')}`;
}

export function buildReviewKey({ branch, sha, fingerprint }) {
  return `${branch ?? '?'}@${sha ?? '?'}#${fingerprint}`;
}

function clampBody(body) {
  const text = typeof body === 'string' ? body : '';
  if (text.length <= MAX_BODY_CHARS) return { body: text, bodyTruncated: false };
  return { body: text.slice(0, MAX_BODY_CHARS), bodyTruncated: true };
}

function isBot(user) {
  return user?.type === 'Bot' || /\[bot\]$/i.test(user?.login ?? '');
}

function person(user) {
  return { author: user?.login ?? null, authorIsBot: isBot(user) };
}

function threadRootId(comment, byId) {
  let current = comment;
  const seen = new Set([current.id]);
  while (current.in_reply_to_id && byId.has(current.in_reply_to_id)) {
    const parent = byId.get(current.in_reply_to_id);
    if (seen.has(parent.id)) break;
    seen.add(parent.id);
    current = parent;
  }
  return current.id;
}

function replyOf(comment) {
  return {
    id: comment.id,
    ...person(comment.user),
    ...clampBody(comment.body),
    createdAt: comment.created_at ?? null,
    updatedAt: updatedAtOf(comment),
    url: comment.html_url ?? null,
  };
}

/**
 * Fold the three REST surfaces (plus whatever resolution metadata GraphQL gave
 * us) into a single list the triage agent can walk top to bottom.
 */
export function buildThreads({
  issueComments = [],
  reviews = [],
  inlineComments = [],
  resolutionByCommentId = new Map(),
  resolutionAvailable = false,
}) {
  const threads = [];

  for (const comment of issueComments) {
    threads.push({
      surface: SURFACE_ISSUE_COMMENT,
      id: `${SURFACE_ISSUE_COMMENT}:${comment.id}`,
      ...person(comment.user),
      reviewState: null,
      resolved: null,
      outdated: null,
      resolutionAvailable: false,
      anchor: null,
      createdAt: comment.created_at ?? null,
      updatedAt: updatedAtOf(comment),
      url: comment.html_url ?? null,
      ...clampBody(comment.body),
      replies: [],
    });
  }

  for (const review of reviews) {
    const hasSubstance = (review.body || '').trim().length > 0;
    const carriesVerdict = review.state && review.state !== 'COMMENTED';
    // A COMMENTED review with an empty body is just the envelope GitHub wraps
    // inline comments in; its inline children are already their own threads.
    if (!hasSubstance && !carriesVerdict) continue;
    threads.push({
      surface: SURFACE_REVIEW,
      id: `${SURFACE_REVIEW}:${review.id}`,
      ...person(review.user),
      reviewState: review.state ?? null,
      resolved: null,
      outdated: null,
      resolutionAvailable: false,
      anchor: null,
      createdAt: review.submitted_at ?? null,
      updatedAt: updatedAtOf(review),
      url: review.html_url ?? null,
      ...clampBody(review.body),
      replies: [],
    });
  }

  const byId = new Map(inlineComments.map((comment) => [comment.id, comment]));
  const repliesByRoot = new Map();
  const roots = [];
  for (const comment of inlineComments) {
    const rootId = threadRootId(comment, byId);
    if (rootId === comment.id) {
      roots.push(comment);
      continue;
    }
    if (!repliesByRoot.has(rootId)) repliesByRoot.set(rootId, []);
    repliesByRoot.get(rootId).push(comment);
  }

  for (const root of roots) {
    const resolution = resolutionByCommentId.get(root.id) ?? null;
    const replies = (repliesByRoot.get(root.id) ?? [])
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      .map(replyOf);
    threads.push({
      surface: SURFACE_INLINE,
      id: `${SURFACE_INLINE}:${root.id}`,
      threadId: resolution?.threadId ?? null,
      ...person(root.user),
      reviewState: null,
      resolved: resolution ? resolution.isResolved : null,
      outdated: resolution ? resolution.isOutdated : null,
      resolutionAvailable: Boolean(resolutionAvailable && resolution),
      anchor: {
        path: root.path ?? null,
        line: root.line ?? null,
        startLine: root.start_line ?? null,
        originalLine: root.original_line ?? null,
        side: root.side ?? null,
        diffHunk: root.diff_hunk ?? null,
      },
      createdAt: root.created_at ?? null,
      updatedAt: updatedAtOf(root),
      url: root.html_url ?? null,
      ...clampBody(root.body),
      replies,
    });
  }

  threads.sort(
    (a, b) =>
      String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)),
  );
  return threads;
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

function die(exitCode, message) {
  process.stderr.write(`fetch-pr-threads: ${message}\n`);
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

function ghApiList(endpoint) {
  const value = ghJson(['api', '--paginate', `${endpoint}?per_page=${REST_PAGE_SIZE}`]);
  if (!Array.isArray(value)) {
    die(EXIT_GH_FAILED, `expected a list from ${endpoint}`);
  }
  return value;
}

// Resolution state lives only in GraphQL. If this fails the caller degrades to
// "unknown" rather than guessing, so the failure is returned, never thrown.
function fetchResolution({ owner, name, number }) {
  const byCommentId = new Map();
  let cursor = null;

  for (let page = 0; page < GRAPHQL_MAX_PAGES; page += 1) {
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${REVIEW_THREADS_QUERY}`,
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${name}`,
      '-F',
      `number=${number}`,
    ];
    if (cursor) args.push('-f', `cursor=${cursor}`);

    const result = gh(args);
    if (!result.ok) {
      return { available: false, byCommentId, error: result.stderr || `gh exited ${result.code}` };
    }
    let payload;
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      return { available: false, byCommentId, error: 'GraphQL response was not JSON' };
    }
    if (payload.errors?.length) {
      return { available: false, byCommentId, error: payload.errors[0].message };
    }
    const connection = payload.data?.repository?.pullRequest?.reviewThreads;
    if (!connection) {
      return { available: false, byCommentId, error: 'GraphQL response had no reviewThreads' };
    }
    for (const node of connection.nodes ?? []) {
      for (const comment of node.comments?.nodes ?? []) {
        if (comment.databaseId == null) continue;
        byCommentId.set(comment.databaseId, {
          threadId: node.id,
          isResolved: node.isResolved,
          isOutdated: node.isOutdated,
        });
      }
    }
    if (!connection.pageInfo?.hasNextPage) {
      return { available: true, byCommentId, error: null };
    }
    cursor = connection.pageInfo.endCursor;
  }
  return {
    available: false,
    byCommentId,
    error: `more than ${GRAPHQL_MAX_PAGES} pages of review threads`,
  };
}

function parseArgs(argv) {
  const options = { ref: null, repo: null, out: null, compact: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repo' || arg === '-R') {
      options.repo = argv[i + 1];
      i += 1;
    } else if (arg === '--out') {
      options.out = argv[i + 1];
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

const USAGE = `usage: fetch-pr-threads.mjs <number|url|branch> [--repo owner/name] [--out path] [--compact]

Emits every feedback surface of a PR plus the fingerprint that detects edited or
new feedback. Writes to stdout unless --out is given.`;

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(EXIT_OK);
  }
  if (!options.ref) die(EXIT_USAGE, USAGE);

  const repoArgs = options.repo ? ['--repo', options.repo] : [];
  const pr = ghJson(['pr', 'view', options.ref, ...repoArgs, '--json', PR_VIEW_FIELDS]);
  const slug = options.repo || repoFromPullUrl(pr.url);
  if (!slug) die(EXIT_GH_FAILED, 'could not resolve owner/name — pass --repo');
  const [owner, name] = slug.split('/');
  const number = pr.number;

  const issueComments = ghApiList(`repos/${slug}/issues/${number}/comments`);
  const reviews = ghApiList(`repos/${slug}/pulls/${number}/reviews`);
  const inlineComments = ghApiList(`repos/${slug}/pulls/${number}/comments`);

  const resolution = fetchResolution({ owner, name, number });
  const notes = [];
  if (!resolution.available) {
    notes.push(
      `thread resolution unavailable (${resolution.error}) — "resolved" is null on every thread; do NOT read that as open or as resolved`,
    );
  }

  const fingerprint = computeFingerprint({
    [SURFACE_ISSUE_COMMENT]: issueComments,
    [SURFACE_REVIEW]: reviews,
    [SURFACE_INLINE]: inlineComments,
  });

  const threads = buildThreads({
    issueComments,
    reviews,
    inlineComments,
    resolutionByCommentId: resolution.byCommentId,
    resolutionAvailable: resolution.available,
  });

  const output = {
    schema: SCHEMA,
    repo: slug,
    number,
    url: pr.url ?? null,
    title: pr.title ?? null,
    state: pr.state ?? null,
    isDraft: pr.isDraft ?? null,
    branch: pr.headRefName ?? null,
    sha: pr.headRefOid ?? null,
    reviewDecision: pr.reviewDecision || null,
    fetchedAt: new Date().toISOString(),
    fingerprint,
    reviewKey: buildReviewKey({
      branch: pr.headRefName ?? null,
      sha: pr.headRefOid ?? null,
      fingerprint,
    }),
    resolutionSource: resolution.available ? RESOLUTION_FROM_GRAPHQL : RESOLUTION_UNAVAILABLE,
    counts: {
      issueComments: issueComments.length,
      reviews: reviews.length,
      inlineComments: inlineComments.length,
      threads: threads.length,
      unresolvedInline: threads.filter(
        (thread) => thread.surface === SURFACE_INLINE && thread.resolved === false,
      ).length,
      changesRequested: threads.filter((thread) => thread.reviewState === 'CHANGES_REQUESTED').length,
    },
    untrustedFields: ['threads[].body', 'threads[].replies[].body', 'threads[].author'],
    notes,
    threads,
  };

  const json = JSON.stringify(output, null, options.compact ? 0 : 2);
  if (options.out) {
    writeFileSync(options.out, `${json}\n`);
    process.stdout.write(`${options.out}\n`);
  } else {
    process.stdout.write(`${json}\n`);
  }
  process.exit(EXIT_OK);
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
