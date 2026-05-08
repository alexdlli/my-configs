#!/usr/bin/env node
// PreCompact hook: keep the orchestrator's identity and delegation protocol
// alive through context compaction.
//
// Why: when Claude Code auto-compacts a long session, the generated summary
// can drop the coordinator framing and the parallel-delegation rule. Without
// reinforcement, the model drifts back to direct execution after compaction.
// This hook injects an identity-preserving directive that the compactor sees
// while building the new context, so the post-compact session still behaves
// like an orchestrator.
//
// What: emits JSON on stdout in the shape Claude Code expects for
// PreCompact hooks:
//   { "hookSpecificOutput": { "hookEventName": "PreCompact",
//                             "additionalContext": "<directive>" } }
//
// When: fires on both `auto` and `manual` compaction triggers (configured via
// the matcher in settings.json). Stdin carries the trigger payload; we drain
// and discard it.
//
// Opt out by exporting CLAUDE_SETUP_SKIP_ORCH_REMINDER=1 (shared with the
// UserPromptSubmit reminder — one switch covers both nudges).
//
// Never blocks compaction: every failure path exits 0 with empty stdout.
//
// Requires Node.js 24+.

import process from 'node:process';

const DIRECTIVE =
  '[orchestrator identity — preserve through compaction] You are the orchestrator agent. Your job is to delegate to specialist subagents (explorer, planner, implementer, reviewer, tester, pr-author, pr-reviewer) — NOT to execute their work yourself. After this compaction, your default behavior is delegation. Spawn independent subtasks in parallel via multiple Agent calls in a single response. Trivial work (one read, one grep, one obvious command) is the only exception. Re-read .claude/agents/orchestrator.md if uncertain about routing.';

async function drainStdin() {
  if (process.stdin.isTTY) return;
  for await (const _chunk of process.stdin) {
    // discard
  }
}

async function main() {
  if (process.env.CLAUDE_SETUP_SKIP_ORCH_REMINDER === '1') return;

  await drainStdin();

  const payload = {
    hookSpecificOutput: {
      hookEventName: 'PreCompact',
      additionalContext: DIRECTIVE,
    },
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

try {
  await main();
} catch (err) {
  process.stderr.write(`claude-setup: preserve-orchestrator error: ${err.message}\n`);
}
process.exit(0);
