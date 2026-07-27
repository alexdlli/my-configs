import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BAD_DATA_BLOCKER_URL,
  BAD_DATA_ESTIMATE_CONFLICT,
  BAD_DATA_ESTIMATE_MALFORMED,
  BAD_DATA_MARKER,
  FAILURE_CLI_MISSING,
  FAILURE_GH_ERROR,
  FAILURE_INSUFFICIENT_SCOPE,
  FAILURE_ISSUES_DISABLED,
  FAILURE_NOT_AUTHENTICATED,
  FAILURE_RATE_LIMITED,
  FAILURE_REPO_NOT_FOUND,
  SOURCE_BOTH,
  SOURCE_MARKER,
  SOURCE_NATIVE,
  canonicalId,
  checkGhReadiness,
  classifyGhResult,
  describeScope,
  mapState,
  mergeBlockedBy,
  nativeBlockedBy,
  normalizeIssue,
  normalizeIssues,
  parseArgs,
  parseBlockedByMarkers,
  parseIssueRefToken,
  readEstimate,
  refFromUrl,
  splitCanonicalId,
} from './tickets-github.mjs';
import { planWaves } from './graph.mjs';

const REPO = 'acme/api';
const OTHER_REPO = 'acme/infra';

// GitHub caps every issue relation connection at this many nodes; past it the
// `--json` payload comes back short of `totalCount`.
const RELATION_NODE_CAP = 50;

function issueUrl(repo, number) {
  return `https://github.com/${repo}/issues/${number}`;
}

function blockerNode(repo, number, state = 'OPEN') {
  return { number, state, title: `blocker ${number}`, url: issueUrl(repo, number) };
}

function ghIssue(number, overrides = {}) {
  return {
    number,
    title: `issue ${number}`,
    url: issueUrl(REPO, number),
    state: 'OPEN',
    stateReason: '',
    body: '',
    blockedBy: { nodes: [], totalCount: 0 },
    labels: [],
    ...overrides,
  };
}

test('parseArgs takes the repo, the slice and the flags', () => {
  assert.deepEqual(parseArgs(['--repo', REPO, '--json']), {
    repo: REPO,
    milestone: null,
    labels: [],
    json: true,
    help: false,
  });
  assert.deepEqual(parseArgs(['--repo', REPO, '--milestone', '7', '--label', 'a', '--label', 'b']), {
    repo: REPO,
    milestone: '7',
    labels: ['a', 'b'],
    json: false,
    help: false,
  });
});

test('parseArgs requires a well formed --repo', () => {
  assert.match(parseArgs([]).error, /--repo <owner>\/<repo> is required/);
  assert.match(parseArgs(['--json']).error, /--repo <owner>\/<repo> is required/);
  assert.match(parseArgs(['--repo', 'api']).error, /must look like <owner>\/<repo>/);
  assert.match(parseArgs(['--repo', 'a/b/c']).error, /must look like <owner>\/<repo>/);
});

test('parseArgs accepts --help without a repo', () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).error, undefined);
});

test('parseArgs rejects unknown options, missing values and positionals', () => {
  assert.match(parseArgs(['--repo', REPO, '--nope']).error, /unknown option: --nope/);
  assert.match(parseArgs(['--repo']).error, /missing value for --repo/);
  assert.match(parseArgs(['--repo', REPO, '--label']).error, /missing value for --label/);
  assert.match(parseArgs([REPO]).error, /unexpected positional argument/);
});

test('describeScope names the slice and reports the whole repo as no slice', () => {
  assert.equal(describeScope({ milestone: null, labels: [] }), null);
  assert.equal(describeScope({ milestone: '7', labels: [] }), 'milestone 7');
  assert.equal(describeScope({ milestone: null, labels: ['waves'] }), 'label waves');
  assert.equal(describeScope({ milestone: '7', labels: ['a', 'b'] }), 'milestone 7 + label a + label b');
});

test('canonicalId and splitCanonicalId round-trip, case insensitively', () => {
  assert.equal(canonicalId('Acme/API', '007'), 'acme/api#7');
  assert.deepEqual(splitCanonicalId('acme/api#7'), { repo: 'acme/api', number: 7 });
});

test('refFromUrl reads the repo of a blocker that carries no repository field', () => {
  assert.deepEqual(refFromUrl(issueUrl(OTHER_REPO, 12)), { repo: OTHER_REPO, number: 12 });
  assert.deepEqual(refFromUrl('https://github.enterprise.example/acme/api/issues/3'), {
    repo: REPO,
    number: 3,
  });
});

test('refFromUrl refuses anything that is not an issue URL', () => {
  assert.equal(refFromUrl('https://github.com/acme/api/pull/12'), null);
  assert.equal(refFromUrl('https://github.com/acme/api/issues'), null);
  assert.equal(refFromUrl(null), null);
  assert.equal(refFromUrl(undefined), null);
});

test('parseIssueRefToken defaults a bare number to the target repo', () => {
  assert.equal(parseIssueRefToken('#12', REPO), 'acme/api#12');
  assert.equal(parseIssueRefToken('Acme/Infra#34', REPO), 'acme/infra#34');
  assert.equal(parseIssueRefToken('  #12  ', REPO), 'acme/api#12');
});

test('parseIssueRefToken rejects prose, bare numbers and URLs', () => {
  assert.equal(parseIssueRefToken('banana', REPO), null);
  assert.equal(parseIssueRefToken('12', REPO), null);
  assert.equal(parseIssueRefToken('#', REPO), null);
  assert.equal(parseIssueRefToken(issueUrl(REPO, 12), REPO), null);
});

test('parseBlockedByMarkers reads a valid marker', () => {
  const parsed = parseBlockedByMarkers('intro\n<!-- blocked-by: #12, #34 -->\ntail', REPO);
  assert.deepEqual(parsed.ids, ['acme/api#12', 'acme/api#34']);
  assert.deepEqual(parsed.malformed, []);
  assert.equal(parsed.markers, 1);
});

test('parseBlockedByMarkers accepts the cross-repo form inside the marker', () => {
  const parsed = parseBlockedByMarkers('<!-- blocked-by: acme/infra#34, #12 -->', REPO);
  assert.deepEqual(parsed.ids, ['acme/infra#34', 'acme/api#12']);
  assert.deepEqual(parsed.malformed, []);
});

test('parseBlockedByMarkers ignores loose issue references outside the marker', () => {
  const body = [
    'This relates to #99 and to acme/infra#98.',
    '```',
    '// see #97',
    '```',
    '- [ ] check #96',
  ].join('\n');
  const parsed = parseBlockedByMarkers(body, REPO);
  assert.deepEqual(parsed.ids, []);
  assert.equal(parsed.markers, 0);
});

test('parseBlockedByMarkers returns nothing when the marker is absent', () => {
  assert.deepEqual(parseBlockedByMarkers('', REPO), { ids: [], malformed: [], markers: 0 });
  assert.deepEqual(parseBlockedByMarkers(null, REPO), { ids: [], malformed: [], markers: 0 });
});

test('parseBlockedByMarkers reports a malformed marker instead of dropping it', () => {
  const parsed = parseBlockedByMarkers('<!-- blocked-by: banana -->', REPO);
  assert.deepEqual(parsed.ids, []);
  assert.deepEqual(parsed.malformed, ['banana']);
  assert.equal(parsed.markers, 1);
});

test('parseBlockedByMarkers keeps the good entries of a partly malformed marker', () => {
  const parsed = parseBlockedByMarkers('<!-- blocked-by: #12, banana, 34 -->', REPO);
  assert.deepEqual(parsed.ids, ['acme/api#12']);
  assert.deepEqual(parsed.malformed, ['banana', '34']);
});

test('parseBlockedByMarkers reports an empty marker', () => {
  const parsed = parseBlockedByMarkers('<!-- blocked-by:  -->', REPO);
  assert.deepEqual(parsed.ids, []);
  assert.deepEqual(parsed.malformed, ['<!-- blocked-by:  -->']);
});

test('parseBlockedByMarkers unions several markers in the same body', () => {
  const body = '<!-- blocked-by: #12 -->\nmiddle\n<!-- blocked-by: #34, #12 -->';
  const parsed = parseBlockedByMarkers(body, REPO);
  assert.deepEqual(parsed.ids, ['acme/api#12', 'acme/api#34']);
  assert.equal(parsed.markers, 2);
  assert.deepEqual(parsed.malformed, []);
});

test('readEstimate leaves the estimate null when no est: label is set', () => {
  assert.deepEqual(readEstimate([]), { estimate: null, problem: null, labels: [] });
  assert.deepEqual(readEstimate([{ name: 'bug' }]), { estimate: null, problem: null, labels: [] });
  assert.deepEqual(readEstimate(undefined), { estimate: null, problem: null, labels: [] });
});

test('readEstimate reads a single est: label', () => {
  assert.equal(readEstimate([{ name: 'bug' }, { name: 'est:3' }]).estimate, 3);
  assert.equal(readEstimate([{ name: 'est: 0.5' }]).estimate, 0.5);
  assert.equal(readEstimate([{ name: 'EST:2' }]).estimate, 2);
});

test('readEstimate reports conflicting est: labels instead of picking one', () => {
  const read = readEstimate([{ name: 'est:3' }, { name: 'est:5' }]);
  assert.equal(read.estimate, null);
  assert.equal(read.problem, BAD_DATA_ESTIMATE_CONFLICT);
  assert.deepEqual(read.labels, ['est:3', 'est:5']);
});

test('readEstimate accepts duplicate est: labels that agree on the value', () => {
  const read = readEstimate([{ name: 'est:3' }, { name: 'est: 3' }]);
  assert.equal(read.estimate, 3);
  assert.equal(read.problem, null);
});

test('readEstimate reports an est: label carrying no number', () => {
  const read = readEstimate([{ name: 'est:banana' }]);
  assert.equal(read.estimate, null);
  assert.equal(read.problem, BAD_DATA_ESTIMATE_MALFORMED);
  assert.deepEqual(read.labels, ['est:banana']);
});

test('nativeBlockedBy turns the blocker URLs into canonical ids', () => {
  const native = nativeBlockedBy({
    nodes: [blockerNode(REPO, 12), blockerNode(OTHER_REPO, 34, 'CLOSED')],
    totalCount: 2,
  });
  assert.deepEqual(native.ids, ['acme/api#12', 'acme/infra#34']);
  assert.equal(native.truncated, false);
  assert.deepEqual(native.unreadable, []);
});

test('nativeBlockedBy reports a node whose URL is not an issue URL', () => {
  const native = nativeBlockedBy({
    nodes: [{ number: 9, url: 'https://github.com/acme/api/pull/9' }],
    totalCount: 1,
  });
  assert.deepEqual(native.ids, []);
  assert.deepEqual(native.unreadable, ['https://github.com/acme/api/pull/9']);
});

test('nativeBlockedBy flags a connection truncated at the relation cap', () => {
  const nodes = Array.from({ length: RELATION_NODE_CAP }, (_, i) => blockerNode(REPO, i + 1));
  const native = nativeBlockedBy({ nodes, totalCount: RELATION_NODE_CAP + 1 });
  assert.equal(native.truncated, true);
  assert.equal(native.totalCount, RELATION_NODE_CAP + 1);
  assert.equal(native.ids.length, RELATION_NODE_CAP);
});

test('nativeBlockedBy does not flag a full but complete connection', () => {
  const nodes = Array.from({ length: RELATION_NODE_CAP }, (_, i) => blockerNode(REPO, i + 1));
  assert.equal(nativeBlockedBy({ nodes, totalCount: RELATION_NODE_CAP }).truncated, false);
  assert.equal(nativeBlockedBy(undefined).truncated, false);
});

test('mergeBlockedBy unions the two sources and records where each edge came from', () => {
  const merged = mergeBlockedBy(['acme/api#12'], ['acme/api#34']);
  assert.deepEqual(merged.ids, ['acme/api#12', 'acme/api#34']);
  assert.deepEqual(merged.sources, {
    'acme/api#12': SOURCE_NATIVE,
    'acme/api#34': SOURCE_MARKER,
  });
});

test('mergeBlockedBy de-duplicates a blocker declared by both sources', () => {
  const merged = mergeBlockedBy(['acme/api#12'], ['acme/api#12']);
  assert.deepEqual(merged.ids, ['acme/api#12']);
  assert.deepEqual(merged.sources, { 'acme/api#12': SOURCE_BOTH });
});

test('mapState reads an open issue as open', () => {
  assert.deepEqual(mapState('OPEN', ''), { status: 'Open', statusType: 'open' });
  assert.deepEqual(mapState('OPEN', 'REOPENED'), { status: 'Open', statusType: 'open' });
});

test('mapState reads a completed close as the satisfied signal', () => {
  const mapped = mapState('CLOSED', 'COMPLETED');
  assert.equal(mapped.statusType, 'completed');
  assert.equal(mapped.status, 'Closed (completed)');
});

test('mapState does NOT read a not-planned close as completed', () => {
  const mapped = mapState('CLOSED', 'NOT_PLANNED');
  assert.equal(mapped.statusType, 'canceled');
  assert.equal(mapped.status, 'Closed (not planned)');
});

test('mapState reads a close with no reason as completed', () => {
  const mapped = mapState('CLOSED', '');
  assert.equal(mapped.statusType, 'completed');
  assert.equal(mapped.status, 'Closed (no reason)');
});

test('mapState leaves an unknown state null so the blocker stays open', () => {
  assert.deepEqual(mapState(null, null), { status: null, statusType: null });
  assert.deepEqual(mapState('DRAFT', ''), { status: null, statusType: null });
});

test('normalizeIssue maps a gh payload onto the normalized shape', () => {
  const ticket = normalizeIssue(
    {
      number: 12,
      title: 'Bloquear checkout com cartao expirado',
      url: issueUrl(REPO, 12),
      state: 'OPEN',
      stateReason: '',
      body: '## Problema',
    },
    { repo: REPO, blockedBy: ['acme/api#7'], blockedBySources: { 'acme/api#7': SOURCE_NATIVE }, estimate: 3 },
  );
  assert.deepEqual(ticket, {
    id: 'acme/api#12',
    key: '#12',
    title: 'Bloquear checkout com cartao expirado',
    url: issueUrl(REPO, 12),
    estimate: 3,
    status: 'Open',
    statusType: 'open',
    blockedBy: ['acme/api#7'],
    body: '## Problema',
    external: false,
    blockedBySources: { 'acme/api#7': SOURCE_NATIVE },
  });
});

test('normalizeIssue marks an external blocker, qualifies its key and drops its body', () => {
  const ticket = normalizeIssue(
    { number: 34, state: 'CLOSED', stateReason: 'NOT_PLANNED', body: 'x', url: issueUrl(OTHER_REPO, 34) },
    { repo: OTHER_REPO, external: true },
  );
  assert.equal(ticket.id, 'acme/infra#34');
  assert.equal(ticket.key, 'acme/infra#34');
  assert.equal(ticket.external, true);
  assert.equal(ticket.body, null);
  assert.equal(ticket.statusType, 'canceled');
});

test('normalizeIssue refuses a payload without a usable number', () => {
  assert.throws(() => normalizeIssue({ title: 'x' }, { repo: REPO }), /without a usable number/);
  assert.throws(() => normalizeIssue(null, { repo: REPO }), /payload keys: none/);
});

test('normalizeIssues unions the native field and the body marker per issue', () => {
  const issues = [
    ghIssue(1),
    ghIssue(2, {
      body: '<!-- blocked-by: #1, acme/infra#77 -->',
      blockedBy: { nodes: [blockerNode(REPO, 1)], totalCount: 1 },
    }),
  ];
  const { tickets, badData, truncations, externalRefs } = normalizeIssues(issues, { repo: REPO });
  assert.deepEqual(badData, []);
  assert.deepEqual(truncations, []);
  assert.deepEqual(tickets[1].blockedBy, ['acme/api#1', 'acme/infra#77']);
  assert.deepEqual(tickets[1].blockedBySources, {
    'acme/api#1': SOURCE_BOTH,
    'acme/infra#77': SOURCE_MARKER,
  });
  assert.deepEqual(externalRefs, ['acme/infra#77']);
});

test('normalizeIssues detects a blocker outside the target repo by its URL', () => {
  const issues = [
    ghIssue(1, {
      blockedBy: {
        nodes: [blockerNode(OTHER_REPO, 77, 'CLOSED'), blockerNode(REPO, 2)],
        totalCount: 2,
      },
    }),
    ghIssue(2),
  ];
  const { externalRefs } = normalizeIssues(issues, { repo: REPO });
  assert.deepEqual(externalRefs, ['acme/infra#77']);
});

test('normalizeIssues treats a same-repo blocker outside the slice as external', () => {
  const issues = [
    ghIssue(1, { blockedBy: { nodes: [blockerNode(REPO, 99)], totalCount: 1 } }),
  ];
  assert.deepEqual(normalizeIssues(issues, { repo: REPO }).externalRefs, ['acme/api#99']);
});

test('normalizeIssues collects marker, estimate and blocker-URL bad data', () => {
  const issues = [
    ghIssue(1, { body: '<!-- blocked-by: banana -->', labels: [{ name: 'est:3' }, { name: 'est:5' }] }),
    ghIssue(2, {
      blockedBy: { nodes: [{ number: 9, url: 'https://github.com/acme/api/pull/9' }], totalCount: 1 },
    }),
  ];
  const { badData } = normalizeIssues(issues, { repo: REPO });
  assert.deepEqual(
    badData.map((entry) => entry.kind).sort(),
    [BAD_DATA_BLOCKER_URL, BAD_DATA_ESTIMATE_CONFLICT, BAD_DATA_MARKER].sort(),
  );
  assert.deepEqual(badData.map((entry) => entry.id).sort(), ['acme/api#1', 'acme/api#1', 'acme/api#2']);
});

test('normalizeIssues surfaces a truncated relation connection', () => {
  const nodes = Array.from({ length: RELATION_NODE_CAP }, (_, i) => blockerNode(REPO, i + 100));
  const issues = [ghIssue(1, { blockedBy: { nodes, totalCount: RELATION_NODE_CAP + 3 } })];
  const { truncations } = normalizeIssues(issues, { repo: REPO });
  assert.deepEqual(truncations, [
    { id: 'acme/api#1', returned: RELATION_NODE_CAP, totalCount: RELATION_NODE_CAP + 3 },
  ]);
});

test('normalizeIssues turns an empty read into an empty ticket array, not an error', () => {
  assert.deepEqual(normalizeIssues([], { repo: REPO }), {
    tickets: [],
    badData: [],
    truncations: [],
    externalRefs: [],
  });
});

test('classifyGhResult names a missing CLI', () => {
  const classified = classifyGhResult({
    error: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }),
    stdout: '',
    stderr: '',
  });
  assert.equal(classified.failure, FAILURE_CLI_MISSING);
  assert.match(classified.message, /gh CLI was not found/);
});

test('classifyGhResult names each read failure apart', () => {
  const cases = [
    ["GraphQL: Could not resolve to a Repository with the name 'a/b'. (repository)", FAILURE_REPO_NOT_FOUND],
    ["the 'torvalds/linux' repository has disabled issues", FAILURE_ISSUES_DISABLED],
    ['API rate limit exceeded for user ID 1', FAILURE_RATE_LIMITED],
    ['HTTP 403: Resource not accessible by integration', FAILURE_INSUFFICIENT_SCOPE],
    ['To get started with GitHub CLI, please run:  gh auth login', FAILURE_NOT_AUTHENTICATED],
    ['unexplained explosion', FAILURE_GH_ERROR],
  ];
  for (const [stderr, failure] of cases) {
    const classified = classifyGhResult({ error: new Error('exit 1'), stdout: '', stderr });
    assert.equal(classified.failure, failure, stderr);
    assert.equal(classified.message, stderr);
  }
});

test('classifyGhResult reads a secondary rate limit as rate limited, not as a scope problem', () => {
  const stderr = 'HTTP 403: You have exceeded a secondary rate limit';
  assert.equal(classifyGhResult({ error: new Error('exit 1'), stdout: '', stderr }).failure, FAILURE_RATE_LIMITED);
});

test('classifyGhResult uses the documented auth exit code when stderr says nothing', () => {
  const classified = classifyGhResult({
    error: Object.assign(new Error('exit 4'), { code: 4 }),
    stdout: '',
    stderr: '',
  });
  assert.equal(classified.failure, FAILURE_NOT_AUTHENTICATED);
});

test('classifyGhResult treats non-JSON output as a failure, never as empty success', () => {
  const classified = classifyGhResult({ error: null, stdout: 'not json', stderr: '' });
  assert.equal(classified.failure, FAILURE_GH_ERROR);
  assert.match(classified.message, /exited 0 but produced no JSON/);
});

test('classifyGhResult returns an empty array as a legitimate read', () => {
  const classified = classifyGhResult({ error: null, stdout: '[]', stderr: '' });
  assert.equal(classified.failure, undefined);
  assert.deepEqual(classified.data, []);
});

test('checkGhReadiness separates a missing CLI from a logged-out CLI', () => {
  assert.equal(checkGhReadiness({ error: null, stdout: 'Logged in', stderr: '' }), null);

  const missing = checkGhReadiness({
    error: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }),
    stdout: '',
    stderr: '',
  });
  assert.equal(missing.failure, FAILURE_CLI_MISSING);

  const loggedOut = checkGhReadiness({
    error: Object.assign(new Error('exit 1'), { code: 1 }),
    stdout: '',
    stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login',
  });
  assert.equal(loggedOut.failure, FAILURE_NOT_AUTHENTICATED);
  assert.match(loggedOut.message, /not logged into any GitHub hosts/);
});

test('the emitted tickets feed graph.mjs unchanged', () => {
  const issues = [
    ghIssue(1, { state: 'CLOSED', stateReason: 'COMPLETED' }),
    ghIssue(2, { blockedBy: { nodes: [blockerNode(REPO, 1, 'CLOSED')], totalCount: 1 } }),
    ghIssue(3, { body: '<!-- blocked-by: #2 -->', labels: [{ name: 'est:2' }] }),
    ghIssue(4, { blockedBy: { nodes: [blockerNode(OTHER_REPO, 77)], totalCount: 1 } }),
  ];
  const { tickets, externalRefs } = normalizeIssues(issues, { repo: REPO });
  assert.deepEqual(externalRefs, ['acme/infra#77']);

  const openExternal = normalizeIssue(
    { number: 77, state: 'OPEN', stateReason: '', url: issueUrl(OTHER_REPO, 77) },
    { repo: OTHER_REPO, external: true },
  );
  const plan = planWaves([...tickets, openExternal]);

  assert.deepEqual(plan.done.map((entry) => entry.key), ['#1']);
  assert.deepEqual(
    plan.waves.map((wave) => [wave.number, wave.tickets.map((ticket) => ticket.key)]),
    [
      [1, ['#2']],
      [2, ['#3']],
    ],
  );
  assert.deepEqual(plan.blocked.map((entry) => [entry.key, entry.reason]), [['#4', 'external']]);
  assert.deepEqual(plan.badData, []);
  assert.deepEqual(plan.cycles, []);
  assert.equal(plan.waves[1].tickets[0].estimate, 2);
});

test('a not-planned close does not satisfy the tickets it blocks', () => {
  const issues = [
    ghIssue(1, { state: 'CLOSED', stateReason: 'NOT_PLANNED' }),
    ghIssue(2, { blockedBy: { nodes: [blockerNode(REPO, 1, 'CLOSED')], totalCount: 1 } }),
  ];
  const plan = planWaves(normalizeIssues(issues, { repo: REPO }).tickets);
  assert.deepEqual(plan.done, []);
  assert.deepEqual(
    plan.waves.map((wave) => [wave.number, wave.tickets.map((ticket) => ticket.key)]),
    [
      [1, ['#1']],
      [2, ['#2']],
    ],
  );
});
