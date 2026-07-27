#!/usr/bin/env node
// PreToolUse hook (Bash matcher): deny the three commands the harness reserves
// for the human — `gh pr merge`, `git push --force`, `git commit --no-verify`
// — including when they are wrapped in `bash -c` or piped into a shell.
//
// Why: `permissions.deny` was measured to survive
// `--dangerously-skip-permissions`, but it matches strings, so it only ever
// sees the literal form. Under bypass there is no approval prompt behind it
// either. Wave workers run with the bypass on by default, so the wrapped form
// was a real hole in the dispatch flow. A PreToolUse hook returning
// `permissionDecision: "deny"` is evaluated under bypass and closes it.
//
// What: emits JSON on stdout in the shape Claude Code expects for PreToolUse
// hooks, and nothing at all when the command is allowed:
//   { "hookSpecificOutput": { "hookEventName": "PreToolUse",
//                             "permissionDecision": "deny",
//                             "permissionDecisionReason": "<why + what to do>" } }
//
// The classification lives in lib/destructive.mjs, including the threat model
// and what it deliberately does not catch. See docs/guard-destructive.md.
//
// Opt out by exporting CLAUDE_SETUP_SKIP_GUARD_DESTRUCTIVE=1. The denial
// message does not mention it: the agent being stopped is not the one who
// gets to decide the guard should be off.
//
// Fails open, always: a guard that denies on its own bug turns a typo into a
// dead Bash tool. Every failure path exits 0 having printed no decision, so
// the command falls back to the permission layer.
//
// Requires Node.js 24+.

import process from 'node:process';
import { classifyCommand, denialReason } from './lib/destructive.mjs';

const GUARDED_TOOL = 'Bash';

async function readHookPayload() {
  if (process.stdin.isTTY) return null;
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function main() {
  if (process.env.CLAUDE_SETUP_SKIP_GUARD_DESTRUCTIVE === '1') return;

  const payload = await readHookPayload();
  if (payload?.tool_name !== GUARDED_TOOL) return;

  const finding = classifyCommand(payload?.tool_input?.command);
  if (!finding.blocked) return;

  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: denialReason(finding),
    },
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

try {
  await main();
} catch (err) {
  process.stderr.write(
    `claude-setup: guard-destructive error (command allowed through): ${err.message}\n`,
  );
}
process.exit(0);
