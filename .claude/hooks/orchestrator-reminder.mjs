#!/usr/bin/env node
// UserPromptSubmit hook: reinforce the orchestrator's delegation contract on
// every turn.
//
// Why: the orchestrator's system prompt is loaded once at session start. As a
// long session grows, that prompt's relative weight in the context shrinks and
// the "trivial → do it yourself" escape hatch starts dominating. This hook
// reinjects a short, stable reminder of the delegation rules every time the
// user submits a prompt, keeping the routing posture fresh turn-to-turn.
//
// What: emits JSON on stdout in the shape Claude Code expects for
// UserPromptSubmit hooks:
//   { "hookSpecificOutput": { "hookEventName": "UserPromptSubmit",
//                             "additionalContext": "<reminder>" } }
//
// When: runs on every user prompt. Stdin carries the prompt payload; we
// consume and discard it so the pipe doesn't break, but the reminder text is
// stable (no per-turn variation).
//
// Opt out by exporting CLAUDE_SETUP_SKIP_ORCH_REMINDER=1.
//
// Never blocks the turn: every failure path exits 0 with empty stdout.
//
// Requires Node.js 24+.

import process from 'node:process';

const REMINDER =
  '[orchestrator reminder] Before answering: (1) is this multi-step or multi-area? spawn agents in parallel — one message, multiple Agent calls. (2) Research/plan/edit/review/test work is NEVER trivial — delegate to explorer/planner/implementer/reviewer/tester. (3) Trivial = one read OR one grep OR one obvious shell command. (4) When in doubt, delegate. Anti-patterns: reading 4+ files yourself, writing long plans inline, editing non-trivial code directly, running lint/test in Bash yourself.';

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
      hookEventName: 'UserPromptSubmit',
      additionalContext: REMINDER,
    },
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

try {
  await main();
} catch (err) {
  process.stderr.write(`claude-setup: orchestrator-reminder error: ${err.message}\n`);
}
process.exit(0);
