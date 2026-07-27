import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FAILURE_CLI_MISSING,
  FAILURE_APP_UNAVAILABLE,
  FAILURE_LINEAR_NOT_CONNECTED,
  FAILURE_ORCA_ERROR,
  FAILURE_PROJECT_AMBIGUOUS,
  FAILURE_PROJECT_NOT_FOUND,
  checkOrcaReadiness,
  classifyOrcaResult,
  deriveProjectQuery,
  extractBlockedBy,
  matchProject,
  normalizeIssue,
  parseArgs,
} from './tickets-linear.mjs';

const PROJECT_URL = 'https://linear.app/acme/project/waves-harness-0a1b2c3d4e5f';

test('parseArgs takes the project and the flags', () => {
  assert.deepEqual(parseArgs(['Waves harness', '--json']), {
    project: 'Waves harness',
    json: true,
    workspace: null,
    help: false,
  });
  assert.deepEqual(parseArgs([PROJECT_URL, '--workspace', 'ws-1']), {
    project: PROJECT_URL,
    json: false,
    workspace: 'ws-1',
    help: false,
  });
});

test('parseArgs refuses a missing project with a usable error', () => {
  assert.match(parseArgs([]).error, /project identifier/);
  assert.match(parseArgs(['--json']).error, /project identifier/);
});

test('parseArgs accepts --help without a project', () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).error, undefined);
});

test('parseArgs rejects unknown options and extra arguments', () => {
  assert.match(parseArgs(['x', '--nope']).error, /unknown option: --nope/);
  assert.match(parseArgs(['x', 'y']).error, /unexpected extra argument: y/);
  assert.match(parseArgs(['x', '--workspace']).error, /missing value for --workspace/);
});

test('deriveProjectQuery keeps a plain name untouched', () => {
  assert.equal(deriveProjectQuery('Waves harness'), 'Waves harness');
  assert.equal(deriveProjectQuery('  Waves harness  '), 'Waves harness');
});

test('deriveProjectQuery turns a project URL into a searchable name', () => {
  assert.equal(deriveProjectQuery(PROJECT_URL), 'waves harness');
  assert.equal(deriveProjectQuery(`${PROJECT_URL}/overview`), 'waves harness');
  assert.equal(deriveProjectQuery(`${PROJECT_URL}/issues`), 'waves harness');
});

test('matchProject prefers an exact id, url or name', () => {
  const projects = [
    { id: 'p-1', name: 'Waves harness', url: PROJECT_URL, slugId: '0a1b2c3d4e5f' },
    { id: 'p-2', name: 'Waves harness v2', url: `${PROJECT_URL}-v2` },
  ];
  assert.equal(matchProject(projects, 'p-1').project.id, 'p-1');
  assert.equal(matchProject(projects, PROJECT_URL).project.id, 'p-1');
  assert.equal(matchProject(projects, 'waves HARNESS').project.id, 'p-1');
  assert.equal(matchProject(projects, 'Waves harness v2').project.id, 'p-2');
});

test('matchProject falls back to a unique partial name match', () => {
  const projects = [
    { id: 'p-1', name: 'Waves harness' },
    { id: 'p-2', name: 'Billing rework' },
  ];
  assert.equal(matchProject(projects, 'harness').project.id, 'p-1');
});

test('matchProject reports ambiguity instead of picking one', () => {
  const projects = [
    { id: 'p-1', name: 'Waves harness alpha' },
    { id: 'p-2', name: 'Waves harness beta' },
  ];
  const match = matchProject(projects, 'waves harness');
  assert.equal(match.failure, FAILURE_PROJECT_AMBIGUOUS);
  assert.equal(match.candidates.length, 2);
});

test('matchProject reports not-found on an empty project list', () => {
  const match = matchProject([], 'Waves harness');
  assert.equal(match.failure, FAILURE_PROJECT_NOT_FOUND);
  assert.deepEqual(match.candidates, []);
});

test('classifyOrcaResult names a missing CLI', () => {
  const classified = classifyOrcaResult({
    error: Object.assign(new Error('spawn orca ENOENT'), { code: 'ENOENT' }),
    stdout: '',
    stderr: '',
  });
  assert.equal(classified.failure, FAILURE_CLI_MISSING);
  assert.match(classified.message, /orca CLI was not found/);
});

test('classifyOrcaResult names a disconnected Linear', () => {
  const stdout = JSON.stringify({
    ok: false,
    error: {
      code: 'linear_not_connected',
      message: 'Linear is not connected.',
      data: { nextSteps: ['Connect Linear from Orca settings, then retry the issue list.'] },
    },
  });
  const classified = classifyOrcaResult({ error: new Error('exit 1'), stdout, stderr: '' });
  assert.equal(classified.failure, FAILURE_LINEAR_NOT_CONNECTED);
  assert.equal(classified.code, 'linear_not_connected');
  assert.equal(classified.nextSteps.length, 1);
});

test('classifyOrcaResult passes any other orca error through with its code', () => {
  const stdout = JSON.stringify({
    ok: false,
    error: { code: 'invalid_argument', message: 'Unknown environment: bogus' },
  });
  const classified = classifyOrcaResult({ error: new Error('exit 1'), stdout, stderr: '' });
  assert.equal(classified.failure, FAILURE_ORCA_ERROR);
  assert.equal(classified.code, 'invalid_argument');
});

test('classifyOrcaResult treats non-JSON output as a failure, never as empty success', () => {
  const classified = classifyOrcaResult({
    error: new Error('exit 1'),
    stdout: 'command not understood',
    stderr: 'boom',
  });
  assert.equal(classified.failure, FAILURE_ORCA_ERROR);
  assert.equal(classified.message, 'boom');
});

test('classifyOrcaResult returns the envelope on success', () => {
  const stdout = JSON.stringify({ ok: true, result: { projects: [] } });
  const classified = classifyOrcaResult({ error: null, stdout, stderr: '' });
  assert.equal(classified.failure, undefined);
  assert.deepEqual(classified.envelope.result.projects, []);
});

test('checkOrcaReadiness accepts a running app with a reachable runtime', () => {
  const envelope = { result: { app: { running: true }, runtime: { reachable: true, state: 'ready' } } };
  assert.equal(checkOrcaReadiness(envelope), null);
});

test('checkOrcaReadiness names a stopped app and an unreachable runtime apart', () => {
  const stopped = checkOrcaReadiness({ result: { app: { running: false }, runtime: {} } });
  assert.equal(stopped.failure, FAILURE_APP_UNAVAILABLE);
  assert.match(stopped.message, /not running/);

  const unreachable = checkOrcaReadiness({
    result: { app: { running: true }, runtime: { reachable: false, state: 'starting' } },
  });
  assert.equal(unreachable.failure, FAILURE_APP_UNAVAILABLE);
  assert.match(unreachable.message, /not reachable \(state: starting\)/);
});

test('extractBlockedBy reads a typed relation array', () => {
  const payload = {
    id: 'issue-3',
    relations: [
      { type: 'blocked-by', issue: { id: 'issue-1', identifier: 'ENG-1' } },
      { type: 'blocks', issue: { id: 'issue-9', identifier: 'ENG-9' } },
      { type: 'related', issue: { id: 'issue-7' } },
      { type: 'duplicate-of', issue: { id: 'issue-8' } },
    ],
  };
  assert.deepEqual(extractBlockedBy(payload), ['issue-1']);
});

test('extractBlockedBy reads a grouped relation object', () => {
  const payload = {
    id: 'issue-3',
    relations: { blockedBy: [{ id: 'issue-1' }, { id: 'issue-2' }], blocking: [{ id: 'issue-9' }] },
  };
  assert.deepEqual(extractBlockedBy(payload), ['issue-1', 'issue-2']);
});

test('extractBlockedBy reads a blockedBy list sitting on the issue itself', () => {
  assert.deepEqual(extractBlockedBy({ id: 'issue-3', blockedBy: ['issue-1'] }), ['issue-1']);
});

test('extractBlockedBy de-duplicates and ignores unusable refs', () => {
  const payload = {
    relations: [
      { type: 'blockedBy', relatedIssue: { id: 'issue-1' } },
      { type: 'blocked-by', target: 'issue-1' },
      { type: 'blocked-by', issue: {} },
      { type: 'blocked-by' },
      'garbage',
    ],
  };
  assert.deepEqual(extractBlockedBy(payload), ['issue-1']);
});

test('extractBlockedBy returns nothing for an issue with no relations', () => {
  assert.deepEqual(extractBlockedBy({ id: 'issue-1' }), []);
  assert.deepEqual(extractBlockedBy(null), []);
});

test('normalizeIssue maps a Linear payload onto the normalized shape', () => {
  const ticket = normalizeIssue(
    {
      id: 'issue-1',
      identifier: 'ENG-1',
      title: 'Bloquear checkout com cartao expirado',
      url: 'https://linear.app/acme/issue/ENG-1',
      estimate: 3,
      state: { name: 'In Progress', type: 'started' },
      description: '## Problema',
    },
    { blockedBy: ['issue-0'] },
  );
  assert.deepEqual(ticket, {
    id: 'issue-1',
    key: 'ENG-1',
    title: 'Bloquear checkout com cartao expirado',
    url: 'https://linear.app/acme/issue/ENG-1',
    estimate: 3,
    status: 'In Progress',
    statusType: 'started',
    blockedBy: ['issue-0'],
    body: '## Problema',
    external: false,
  });
});

test('normalizeIssue accepts a plain string state and a body field', () => {
  const ticket = normalizeIssue({ id: 'issue-2', key: 'ENG-2', status: 'Done', body: 'x' });
  assert.equal(ticket.status, 'Done');
  assert.equal(ticket.statusType, null);
  assert.equal(ticket.key, 'ENG-2');
  assert.equal(ticket.body, 'x');
  assert.deepEqual(ticket.blockedBy, []);
});

test('normalizeIssue marks an external blocker and drops its body', () => {
  const ticket = normalizeIssue(
    { id: 'issue-9', identifier: 'OPS-9', state: { name: 'Todo', type: 'unstarted' }, description: 'x' },
    { external: true },
  );
  assert.equal(ticket.external, true);
  assert.equal(ticket.body, null);
  assert.equal(ticket.status, 'Todo');
});

test('normalizeIssue refuses a payload without an id instead of emitting a null ticket', () => {
  assert.throws(() => normalizeIssue({ identifier: 'ENG-1' }), /without a string id/);
  assert.throws(() => normalizeIssue(null), /payload keys: none/);
});
