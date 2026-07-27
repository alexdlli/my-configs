import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BLOCKED_CYCLE,
  BLOCKED_EXTERNAL,
  BLOCKED_UNKNOWN_BLOCKER,
  BLOCKED_UPSTREAM,
  FIRST_WAVE,
  WAVE_DONE,
  isSatisfied,
  planWaves,
} from './graph.mjs';

function ticket(key, overrides = {}) {
  return {
    id: `id-${key}`,
    key,
    title: `Ticket ${key}`,
    url: `https://linear.app/acme/issue/${key}`,
    estimate: 2,
    status: 'Backlog',
    statusType: 'unstarted',
    blockedBy: [],
    body: '',
    ...overrides,
  };
}

function waveKeys(plan) {
  return plan.waves.map((wave) => wave.tickets.map((entry) => entry.key));
}

function blockedByKey(plan, key) {
  return plan.blocked.find((entry) => entry.key === key);
}

function scheduledByKey(plan, key) {
  for (const wave of plan.waves) {
    const found = wave.tickets.find((entry) => entry.key === key);
    if (found) return found;
  }
  return null;
}

test('an empty set produces an empty plan', () => {
  const plan = planWaves([]);
  assert.deepEqual(plan.waves, []);
  assert.deepEqual(plan.blocked, []);
  assert.deepEqual(plan.cycles, []);
  assert.deepEqual(plan.badData, []);
  assert.equal(plan.stats.tickets, 0);
});

test('rejects anything that is not an array', () => {
  assert.throws(() => planWaves(null), TypeError);
  assert.throws(() => planWaves({ tickets: [] }), TypeError);
});

test('an orphan ticket with no relation lands in the first wave', () => {
  const plan = planWaves([ticket('ENG-1')]);
  assert.deepEqual(waveKeys(plan), [['ENG-1']]);
  assert.equal(plan.waves[0].number, FIRST_WAVE);
  assert.deepEqual(scheduledByKey(plan, 'ENG-1').unblocks, []);
});

test('a simple chain becomes one ticket per wave', () => {
  const plan = planWaves([
    ticket('ENG-1'),
    ticket('ENG-2', { blockedBy: ['id-ENG-1'] }),
    ticket('ENG-3', { blockedBy: ['id-ENG-2'] }),
  ]);
  assert.deepEqual(waveKeys(plan), [['ENG-1'], ['ENG-2'], ['ENG-3']]);
  assert.deepEqual(scheduledByKey(plan, 'ENG-1').unblocks, ['id-ENG-2']);
  assert.deepEqual(scheduledByKey(plan, 'ENG-3').unblocks, []);
  assert.equal(plan.stats.waves, 3);
});

test('independent tickets share the first wave', () => {
  const plan = planWaves([ticket('ENG-1'), ticket('ENG-2'), ticket('ENG-3')]);
  assert.deepEqual(waveKeys(plan), [['ENG-1', 'ENG-2', 'ENG-3']]);
});

test('blockedBy resolves a human key as well as an internal id', () => {
  const plan = planWaves([ticket('ENG-1'), ticket('ENG-2', { blockedBy: ['ENG-1'] })]);
  assert.deepEqual(waveKeys(plan), [['ENG-1'], ['ENG-2']]);
});

test('fan-in waits for every blocker and is flagged', () => {
  const plan = planWaves([
    ticket('ENG-1'),
    ticket('ENG-2'),
    ticket('ENG-3', { blockedBy: ['id-ENG-1', 'id-ENG-2'] }),
  ]);
  assert.deepEqual(waveKeys(plan), [['ENG-1', 'ENG-2'], ['ENG-3']]);
  const join = scheduledByKey(plan, 'ENG-3');
  assert.equal(join.fanIn, true);
  assert.deepEqual(join.waitingOn, ['id-ENG-1', 'id-ENG-2']);
});

test('fan-in takes the deepest blocker, not the first one', () => {
  const plan = planWaves([
    ticket('ENG-1'),
    ticket('ENG-2', { blockedBy: ['id-ENG-1'] }),
    ticket('ENG-3'),
    ticket('ENG-4', { blockedBy: ['id-ENG-2', 'id-ENG-3'] }),
  ]);
  assert.deepEqual(waveKeys(plan), [['ENG-1', 'ENG-3'], ['ENG-2'], ['ENG-4']]);
  assert.equal(scheduledByKey(plan, 'ENG-4').fanIn, true);
});

test('a single blocker is not fan-in', () => {
  const plan = planWaves([ticket('ENG-1'), ticket('ENG-2', { blockedBy: ['id-ENG-1'] })]);
  assert.equal(scheduledByKey(plan, 'ENG-2').fanIn, false);
});

test('a Done blocker is satisfied and does not push the dependent down a wave', () => {
  const plan = planWaves([
    ticket('ENG-1', { status: 'Done', statusType: 'completed' }),
    ticket('ENG-2', { blockedBy: ['id-ENG-1'] }),
  ]);
  assert.deepEqual(waveKeys(plan), [['ENG-2']]);
  assert.deepEqual(
    plan.done.map((entry) => entry.key),
    ['ENG-1'],
  );
  assert.deepEqual(scheduledByKey(plan, 'ENG-2').waitingOn, []);
  assert.equal(scheduledByKey(plan, 'ENG-2').blockedBy.length, 1);
});

test('a merged blocker is recognized by status name when the tracker sends no type', () => {
  assert.equal(isSatisfied({ status: 'Merged' }), true);
  assert.equal(isSatisfied({ status: 'done' }), true);
  assert.equal(isSatisfied({ status: 'In Review' }), false);
  assert.equal(isSatisfied({ status: 'In Review', statusType: 'completed' }), true);
});

test('a fan-in with one blocker already Done still counts as fan-in but waits on one', () => {
  const plan = planWaves([
    ticket('ENG-1', { status: 'Done', statusType: 'completed' }),
    ticket('ENG-2'),
    ticket('ENG-3', { blockedBy: ['id-ENG-1', 'id-ENG-2'] }),
  ]);
  const join = scheduledByKey(plan, 'ENG-3');
  assert.equal(join.fanIn, true);
  assert.deepEqual(join.waitingOn, ['id-ENG-2']);
  assert.equal(join.wave, FIRST_WAVE + 1);
});

test('a two-node cycle is reported and neither node is scheduled', () => {
  const plan = planWaves([
    ticket('ENG-1', { blockedBy: ['id-ENG-2'] }),
    ticket('ENG-2', { blockedBy: ['id-ENG-1'] }),
  ]);
  assert.deepEqual(waveKeys(plan), []);
  assert.deepEqual(plan.cycles, [['id-ENG-1', 'id-ENG-2']]);
  assert.equal(blockedByKey(plan, 'ENG-1').reason, BLOCKED_CYCLE);
  assert.equal(blockedByKey(plan, 'ENG-2').reason, BLOCKED_CYCLE);
  assert.match(blockedByKey(plan, 'ENG-1').detail, /dependency cycle with ENG-2/);
});

test('a three-node cycle is reported with all three nodes', () => {
  const plan = planWaves([
    ticket('ENG-1', { blockedBy: ['id-ENG-3'] }),
    ticket('ENG-2', { blockedBy: ['id-ENG-1'] }),
    ticket('ENG-3', { blockedBy: ['id-ENG-2'] }),
  ]);
  assert.deepEqual(plan.cycles, [['id-ENG-1', 'id-ENG-2', 'id-ENG-3']]);
  assert.equal(plan.stats.scheduled, 0);
  assert.equal(plan.blocked.length, 3);
});

test('a ticket blocking itself is a cycle, not a schedulable ticket', () => {
  const plan = planWaves([ticket('ENG-1', { blockedBy: ['id-ENG-1'] })]);
  assert.deepEqual(plan.cycles, [['id-ENG-1']]);
  assert.equal(blockedByKey(plan, 'ENG-1').reason, BLOCKED_CYCLE);
});

test('a cycle does not stop the rest of the graph from being scheduled', () => {
  const plan = planWaves([
    ticket('ENG-1'),
    ticket('ENG-2', { blockedBy: ['id-ENG-3'] }),
    ticket('ENG-3', { blockedBy: ['id-ENG-2'] }),
  ]);
  assert.deepEqual(waveKeys(plan), [['ENG-1']]);
  assert.equal(plan.cycles.length, 1);
});

test('a downstream ticket of a cycle is reported as upstream-blocked', () => {
  const plan = planWaves([
    ticket('ENG-1', { blockedBy: ['id-ENG-2'] }),
    ticket('ENG-2', { blockedBy: ['id-ENG-1'] }),
    ticket('ENG-3', { blockedBy: ['id-ENG-1'] }),
  ]);
  assert.equal(blockedByKey(plan, 'ENG-3').reason, BLOCKED_UPSTREAM);
  assert.deepEqual(blockedByKey(plan, 'ENG-3').blockers, ['id-ENG-1']);
});

test('a blocker id that exists nowhere is reported as bad data, never ignored', () => {
  const plan = planWaves([ticket('ENG-1'), ticket('ENG-2', { blockedBy: ['id-ENG-99'] })]);
  assert.deepEqual(waveKeys(plan), [['ENG-1']]);
  assert.deepEqual(plan.badData, [
    { id: 'id-ENG-2', key: 'ENG-2', missingBlockers: ['id-ENG-99'] },
  ]);
  assert.equal(blockedByKey(plan, 'ENG-2').reason, BLOCKED_UNKNOWN_BLOCKER);
  assert.match(blockedByKey(plan, 'ENG-2').detail, /unknown ticket id: id-ENG-99/);
});

test('an open external blocker leaves the dependent unscheduled, not in a later wave', () => {
  const plan = planWaves([
    ticket('ENG-1', { blockedBy: ['id-EXT-9'] }),
    ticket('EXT-9', { external: true, status: 'In Progress', statusType: 'started' }),
  ]);
  assert.deepEqual(waveKeys(plan), []);
  const entry = blockedByKey(plan, 'ENG-1');
  assert.equal(entry.reason, BLOCKED_EXTERNAL);
  assert.deepEqual(entry.rootCauses, ['id-EXT-9']);
  assert.match(entry.detail, /blocked externally by EXT-9 \(In Progress\)/);
  assert.deepEqual(plan.externals, [
    { id: 'id-EXT-9', key: 'EXT-9', status: 'In Progress', satisfied: false, blocks: ['id-ENG-1'] },
  ]);
  assert.equal(plan.blocked.length, 1);
});

test('a ticket downstream of an externally blocked ticket is not scheduled either', () => {
  const plan = planWaves([
    ticket('ENG-1', { blockedBy: ['id-EXT-9'] }),
    ticket('ENG-2', { blockedBy: ['id-ENG-1'] }),
    ticket('EXT-9', { external: true, status: 'In Progress', statusType: 'started' }),
  ]);
  assert.deepEqual(waveKeys(plan), []);
  const downstream = blockedByKey(plan, 'ENG-2');
  assert.equal(downstream.reason, BLOCKED_UPSTREAM);
  assert.deepEqual(downstream.rootCauses, ['id-EXT-9']);
  assert.match(downstream.detail, /waiting on ENG-1, itself blocked by EXT-9/);
});

test('an external blocker already Done is satisfied and the dependent is scheduled', () => {
  const plan = planWaves([
    ticket('ENG-1', { blockedBy: ['id-EXT-9'] }),
    ticket('EXT-9', { external: true, status: 'Done', statusType: 'completed' }),
  ]);
  assert.deepEqual(waveKeys(plan), [['ENG-1']]);
  assert.deepEqual(plan.blocked, []);
  assert.equal(plan.externals[0].satisfied, true);
  assert.deepEqual(
    plan.done.map((entry) => entry.key),
    [],
  );
});

test('an external blocker with unknown status counts as open', () => {
  const plan = planWaves([
    ticket('ENG-1', { blockedBy: ['id-EXT-9'] }),
    ticket('EXT-9', { external: true, status: null, statusType: null }),
  ]);
  assert.deepEqual(waveKeys(plan), []);
  assert.match(blockedByKey(plan, 'ENG-1').detail, /EXT-9 \(status unknown\)/);
});

test('the plan is identical whatever the input order is', () => {
  const tickets = [
    ticket('ENG-1'),
    ticket('ENG-2', { blockedBy: ['id-ENG-1'] }),
    ticket('ENG-3', { blockedBy: ['id-ENG-1'] }),
    ticket('ENG-4', { blockedBy: ['id-ENG-2', 'id-ENG-3'] }),
    ticket('ENG-5', { blockedBy: ['id-EXT-9'] }),
    ticket('ENG-6', { blockedBy: ['id-ENG-7'] }),
    ticket('ENG-7', { blockedBy: ['id-ENG-6'] }),
    ticket('ENG-8', { blockedBy: ['id-ENG-404'] }),
    ticket('ENG-9', { status: 'Done', statusType: 'completed' }),
    ticket('EXT-9', { external: true, status: 'In Progress', statusType: 'started' }),
  ];
  const reference = planWaves(tickets);
  assert.deepEqual(waveKeys(reference), [['ENG-1'], ['ENG-2', 'ENG-3'], ['ENG-4']]);

  const shuffles = [
    [...tickets].reverse(),
    [tickets[4], tickets[9], tickets[3], tickets[0], tickets[7], tickets[2], tickets[6], tickets[1], tickets[8], tickets[5]],
    [tickets[8], tickets[7], tickets[0], tickets[6], tickets[5], tickets[4], tickets[9], tickets[2], tickets[1], tickets[3]],
  ];
  for (const shuffled of shuffles) {
    assert.deepEqual(planWaves(shuffled), reference);
  }
});

test('ticket keys are ordered numerically, not lexicographically', () => {
  const plan = planWaves([ticket('ENG-10'), ticket('ENG-2'), ticket('ENG-1')]);
  assert.deepEqual(waveKeys(plan), [['ENG-1', 'ENG-2', 'ENG-10']]);
});

test('a ticket without a key falls back to its id for label and ordering', () => {
  const plan = planWaves([{ id: 'raw-1', blockedBy: [] }]);
  assert.equal(plan.labels['raw-1'], 'raw-1');
  assert.equal(plan.waves[0].tickets[0].key, null);
});

test('duplicate blocker ids are counted once', () => {
  const plan = planWaves([
    ticket('ENG-1'),
    ticket('ENG-2', { blockedBy: ['id-ENG-1', 'id-ENG-1'] }),
  ]);
  assert.deepEqual(scheduledByKey(plan, 'ENG-2').blockedBy, ['id-ENG-1']);
  assert.equal(scheduledByKey(plan, 'ENG-2').fanIn, false);
});

test('stats add up across every bucket', () => {
  const plan = planWaves([
    ticket('ENG-1'),
    ticket('ENG-2', { blockedBy: ['id-ENG-1'] }),
    ticket('ENG-3', { status: 'Done', statusType: 'completed' }),
    ticket('ENG-4', { blockedBy: ['id-EXT-9'] }),
    ticket('EXT-9', { external: true, status: 'Todo', statusType: 'unstarted' }),
  ]);
  assert.equal(plan.stats.tickets, 5);
  assert.equal(plan.stats.scheduled, 2);
  assert.equal(plan.stats.done, 1);
  assert.equal(plan.stats.blocked, 1);
  assert.equal(plan.stats.external, 1);
  assert.equal(plan.stats.waves, 2);
  assert.equal(WAVE_DONE, 0);
});
