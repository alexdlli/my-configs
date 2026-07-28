import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROMOTE_THRESHOLD,
  STATUS_CANDIDATE,
  STATUS_CONFIRMED,
  STATUS_QUARANTINED,
  WINDOW_DAYS,
  emptyStore,
  formatId,
  lessonKey,
  lessonsByStatus,
  parseStore,
  promoteEligible,
  pruneStale,
  quarantineLesson,
  recordOccurrence,
  renderStore,
  sanitize,
} from './lessons.mjs';

const CLI = fileURLToPath(new URL('./lessons.mjs', import.meta.url));

// Written out rather than computed from WINDOW_DAYS: deriving the test's dates
// with the same arithmetic the implementation uses lets a wrong constant cancel
// itself out, which is the vacuous_assertion failure this file exists to catch.
const DAY_ZERO = '2026-01-01T00:00:00.000Z';
const DAY_59 = '2026-03-01T00:00:00.000Z';
const DAY_60 = '2026-03-02T00:00:00.000Z';
const DAY_61 = '2026-03-03T00:00:00.000Z';

const SIGNAL = 'surviving_mutant';
const OTHER_SIGNAL = 'ac_uncovered';
const NOTE = 'ordenação precisa de um caso onde as duas chaves discordam';
const OTHER_NOTE = 'o critério de aceite precisa de um teste que possa falhar por ele';
const TICKET_A = 'w1-issue-10';
const TICKET_B = 'w1-issue-11';

function storeWith(occurrences) {
  const store = emptyStore();
  for (const occurrence of occurrences) recordOccurrence(store, occurrence);
  return store;
}

function only(store) {
  assert.equal(store.lessons.length, 1, 'expected exactly one lesson in the store');
  return store.lessons[0];
}

function runCli(storePath, args) {
  return spawnSync(process.execPath, [CLI, ...args, '--store', storePath], { encoding: 'utf8' });
}

function withTempStore(body) {
  const dir = mkdtempSync(join(tmpdir(), 'lessons-'));
  try {
    return body(join(dir, 'lessons.md'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the window and the threshold are the documented policy', () => {
  assert.equal(PROMOTE_THRESHOLD, 2);
  assert.equal(WINDOW_DAYS, 60);
});

test('two occurrences in the SAME ticket count as one and do not promote', () => {
  const store = storeWith([
    { signal: SIGNAL, ticket: TICKET_A, note: NOTE, evidence: 'PR 10, Critical 2', now: DAY_ZERO },
    { signal: SIGNAL, ticket: TICKET_A, note: NOTE, evidence: 'PR 10, Critical 1', now: DAY_ZERO },
  ]);

  assert.deepEqual(promoteEligible(store), []);
  const lesson = only(store);
  assert.deepEqual(lesson.tickets, [TICKET_A]);
  assert.equal(lesson.tickets.length, 1);
  assert.equal(lesson.status, STATUS_CANDIDATE);
  assert.equal(lesson.evidence.length, 2, 'both pieces of evidence are kept, but they are one ticket');
});

test('the same lesson in TWO distinct tickets promotes to confirmed', () => {
  const store = storeWith([
    { signal: SIGNAL, ticket: TICKET_A, note: NOTE, now: DAY_ZERO },
    { signal: SIGNAL, ticket: TICKET_B, note: NOTE, now: DAY_ZERO },
  ]);

  assert.deepEqual(promoteEligible(store), ['L-001']);
  const lesson = only(store);
  assert.deepEqual(lesson.tickets, [TICKET_A, TICKET_B]);
  assert.equal(lesson.status, STATUS_CONFIRMED);
});

test('a third ticket does not create a second lesson, and promotion is not undone', () => {
  const store = storeWith([
    { signal: SIGNAL, ticket: TICKET_A, note: NOTE, now: DAY_ZERO },
    { signal: SIGNAL, ticket: TICKET_B, note: NOTE, now: DAY_ZERO },
  ]);
  promoteEligible(store);
  recordOccurrence(store, { signal: SIGNAL, ticket: 'w2-issue-30', note: NOTE, now: DAY_59 });

  const lesson = only(store);
  assert.equal(lesson.tickets.length, 3);
  assert.equal(lesson.status, STATUS_CONFIRMED);
});

test('the same text under a different signal is a different lesson', () => {
  const store = storeWith([
    { signal: SIGNAL, ticket: TICKET_A, note: NOTE, now: DAY_ZERO },
    { signal: OTHER_SIGNAL, ticket: TICKET_B, note: NOTE, now: DAY_ZERO },
  ]);
  assert.equal(store.lessons.length, 2);
  assert.deepEqual(promoteEligible(store), []);
});

test('casing, accents and punctuation do not split a recurrence', () => {
  assert.equal(
    lessonKey(SIGNAL, 'Ordenação precisa de duas chaves!'),
    lessonKey(SIGNAL, 'ordenacao   precisa de duas chaves'),
  );
  const store = storeWith([
    { signal: SIGNAL, ticket: TICKET_A, note: 'Ordenação precisa de duas chaves!', now: DAY_ZERO },
    { signal: SIGNAL, ticket: TICKET_B, note: 'ordenacao precisa de duas chaves', now: DAY_ZERO },
  ]);
  assert.equal(store.lessons.length, 1);
  assert.deepEqual(promoteEligible(store), ['L-001']);
});

test('a candidate that never recurred is pruned once it is past the window', () => {
  const store = storeWith([{ signal: SIGNAL, ticket: TICKET_A, note: NOTE, now: DAY_ZERO }]);

  assert.deepEqual(pruneStale(store, DAY_59), [], 'inside the window it stays');
  assert.deepEqual(pruneStale(store, DAY_60), [], 'the boundary day itself still stays');
  assert.equal(store.lessons.length, 1);

  assert.deepEqual(pruneStale(store, DAY_61), ['L-001']);
  assert.deepEqual(store.lessons, []);
});

test('recurring inside one ticket keeps a candidate alive without promoting it', () => {
  const store = storeWith([{ signal: SIGNAL, ticket: TICKET_A, note: NOTE, now: DAY_ZERO }]);
  recordOccurrence(store, { signal: SIGNAL, ticket: TICKET_A, note: NOTE, now: DAY_59 });

  assert.deepEqual(pruneStale(store, DAY_61), [], 'last seen on day 59, so day 61 is inside the window');
  assert.equal(only(store).status, STATUS_CANDIDATE);
});

test('prune never drops a confirmed or quarantined lesson, however old', () => {
  const store = storeWith([
    { signal: SIGNAL, ticket: TICKET_A, note: NOTE, now: DAY_ZERO },
    { signal: SIGNAL, ticket: TICKET_B, note: NOTE, now: DAY_ZERO },
    { signal: OTHER_SIGNAL, ticket: TICKET_A, note: OTHER_NOTE, now: DAY_ZERO },
  ]);
  promoteEligible(store);
  quarantineLesson(store, { id: 'L-002', reason: 'aplicada e piorou' });

  assert.deepEqual(pruneStale(store, '2030-01-01T00:00:00.000Z'), []);
  assert.equal(store.lessons.length, 2);
});

test('prune standing alone does not drop a candidate that already earned promotion', () => {
  const store = storeWith([
    { signal: SIGNAL, ticket: TICKET_A, note: NOTE, now: DAY_ZERO },
    { signal: SIGNAL, ticket: TICKET_B, note: NOTE, now: DAY_ZERO },
  ]);
  assert.equal(only(store).status, STATUS_CANDIDATE, 'not promoted yet');

  assert.deepEqual(pruneStale(store, '2030-01-01T00:00:00.000Z'), []);
  assert.deepEqual(promoteEligible(store), ['L-001']);
});

test('quarantine takes a lesson out of confirmed and records why', () => {
  const store = storeWith([
    { signal: SIGNAL, ticket: TICKET_A, note: NOTE, now: DAY_ZERO },
    { signal: SIGNAL, ticket: TICKET_B, note: NOTE, now: DAY_ZERO },
  ]);
  promoteEligible(store);
  assert.equal(lessonsByStatus(store, STATUS_CONFIRMED).length, 1);

  const lesson = quarantineLesson(store, { id: 'L-001', reason: 'levou a duplicar fixtures' });

  assert.equal(lesson.status, STATUS_QUARANTINED);
  assert.equal(lesson.reason, 'levou a duplicar fixtures');
  assert.deepEqual(lessonsByStatus(store, STATUS_CONFIRMED), [], 'no longer loadable as guidance');
  assert.equal(lessonsByStatus(store, STATUS_QUARANTINED).length, 1);
});

test('a quarantined lesson that recurs is not resurrected', () => {
  const store = storeWith([
    { signal: SIGNAL, ticket: TICKET_A, note: NOTE, now: DAY_ZERO },
    { signal: SIGNAL, ticket: TICKET_B, note: NOTE, now: DAY_ZERO },
  ]);
  promoteEligible(store);
  quarantineLesson(store, { id: 'L-001', reason: 'aplicada e piorou' });

  recordOccurrence(store, { signal: SIGNAL, ticket: 'w3-issue-99', note: NOTE, now: DAY_59 });
  promoteEligible(store);

  assert.equal(only(store).status, STATUS_QUARANTINED);
});

test('quarantining an unknown id reports it instead of inventing a lesson', () => {
  const store = emptyStore();
  assert.equal(quarantineLesson(store, { id: 'L-404', reason: 'x' }), null);
  assert.deepEqual(store.lessons, []);
});

test('ids are assigned in order and survive a render/parse round trip', () => {
  const store = storeWith([
    { signal: SIGNAL, ticket: TICKET_A, note: NOTE, now: DAY_ZERO },
    { signal: OTHER_SIGNAL, ticket: TICKET_A, note: OTHER_NOTE, now: DAY_ZERO },
  ]);
  assert.deepEqual(store.lessons.map((lesson) => lesson.id), ['L-001', 'L-002']);

  const reloaded = parseStore(renderStore(store));
  assert.deepEqual(reloaded.lessons.map((lesson) => lesson.id), ['L-001', 'L-002']);
  assert.equal(reloaded.nextId, 3);
});

test('a pruned id is never handed to a different lesson', () => {
  const store = storeWith([
    { signal: SIGNAL, ticket: TICKET_A, note: NOTE, now: DAY_ZERO },
    { signal: OTHER_SIGNAL, ticket: TICKET_A, note: OTHER_NOTE, now: DAY_ZERO },
  ]);
  assert.deepEqual(pruneStale(store, DAY_61), ['L-001', 'L-002']);

  const reloaded = parseStore(renderStore(store));
  const { lesson } = recordOccurrence(reloaded, {
    signal: SIGNAL,
    ticket: TICKET_B,
    note: 'uma lição completamente nova sobre fixtures',
    now: DAY_61,
  });
  assert.equal(lesson.id, 'L-003');
});

test('a render/parse round trip preserves every field', () => {
  const store = storeWith([
    {
      signal: SIGNAL,
      ticket: TICKET_A,
      note: NOTE,
      evidence: 'PR 10, Critical 2: createdAt -> updatedAt deixa 21/21 verde',
      now: DAY_ZERO,
    },
    { signal: SIGNAL, ticket: TICKET_B, note: NOTE, evidence: 'PR 11, Critical 1', now: DAY_59 },
    { signal: OTHER_SIGNAL, ticket: TICKET_A, note: OTHER_NOTE, now: DAY_ZERO },
  ]);
  promoteEligible(store);
  quarantineLesson(store, { id: 'L-002', reason: 'aplicada e o resultado piorou' });

  assert.deepEqual(parseStore(renderStore(store)), store);
});

test('rendering is deterministic, so an unchanged store produces identical bytes', () => {
  const store = storeWith([{ signal: SIGNAL, ticket: TICKET_A, note: NOTE, now: DAY_ZERO }]);
  assert.equal(renderStore(store), renderStore(parseStore(renderStore(store))));
});

test('recording the same occurrence twice does not duplicate anything', () => {
  const occurrence = {
    signal: SIGNAL,
    ticket: TICKET_A,
    note: NOTE,
    evidence: 'PR 10, Critical 2',
    now: DAY_ZERO,
  };
  const once = storeWith([occurrence]);
  const twice = storeWith([occurrence, { ...occurrence }]);

  assert.equal(twice.lessons.length, 1);
  assert.deepEqual(only(twice).tickets, [TICKET_A]);
  assert.deepEqual(only(twice).evidence, ['PR 10, Critical 2']);
  assert.equal(renderStore(twice), renderStore(once), 'the generated file is byte-identical');
});

test('the candidates section carries the do-not-load warning literally', () => {
  const store = storeWith([{ signal: SIGNAL, ticket: TICKET_A, note: NOTE, now: DAY_ZERO }]);
  const rendered = renderStore(store);

  assert.match(rendered, /NÃO carregar como guidance ainda/);
  assert.match(rendered, /Nunca edite este arquivo à mão/);
  assert.match(rendered, new RegExp(`### L-001 — ${NOTE}`));
});

test('an empty store still renders the three sections', () => {
  const rendered = renderStore(emptyStore());
  assert.match(rendered, /## Confirmadas/);
  assert.match(rendered, /## Candidatas/);
  assert.match(rendered, /## Quarentena/);
  assert.equal(rendered.match(/_nenhuma_/g).length, 3);
});

test('a value spanning lines is collapsed, so it cannot forge a field line', () => {
  assert.equal(sanitize('a\n- sinal: forjado'), 'a - sinal: forjado');

  const store = storeWith([
    { signal: SIGNAL, ticket: TICKET_A, note: 'lição com\nquebra de linha no meio', now: DAY_ZERO },
  ]);
  const reloaded = parseStore(renderStore(store));
  assert.equal(only(reloaded).text, 'lição com quebra de linha no meio');
  assert.equal(only(reloaded).signal, SIGNAL);
});

test('a file that is not a lessons store is refused instead of silently reset', () => {
  assert.throws(() => parseStore('# Some other doc\n'), /lessons:state/);
});

test('a hand-edited field the parser does not know throws instead of dropping data', () => {
  const store = storeWith([{ signal: SIGNAL, ticket: TICKET_A, note: NOTE, now: DAY_ZERO }]);
  const tampered = renderStore(store).replace('- tickets:', '- ticketz:');
  assert.throws(() => parseStore(tampered), /unknown field "ticketz"/);
});

test('formatId pads to a fixed width so ids sort as text', () => {
  assert.equal(formatId(1), 'L-001');
  assert.equal(formatId(42), 'L-042');
  assert.ok('L-002' > 'L-001');
});

test('the CLI records, promotes across distinct tickets and lists only confirmed', () => {
  withTempStore((store) => {
    const first = runCli(store, ['record', '--signal', SIGNAL, '--ticket', TICKET_A, '--note', NOTE]);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /^ADDED L-001 \(candidate, 1 ticket distinto\)/);

    const repeat = runCli(store, ['record', '--signal', SIGNAL, '--ticket', TICKET_A, '--note', NOTE]);
    assert.equal(repeat.status, 0, repeat.stderr);
    assert.doesNotMatch(repeat.stdout, /PROMOTED/, 'the same ticket twice must not promote');

    assert.equal(runCli(store, ['list']).stdout, '(no confirmed lessons)\n');

    const second = runCli(store, ['record', '--signal', SIGNAL, '--ticket', TICKET_B, '--note', NOTE]);
    assert.match(second.stdout, /PROMOTED to confirmed/);

    const listed = runCli(store, ['list']);
    assert.match(listed.stdout, /^L-001 \(confirmed, 2 tickets distintos\)/);
  });
});

test('the CLI writes a file with one heading per lesson, whatever the repeat count', () => {
  withTempStore((store) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      runCli(store, ['record', '--signal', SIGNAL, '--ticket', TICKET_A, '--note', NOTE]);
    }
    const text = readFileSync(store, 'utf8');
    assert.equal(text.match(/^### L-/gm).length, 1);
    assert.match(text, /- tickets: w1-issue-10\n/);
    assert.match(text, /<!-- lessons:state next-id=2 -->/);
  });
});

test('the CLI refuses input that would not be a lesson', () => {
  withTempStore((store) => {
    const unknown = runCli(store, ['record', '--signal', 'made_up', '--ticket', TICKET_A, '--note', NOTE]);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /unknown signal/);

    const short = runCli(store, ['record', '--signal', SIGNAL, '--ticket', TICKET_A, '--note', 'curta']);
    assert.equal(short.status, 2);
    assert.match(short.stderr, /too short/);

    const comma = runCli(store, ['record', '--signal', SIGNAL, '--ticket', 'a,b', '--note', NOTE]);
    assert.equal(comma.status, 2);
    assert.match(comma.stderr, /comma/);

    const noTicket = runCli(store, ['record', '--signal', SIGNAL, '--note', NOTE]);
    assert.equal(noTicket.status, 2);
    assert.match(noTicket.stderr, /--ticket is required/);
  });
});

test('the CLI quarantine command moves a confirmed lesson out and needs a reason', () => {
  withTempStore((store) => {
    runCli(store, ['record', '--signal', SIGNAL, '--ticket', TICKET_A, '--note', NOTE]);
    runCli(store, ['record', '--signal', SIGNAL, '--ticket', TICKET_B, '--note', NOTE]);

    const missing = runCli(store, ['quarantine', '--id', 'L-001']);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /--reason is required/);

    const unknown = runCli(store, ['quarantine', '--id', 'L-404', '--reason', 'x']);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /no lesson with id L-404/);

    const done = runCli(store, ['quarantine', '--id', 'L-001', '--reason', 'aplicada e piorou']);
    assert.equal(done.status, 0, done.stderr);
    assert.equal(runCli(store, ['list']).stdout, '(no confirmed lessons)\n');
    assert.match(runCli(store, ['list', '--quarantine']).stdout, /^L-001 \(quarantined/);
  });
});

test('list never writes, so reading cannot dirty a working tree', () => {
  withTempStore((store) => {
    runCli(store, ['record', '--signal', SIGNAL, '--ticket', TICKET_A, '--note', NOTE]);
    const before = readFileSync(store, 'utf8');
    for (const filter of ['--all', '--candidates', '--confirmed', '--quarantine']) {
      assert.equal(runCli(store, ['list', filter]).status, 0);
    }
    assert.equal(readFileSync(store, 'utf8'), before);
  });
});

test('a status filter on a command that is not list is a usage error', () => {
  withTempStore((store) => {
    const result = runCli(store, ['prune', '--confirmed']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /status filters only apply/);
  });
});
