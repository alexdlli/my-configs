import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SURFACE_INLINE,
  SURFACE_ISSUE_COMMENT,
  SURFACE_REVIEW,
  buildReviewKey,
  buildThreads,
  computeFingerprint,
} from './fetch-pr-threads.mjs';

const PR_URL = 'https://github.com/octo/harness/pull/7';
const AUTHOR = 'octocat';
const BRANCH = 'feat/x';
const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FINGERPRINT = 'sha256:deadbeef';

const EARLY_AT = '2024-03-01T09:00:00Z';
const MIDDLE_AT = '2024-03-01T10:00:00Z';
const LATE_AT = '2024-03-01T11:00:00Z';

const ANCHOR_PATH = 'scripts/waves/graph.mjs';
const ANCHOR_LINE = 12;
const ANCHOR_START_LINE = 10;
const ANCHOR_ORIGINAL_LINE = 11;
const ANCHOR_SIDE = 'RIGHT';
const ANCHOR_DIFF_HUNK = '@@ -10,3 +10,4 @@';

const GRAPHQL_THREAD_ID = 'PRRT_1';

const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;

const MAX_BODY_CHARS = 20000;

const ISSUE_COMMENT_BODY = 'issue comment body';
const REVIEW_BODY = 'review body';
const ROOT_BODY = 'root body';
const REPLY_BODY = 'reply body';

const BOT_LOGIN_WITHOUT_SUFFIX = 'copilot-like';
const BOT_LOGIN_WITH_SUFFIX = 'bot-x[bot]';

const ghUser = (login) => ({ login, type: 'User' });
const ghBotUser = (login) => ({ login, type: 'Bot' });

function ghIssueComment(id, overrides = {}) {
  const createdAt = overrides.created_at ?? EARLY_AT;
  return {
    id,
    user: ghUser(AUTHOR),
    body: `issue comment ${id}`,
    created_at: createdAt,
    updated_at: createdAt,
    html_url: `${PR_URL}#issuecomment-${id}`,
    ...overrides,
  };
}

function ghReview(id, overrides = {}) {
  return {
    id,
    user: ghUser(AUTHOR),
    body: '',
    state: 'COMMENTED',
    submitted_at: EARLY_AT,
    html_url: `${PR_URL}#pullrequestreview-${id}`,
    ...overrides,
  };
}

function ghInlineComment(id, overrides = {}) {
  const createdAt = overrides.created_at ?? EARLY_AT;
  return {
    id,
    user: ghUser(AUTHOR),
    body: `inline comment ${id}`,
    created_at: createdAt,
    updated_at: createdAt,
    html_url: `${PR_URL}#discussion_r${id}`,
    path: ANCHOR_PATH,
    line: ANCHOR_LINE,
    start_line: ANCHOR_START_LINE,
    original_line: ANCHOR_ORIGINAL_LINE,
    side: ANCHOR_SIDE,
    diff_hunk: ANCHOR_DIFF_HUNK,
    ...overrides,
  };
}

test('a new updated_at moves the fingerprint even when the id does not change', () => {
  const before = computeFingerprint({ [SURFACE_REVIEW]: [{ id: 1, updated_at: EARLY_AT }] });
  const after = computeFingerprint({ [SURFACE_REVIEW]: [{ id: 1, updated_at: LATE_AT }] });
  assert.notEqual(before, after);
});

test('a new id moves the fingerprint even when the timestamp does not change', () => {
  assert.notEqual(
    computeFingerprint({ [SURFACE_INLINE]: [{ id: 1, updated_at: EARLY_AT }] }),
    computeFingerprint({ [SURFACE_INLINE]: [{ id: 2, updated_at: EARLY_AT }] }),
  );
});

test('the fingerprint ignores the order the entries arrive in', () => {
  const first = { id: 1, updated_at: EARLY_AT };
  const second = { id: 2, updated_at: LATE_AT };
  assert.equal(
    computeFingerprint({ [SURFACE_INLINE]: [first, second] }),
    computeFingerprint({ [SURFACE_INLINE]: [second, first] }),
  );
});

test('the fingerprint ignores the order the surfaces arrive in', () => {
  const inline = { id: 1, updated_at: EARLY_AT };
  const review = { id: 2, updated_at: LATE_AT };
  assert.equal(
    computeFingerprint({ [SURFACE_INLINE]: [inline], [SURFACE_REVIEW]: [review] }),
    computeFingerprint({ [SURFACE_REVIEW]: [review], [SURFACE_INLINE]: [inline] }),
  );
});

test('the same id on two surfaces does not collide', () => {
  const entry = { id: 1, updated_at: EARLY_AT };
  assert.notEqual(
    computeFingerprint({ [SURFACE_ISSUE_COMMENT]: [entry] }),
    computeFingerprint({ [SURFACE_REVIEW]: [entry] }),
  );
});

test('the timestamp falls back from updated_at to submitted_at to created_at to empty', () => {
  const fingerprintOf = (entry) => computeFingerprint({ [SURFACE_REVIEW]: [entry] });
  const fromUpdated = fingerprintOf({ id: 1, updated_at: MIDDLE_AT });

  assert.equal(fingerprintOf({ id: 1, submitted_at: MIDDLE_AT }), fromUpdated);
  assert.equal(fingerprintOf({ id: 1, created_at: MIDDLE_AT }), fromUpdated);
  assert.equal(
    fingerprintOf({ id: 1, updated_at: MIDDLE_AT, submitted_at: EARLY_AT, created_at: LATE_AT }),
    fromUpdated,
  );
  assert.equal(
    fingerprintOf({ id: 1, submitted_at: MIDDLE_AT, created_at: LATE_AT }),
    fromUpdated,
  );
  assert.equal(fingerprintOf({ id: 1 }), fingerprintOf({ id: 1, updated_at: '' }));
  assert.notEqual(fingerprintOf({ id: 1 }), fromUpdated);
});

test('no surfaces at all still hashes to a fingerprint', () => {
  const empty = computeFingerprint({});
  assert.match(empty, FINGERPRINT_PATTERN);
  assert.equal(computeFingerprint({}), empty);
  assert.equal(computeFingerprint({ [SURFACE_ISSUE_COMMENT]: [] }), empty);
});

test('the same three surfaces hash the same twice in a row', () => {
  const surfaces = () => ({
    [SURFACE_ISSUE_COMMENT]: [{ id: 1, updated_at: EARLY_AT }],
    [SURFACE_REVIEW]: [{ id: 2, submitted_at: MIDDLE_AT }],
    [SURFACE_INLINE]: [{ id: 3, created_at: LATE_AT }, { id: 4, updated_at: LATE_AT }],
  });
  const first = computeFingerprint(surfaces());
  assert.match(first, FINGERPRINT_PATTERN);
  assert.equal(computeFingerprint(surfaces()), first);
});

test('a missing branch or sha becomes ? and the review key still forms', () => {
  assert.equal(
    buildReviewKey({ branch: BRANCH, sha: SHA, fingerprint: FINGERPRINT }),
    `${BRANCH}@${SHA}#${FINGERPRINT}`,
  );
  assert.equal(
    buildReviewKey({ branch: null, sha: undefined, fingerprint: FINGERPRINT }),
    `?@?#${FINGERPRINT}`,
  );
});

test('an inline reply lands under its root instead of becoming a thread of its own', () => {
  const threads = buildThreads({
    inlineComments: [
      ghInlineComment(1),
      ghInlineComment(2, { in_reply_to_id: 1, created_at: MIDDLE_AT }),
    ],
  });
  assert.equal(threads.length, 1);
  assert.equal(threads[0].id, `${SURFACE_INLINE}:1`);
  assert.equal(threads[0].surface, SURFACE_INLINE);
  assert.deepEqual(
    threads[0].replies.map((reply) => reply.id),
    [2],
  );
  assert.equal(threads[0].replies[0].author, AUTHOR);
  assert.equal(threads[0].replies[0].createdAt, MIDDLE_AT);
});

test('with two roots on the page a reply joins its own root and leaves the other empty', () => {
  const threads = buildThreads({
    inlineComments: [
      ghInlineComment(1),
      ghInlineComment(2),
      ghInlineComment(3, { in_reply_to_id: 2, created_at: MIDDLE_AT }),
    ],
  });
  assert.equal(threads.length, 2);
  assert.deepEqual(
    threads.map((thread) => thread.id),
    [`${SURFACE_INLINE}:1`, `${SURFACE_INLINE}:2`],
  );
  assert.deepEqual(threads[0].replies, []);
  assert.deepEqual(
    threads[1].replies.map((reply) => reply.id),
    [3],
  );
});

test('a three-level reply chain collapses onto the root', () => {
  const threads = buildThreads({
    inlineComments: [
      ghInlineComment(1),
      ghInlineComment(2, { in_reply_to_id: 1, created_at: MIDDLE_AT }),
      ghInlineComment(3, { in_reply_to_id: 2, created_at: LATE_AT }),
    ],
  });
  assert.equal(threads.length, 1);
  assert.equal(threads[0].id, `${SURFACE_INLINE}:1`);
  assert.deepEqual(
    threads[0].replies.map((reply) => reply.id),
    [2, 3],
  );
});

test('replies come out in created_at order, not payload order', () => {
  const threads = buildThreads({
    inlineComments: [
      ghInlineComment(1),
      ghInlineComment(2, { in_reply_to_id: 1, created_at: LATE_AT }),
      ghInlineComment(3, { in_reply_to_id: 1, created_at: MIDDLE_AT }),
    ],
  });
  assert.deepEqual(
    threads[0].replies.map((reply) => reply.id),
    [3, 2],
  );
});

test('an empty COMMENTED review is dropped as the envelope it is', () => {
  assert.deepEqual(buildThreads({ reviews: [ghReview(1)] }), []);
});

test('an empty CHANGES_REQUESTED review is kept because the verdict is the content', () => {
  const threads = buildThreads({ reviews: [ghReview(1, { state: 'CHANGES_REQUESTED' })] });
  assert.equal(threads.length, 1);
  assert.equal(threads[0].id, `${SURFACE_REVIEW}:1`);
  assert.equal(threads[0].surface, SURFACE_REVIEW);
  assert.equal(threads[0].reviewState, 'CHANGES_REQUESTED');
  assert.equal(threads[0].createdAt, EARLY_AT);
});

test('an issue-comment thread carries the comment body and its permalink', () => {
  const threads = buildThreads({
    issueComments: [ghIssueComment(1, { body: ISSUE_COMMENT_BODY })],
  });
  assert.equal(threads[0].body, ISSUE_COMMENT_BODY);
  assert.equal(threads[0].url, `${PR_URL}#issuecomment-1`);
});

test('a review thread carries the review body and its permalink', () => {
  const threads = buildThreads({ reviews: [ghReview(2, { body: REVIEW_BODY })] });
  assert.equal(threads[0].body, REVIEW_BODY);
  assert.equal(threads[0].url, `${PR_URL}#pullrequestreview-2`);
});

test('an inline thread carries the body and permalink of its root and of its reply', () => {
  const threads = buildThreads({
    inlineComments: [
      ghInlineComment(3, { body: ROOT_BODY }),
      ghInlineComment(4, { in_reply_to_id: 3, created_at: MIDDLE_AT, body: REPLY_BODY }),
    ],
  });
  assert.equal(threads[0].body, ROOT_BODY);
  assert.equal(threads[0].url, `${PR_URL}#discussion_r3`);
  assert.equal(threads[0].replies[0].body, REPLY_BODY);
  assert.equal(threads[0].replies[0].url, `${PR_URL}#discussion_r4`);
});

test('a body past the clamp is cut to the limit and flagged as truncated', () => {
  const threads = buildThreads({
    issueComments: [ghIssueComment(1, { body: 'x'.repeat(MAX_BODY_CHARS + 1) })],
  });
  assert.equal(threads[0].body.length, MAX_BODY_CHARS);
  assert.equal(threads[0].bodyTruncated, true);
});

test('a body exactly at the clamp is kept whole and not flagged', () => {
  const threads = buildThreads({
    issueComments: [ghIssueComment(1, { body: 'x'.repeat(MAX_BODY_CHARS) })],
  });
  assert.equal(threads[0].body.length, MAX_BODY_CHARS);
  assert.equal(threads[0].bodyTruncated, false);
});

test('a Bot account is flagged even when the login has no [bot] suffix', () => {
  const threads = buildThreads({
    issueComments: [ghIssueComment(1, { user: ghBotUser(BOT_LOGIN_WITHOUT_SUFFIX) })],
  });
  assert.equal(threads[0].author, BOT_LOGIN_WITHOUT_SUFFIX);
  assert.equal(threads[0].authorIsBot, true);
});

test('a [bot] login is flagged even when the account type says User', () => {
  const threads = buildThreads({
    issueComments: [ghIssueComment(1, { user: ghUser(BOT_LOGIN_WITH_SUFFIX) })],
  });
  assert.equal(threads[0].author, BOT_LOGIN_WITH_SUFFIX);
  assert.equal(threads[0].authorIsBot, true);
});

test('a human author is not flagged as a bot', () => {
  const threads = buildThreads({ issueComments: [ghIssueComment(1)] });
  assert.equal(threads[0].author, AUTHOR);
  assert.equal(threads[0].authorIsBot, false);
});

test('an inline thread carries the file position under camelCase names', () => {
  const threads = buildThreads({ inlineComments: [ghInlineComment(1)] });
  assert.equal(threads.length, 1);
  assert.deepEqual(threads[0].anchor, {
    path: ANCHOR_PATH,
    line: ANCHOR_LINE,
    startLine: ANCHOR_START_LINE,
    originalLine: ANCHOR_ORIGINAL_LINE,
    side: ANCHOR_SIDE,
    diffHunk: ANCHOR_DIFF_HUNK,
  });
});

test('a single-line inline comment keeps startLine null instead of borrowing another line', () => {
  const threads = buildThreads({ inlineComments: [ghInlineComment(2, { start_line: null })] });
  assert.equal(threads.length, 1);
  assert.deepEqual(threads[0].anchor, {
    path: ANCHOR_PATH,
    line: ANCHOR_LINE,
    startLine: null,
    originalLine: ANCHOR_ORIGINAL_LINE,
    side: ANCHOR_SIDE,
    diffHunk: ANCHOR_DIFF_HUNK,
  });
});

test('without GraphQL resolution an inline thread says unknown, not resolved', () => {
  const threads = buildThreads({ inlineComments: [ghInlineComment(1)] });
  assert.equal(threads.length, 1);
  assert.equal(threads[0].resolved, null);
  assert.equal(threads[0].outdated, null);
  assert.equal(threads[0].threadId, null);
  assert.equal(threads[0].resolutionAvailable, false);
});

test('a GraphQL resolution reaches the inline thread whose root it names', () => {
  const threads = buildThreads({
    inlineComments: [ghInlineComment(1)],
    resolutionByCommentId: new Map([
      [1, { threadId: GRAPHQL_THREAD_ID, isResolved: true, isOutdated: false }],
    ]),
    resolutionAvailable: true,
  });
  assert.equal(threads.length, 1);
  assert.equal(threads[0].resolved, true);
  assert.equal(threads[0].outdated, false);
  assert.equal(threads[0].threadId, GRAPHQL_THREAD_ID);
  assert.equal(threads[0].resolutionAvailable, true);
});

test('an open thread GraphQL answered for says false, which is not the same as unknown', () => {
  const threads = buildThreads({
    inlineComments: [ghInlineComment(1)],
    resolutionByCommentId: new Map([
      [1, { threadId: GRAPHQL_THREAD_ID, isResolved: false, isOutdated: false }],
    ]),
    resolutionAvailable: true,
  });
  assert.equal(threads.length, 1);
  assert.equal(threads[0].resolved, false);
  assert.equal(threads[0].outdated, false);
  assert.equal(threads[0].resolutionAvailable, true);
});

test('resolutionAvailable follows the flag it is named after', () => {
  const threads = buildThreads({
    inlineComments: [ghInlineComment(1)],
    resolutionByCommentId: new Map([
      [1, { threadId: GRAPHQL_THREAD_ID, isResolved: true, isOutdated: false }],
    ]),
    resolutionAvailable: false,
  });
  assert.equal(threads[0].resolutionAvailable, false);
});

test('a thread the GraphQL answer never mentioned stays unknown', () => {
  const threads = buildThreads({
    inlineComments: [ghInlineComment(1)],
    resolutionByCommentId: new Map(),
    resolutionAvailable: true,
  });
  assert.equal(threads.length, 1);
  assert.equal(threads[0].resolved, null);
  assert.equal(threads[0].outdated, null);
  assert.equal(threads[0].threadId, null);
  assert.equal(threads[0].resolutionAvailable, false);
});

test('a reply whose parent is missing from the page becomes its own root', () => {
  const threads = buildThreads({ inlineComments: [ghInlineComment(7, { in_reply_to_id: 999 })] });
  assert.equal(threads.length, 1);
  assert.equal(threads[0].id, `${SURFACE_INLINE}:7`);
  assert.deepEqual(threads[0].replies, []);
});

test('threads come out ordered by createdAt, ties broken by id', () => {
  const threads = buildThreads({
    issueComments: [
      ghIssueComment(2, { created_at: MIDDLE_AT }),
      ghIssueComment(3, { created_at: LATE_AT }),
      ghIssueComment(10, { created_at: MIDDLE_AT }),
    ],
    inlineComments: [ghInlineComment(4, { created_at: EARLY_AT })],
  });
  assert.deepEqual(
    threads.map((thread) => thread.id),
    [
      `${SURFACE_INLINE}:4`,
      `${SURFACE_ISSUE_COMMENT}:10`,
      `${SURFACE_ISSUE_COMMENT}:2`,
      `${SURFACE_ISSUE_COMMENT}:3`,
    ],
  );
  assert.deepEqual(
    threads.map((thread) => thread.surface),
    [SURFACE_INLINE, SURFACE_ISSUE_COMMENT, SURFACE_ISSUE_COMMENT, SURFACE_ISSUE_COMMENT],
  );
});

test('an edited comment sorts by when it was created, not by when it was edited', () => {
  const threads = buildThreads({
    issueComments: [
      ghIssueComment(1, { created_at: EARLY_AT, updated_at: LATE_AT }),
      ghIssueComment(2, { created_at: MIDDLE_AT }),
    ],
  });
  assert.deepEqual(
    threads.map((thread) => thread.id),
    [`${SURFACE_ISSUE_COMMENT}:1`, `${SURFACE_ISSUE_COMMENT}:2`],
  );
  assert.equal(threads[0].updatedAt, LATE_AT);
  assert.equal(threads[1].updatedAt, MIDDLE_AT);
});

test('the same id on two surfaces becomes two threads, one per surface prefix', () => {
  const threads = buildThreads({
    issueComments: [ghIssueComment(5)],
    inlineComments: [ghInlineComment(5)],
  });
  assert.equal(threads.length, 2);
  assert.deepEqual(
    threads.map((thread) => thread.id),
    [`${SURFACE_INLINE}:5`, `${SURFACE_ISSUE_COMMENT}:5`],
  );
});
