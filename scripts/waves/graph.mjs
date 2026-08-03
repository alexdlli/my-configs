#!/usr/bin/env node
// Wave planner for the ticket dependency graph.
//
// `planWaves()` is pure — no filesystem, no network, no child process. It takes
// the normalized ticket array produced by tickets-github.mjs and returns the
// wave plan. The block at the bottom is a thin stdin/stdout wrapper so the
// read-only pipeline can run:
//
//   node tickets-github.mjs --repo <owner>/<repo> --json | node graph.mjs --json
//
// Usage:
//   node graph.mjs [--json] < tickets.json
//   node graph.mjs -h | --help
//
// Exit codes: 0 plan produced, 2 unusable input, 3 plan is incomplete
// (dependency cycle or blockedBy pointing at an unknown id).

import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const WAVE_DONE = 0;
export const FIRST_WAVE = 1;

export const BLOCKED_EXTERNAL = 'external';
export const BLOCKED_CYCLE = 'cycle';
export const BLOCKED_UNKNOWN_BLOCKER = 'unknown-blocker';
export const BLOCKED_UPSTREAM = 'upstream';

// A blocker counts as satisfied either by the tracker's own state type (the
// reader maps a closed-as-completed issue to `completed`) or by a display name
// the harness treats as merged.
const SATISFIED_STATUS_TYPE = 'completed';
const SATISFIED_STATUS_NAMES = new Set(['done', 'merged', 'completed']);

const FAN_IN_BLOCKER_COUNT = 2;

const EXIT_INVALID_INPUT = 2;
const EXIT_INCOMPLETE_PLAN = 3;

const SORT_LOCALE = 'en';
const SORT_OPTIONS = { numeric: true };

/**
 * True when the ticket is already merged, so it satisfies anything it blocks.
 *
 * @param {object} ticket normalized ticket
 * @returns {boolean}
 */
export function isSatisfied(ticket) {
  if (ticket.statusType === SATISFIED_STATUS_TYPE) return true;
  const status = typeof ticket.status === 'string' ? ticket.status.trim().toLowerCase() : '';
  return SATISFIED_STATUS_NAMES.has(status);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return [...new Set(values)];
}

function displayLabel(ticket) {
  return ticket.key ?? ticket.id;
}

function compareLabels(a, b) {
  return String(a).localeCompare(String(b), SORT_LOCALE, SORT_OPTIONS);
}

function buildIndex(tickets) {
  const byId = new Map();
  for (const ticket of tickets) byId.set(ticket.id, ticket);
  const byKey = new Map();
  for (const ticket of tickets) {
    if (typeof ticket.key === 'string' && !byId.has(ticket.key)) byKey.set(ticket.key, ticket.id);
  }
  return { byId, byKey };
}

function resolveBlockerId(raw, index) {
  if (index.byId.has(raw)) return raw;
  return index.byKey.get(raw) ?? null;
}

// Tarjan, iterative so a deep chain cannot blow the stack. Components come back
// in reverse topological order of the condensation: since an edge points from a
// ticket to its blocker, every blocker's component is emitted before the
// component that depends on it.
function stronglyConnectedComponents(ids, edgesOf) {
  const index = new Map();
  const lowLink = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  let counter = 0;

  const open = (id) => {
    index.set(id, counter);
    lowLink.set(id, counter);
    counter += 1;
    stack.push(id);
    onStack.add(id);
  };

  for (const root of ids) {
    if (index.has(root)) continue;
    open(root);
    const work = [{ id: root, edges: edgesOf(root), cursor: 0 }];

    while (work.length > 0) {
      const frame = work.at(-1);
      if (frame.cursor < frame.edges.length) {
        const next = frame.edges[frame.cursor];
        frame.cursor += 1;
        if (!index.has(next)) {
          open(next);
          work.push({ id: next, edges: edgesOf(next), cursor: 0 });
        } else if (onStack.has(next)) {
          lowLink.set(frame.id, Math.min(lowLink.get(frame.id), index.get(next)));
        }
        continue;
      }

      work.pop();
      const parent = work.at(-1);
      if (parent) {
        lowLink.set(parent.id, Math.min(lowLink.get(parent.id), lowLink.get(frame.id)));
      }
      if (lowLink.get(frame.id) === index.get(frame.id)) {
        const component = [];
        let member;
        do {
          member = stack.pop();
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.id);
        components.push(component);
      }
    }
  }

  return components;
}

function describeBlock(blocked, ctx) {
  const { labelOf, statusOf } = ctx;
  const join = (ids) => ids.map(labelOf).join(', ');
  switch (blocked.reason) {
    case BLOCKED_CYCLE:
      return `in a dependency cycle with ${join(blocked.blockers)}`;
    case BLOCKED_UNKNOWN_BLOCKER:
      return `blockedBy points at an unknown ticket id: ${blocked.blockers.join(', ')}`;
    case BLOCKED_EXTERNAL:
      return `blocked externally by ${blocked.blockers
        .map((id) => `${labelOf(id)} (${statusOf(id)})`)
        .join(', ')}`;
    default:
      return `waiting on ${join(blocked.blockers)}, itself blocked by ${join(blocked.rootCauses)}`;
  }
}

/**
 * Turns normalized tickets into an ordered wave plan.
 *
 * @param {object[]} tickets normalized tickets, external blockers included
 * @returns {object} plan with waves, done, blocked, cycles, badData, externals,
 *   labels and stats
 */
export function planWaves(tickets) {
  if (!Array.isArray(tickets)) {
    throw new TypeError('planWaves expects an array of normalized tickets');
  }

  const index = buildIndex(tickets);
  const labelOf = (id) => {
    const ticket = index.byId.get(id);
    return ticket ? displayLabel(ticket) : id;
  };
  const statusOf = (id) => index.byId.get(id)?.status ?? 'status unknown';
  const orderedIds = [...index.byId.keys()].sort((a, b) => compareLabels(labelOf(a), labelOf(b)));

  const blockersOf = new Map();
  const missingBlockersOf = new Map();
  for (const id of orderedIds) {
    const resolved = [];
    const missing = [];
    for (const raw of asArray(index.byId.get(id).blockedBy)) {
      const blockerId = resolveBlockerId(raw, index);
      if (blockerId === null) missing.push(raw);
      else if (!resolved.includes(blockerId)) resolved.push(blockerId);
    }
    blockersOf.set(id, resolved);
    if (missing.length > 0) missingBlockersOf.set(id, unique(missing));
  }

  const resolution = new Map();
  const pendingIds = [];
  for (const id of orderedIds) {
    const ticket = index.byId.get(id);
    if (isSatisfied(ticket)) {
      resolution.set(id, { wave: WAVE_DONE });
    } else if (ticket.external === true) {
      resolution.set(id, {
        blocked: { reason: BLOCKED_EXTERNAL, blockers: [id], rootCauses: [id] },
      });
    } else {
      pendingIds.push(id);
    }
  }

  const pending = new Set(pendingIds);
  const pendingBlockersOf = (id) => blockersOf.get(id).filter((blockerId) => pending.has(blockerId));

  const resolvePending = (id) => {
    const missing = missingBlockersOf.get(id);
    if (missing) {
      return {
        blocked: { reason: BLOCKED_UNKNOWN_BLOCKER, blockers: missing, rootCauses: missing },
      };
    }
    const own = blockersOf.get(id);
    const blockedOnes = own.filter((blockerId) => resolution.get(blockerId).blocked);
    if (blockedOnes.length > 0) {
      const externalOnes = blockedOnes.filter((blockerId) => index.byId.get(blockerId).external === true);
      if (externalOnes.length > 0) {
        return {
          blocked: { reason: BLOCKED_EXTERNAL, blockers: externalOnes, rootCauses: externalOnes },
        };
      }
      const rootCauses = unique(
        blockedOnes.flatMap((blockerId) => resolution.get(blockerId).blocked.rootCauses),
      );
      return { blocked: { reason: BLOCKED_UPSTREAM, blockers: blockedOnes, rootCauses } };
    }
    const blockerWaves = own.map((blockerId) => resolution.get(blockerId).wave);
    return { wave: Math.max(WAVE_DONE, ...blockerWaves) + 1 };
  };

  const cycles = [];
  for (const component of stronglyConnectedComponents(pendingIds, pendingBlockersOf)) {
    const isCycle =
      component.length > 1 || pendingBlockersOf(component[0]).includes(component[0]);
    if (!isCycle) {
      resolution.set(component[0], resolvePending(component[0]));
      continue;
    }
    const members = [...component].sort((a, b) => compareLabels(labelOf(a), labelOf(b)));
    cycles.push(members);
    for (const id of members) {
      resolution.set(id, {
        blocked: {
          reason: BLOCKED_CYCLE,
          blockers: members.filter((member) => member !== id),
          rootCauses: members,
        },
      });
    }
  }

  const scheduledIds = pendingIds.filter((id) => resolution.get(id).wave !== undefined);
  const scheduled = new Set(scheduledIds);
  const dependentsOf = new Map();
  for (const id of scheduledIds) {
    for (const blockerId of blockersOf.get(id)) {
      if (!dependentsOf.has(blockerId)) dependentsOf.set(blockerId, []);
      dependentsOf.get(blockerId).push(id);
    }
  }

  const byWave = new Map();
  for (const id of scheduledIds) {
    const ticket = index.byId.get(id);
    const own = blockersOf.get(id);
    const view = {
      id,
      key: ticket.key ?? null,
      title: ticket.title ?? null,
      estimate: ticket.estimate ?? null,
      status: ticket.status ?? null,
      wave: resolution.get(id).wave,
      blockedBy: own,
      waitingOn: own.filter((blockerId) => scheduled.has(blockerId)),
      fanIn: own.length >= FAN_IN_BLOCKER_COUNT,
      unblocks: dependentsOf.get(id) ?? [],
    };
    if (!byWave.has(view.wave)) byWave.set(view.wave, []);
    byWave.get(view.wave).push(view);
  }

  const waves = [...byWave.keys()]
    .sort((a, b) => a - b)
    .map((number) => ({ number, tickets: byWave.get(number) }));

  const describeCtx = { labelOf, statusOf };
  const blocked = pendingIds
    .filter((id) => resolution.get(id).blocked)
    .map((id) => {
      const ticket = index.byId.get(id);
      const info = resolution.get(id).blocked;
      return {
        id,
        key: ticket.key ?? null,
        title: ticket.title ?? null,
        reason: info.reason,
        blockers: info.blockers,
        rootCauses: info.rootCauses,
        detail: describeBlock(info, describeCtx),
      };
    });

  const done = orderedIds
    .filter((id) => resolution.get(id).wave === WAVE_DONE && index.byId.get(id).external !== true)
    .map((id) => {
      const ticket = index.byId.get(id);
      return { id, key: ticket.key ?? null, title: ticket.title ?? null, status: ticket.status ?? null };
    });

  const externals = orderedIds
    .filter((id) => index.byId.get(id).external === true)
    .map((id) => {
      const ticket = index.byId.get(id);
      return {
        id,
        key: ticket.key ?? null,
        status: ticket.status ?? null,
        satisfied: isSatisfied(ticket),
        blocks: orderedIds.filter((other) => blockersOf.get(other).includes(id)),
      };
    });

  const badData = [...missingBlockersOf.entries()].map(([id, missing]) => ({
    id,
    key: index.byId.get(id).key ?? null,
    missingBlockers: missing,
  }));

  const labels = Object.fromEntries(orderedIds.map((id) => [id, labelOf(id)]));

  return {
    waves,
    done,
    blocked,
    cycles,
    badData,
    externals,
    labels,
    stats: {
      tickets: orderedIds.length,
      scheduled: scheduledIds.length,
      done: done.length,
      blocked: blocked.length,
      external: externals.length,
      waves: waves.length,
    },
  };
}

function usage() {
  console.log(`Turn a normalized ticket array into a wave plan.

Usage:
  node tickets-github.mjs --repo <owner>/<repo> --json | node graph.mjs [--json]

Options:
  --json     Emit the plan as JSON instead of a readable summary
  -h, --help Show this help

Exit codes:
  0  plan produced
  2  unusable input
  3  plan is incomplete (dependency cycle or unknown blocker id)`);
}

function renderPlan(plan) {
  const labelOf = (id) => plan.labels[id] ?? id;
  const join = (ids) => ids.map(labelOf).join(', ');
  const lines = [];

  if (plan.waves.length === 0) lines.push('no schedulable ticket');
  for (const wave of plan.waves) {
    lines.push(`wave ${wave.number}: ${wave.tickets.map((t) => labelOf(t.id)).join(', ')}`);
    for (const ticket of wave.tickets) {
      const notes = [];
      if (ticket.fanIn) {
        notes.push(`fan-in, starts only when all of ${join(ticket.blockedBy)} merge`);
      } else if (ticket.waitingOn.length > 0) {
        notes.push(`waits on ${join(ticket.waitingOn)}`);
      }
      if (ticket.unblocks.length > 0) notes.push(`unblocks ${join(ticket.unblocks)}`);
      if (notes.length > 0) lines.push(`  ${labelOf(ticket.id)} — ${notes.join('; ')}`);
    }
  }

  if (plan.done.length > 0) {
    lines.push(`done (wave ${WAVE_DONE}): ${plan.done.map((t) => labelOf(t.id)).join(', ')}`);
  }
  for (const entry of plan.blocked) {
    lines.push(`not scheduled: ${labelOf(entry.id)} — ${entry.detail}`);
  }
  for (const cycle of plan.cycles) {
    lines.push(`cycle: ${[...cycle, cycle[0]].map(labelOf).join(' -> ')}`);
  }
  for (const entry of plan.badData) {
    lines.push(`bad data: ${labelOf(entry.id)} blockedBy ${entry.missingBlockers.join(', ')} (unknown id)`);
  }

  const { stats } = plan;
  lines.push(
    `${stats.tickets} ticket(s): ${stats.scheduled} scheduled in ${stats.waves} wave(s), ` +
      `${stats.done} done, ${stats.blocked} not scheduled, ${stats.external} external`,
  );
  return lines.join('\n');
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function fail(message, code) {
  console.error(`! error: ${message}`);
  process.exit(code);
}

async function main(args) {
  if (args.includes('-h') || args.includes('--help')) {
    usage();
    return;
  }
  const asJson = args.includes('--json');
  const unknown = args.filter((arg) => arg !== '--json');
  if (unknown.length > 0) {
    fail(`unknown option: ${unknown[0]}`, EXIT_INVALID_INPUT);
  }
  if (process.stdin.isTTY) {
    fail('nothing on stdin — pipe the output of tickets-github.mjs --json', EXIT_INVALID_INPUT);
  }

  const raw = await readStdin();
  if (raw.trim().length === 0) {
    fail(
      'empty stdin — the ticket reader upstream produced nothing; run it on its own to see why it failed',
      EXIT_INVALID_INPUT,
    );
  }
  let tickets;
  try {
    tickets = JSON.parse(raw);
  } catch (err) {
    fail(`stdin is not valid JSON: ${err.message}`, EXIT_INVALID_INPUT);
  }

  let plan;
  try {
    plan = planWaves(tickets);
  } catch (err) {
    fail(err.message, EXIT_INVALID_INPUT);
  }

  console.log(asJson ? JSON.stringify(plan, null, 2) : renderPlan(plan));
  if (plan.cycles.length > 0 || plan.badData.length > 0) {
    console.error('! the plan is incomplete: fix the cycles and the unknown blocker ids first');
    process.exit(EXIT_INCOMPLETE_PLAN);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).catch((err) => {
    fail(err.message, EXIT_INVALID_INPUT);
  });
}
