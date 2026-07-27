#!/usr/bin/env node
// SessionStart hook + CLI: tell the session which terminal host it runs in and
// which tracker/account applies, without spending an agent turn to find out.
//
// As a hook: emits JSON on stdout in the shape Claude Code expects for
// SessionStart hooks:
//   { "hookSpecificOutput": { "hookEventName": "SessionStart",
//                             "additionalContext": "<up to 4 lines>" } }
// Only the actionable facts go in — the host, and what changes because of it.
// On a plain terminal nothing is injected at all.
//
// As a CLI: `--json` prints the raw context object for skills to consume, and
// `--verify-account` adds the git-identity account check (one subprocess, never
// run on the hook path).
//
// Opt out of the automatic injection by exporting
// CLAUDE_SETUP_SKIP_SESSION_CONTEXT=1. An explicit `--json` invocation still
// answers, so the switch silences the session without breaking the skills.
//
// Never blocks a session: every failure path exits 0.
//
// Requires Node.js 24+.

import process from 'node:process';
import {
  HOST_MAESTRI,
  HOST_ORCA,
  detectContext,
  verifyAccount,
} from './lib/context.mjs';

const MAESTRI_PATH_RULE =
  'maestri is NOT on PATH in zsh — always invoke it as "$MAESTRI_CLI", never as "maestri"';

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

function contextLines(ctx) {
  const lines = [];

  if (ctx.host === HOST_MAESTRI) {
    lines.push('[session context] host: Maestri terminal');
    lines.push(MAESTRI_PATH_RULE);
  } else if (ctx.host === HOST_ORCA) {
    lines.push('[session context] host: Orca terminal');
    if (ctx.repoRoot) lines.push(`worktree: ${ctx.repoRoot}`);
  }

  if (lines.length > 0 && ctx.tracker) {
    lines.push(`tracker: ${ctx.tracker} (cwd under ~/work — work GitHub account)`);
  }
  return lines;
}

async function main() {
  const args = process.argv.slice(2);
  const wantsAccountCheck = args.includes('--verify-account');

  if (args.includes('--json') || wantsAccountCheck) {
    const ctx = detectContext();
    if (wantsAccountCheck) ctx.accountCheck = verifyAccount();
    process.stdout.write(`${JSON.stringify(ctx, null, 2)}\n`);
    return;
  }

  if (process.env.CLAUDE_SETUP_SKIP_SESSION_CONTEXT === '1') return;

  const payload = await readHookPayload();
  const cwd = typeof payload?.cwd === 'string' ? payload.cwd : process.cwd();
  const lines = contextLines(detectContext(process.env, cwd));
  if (lines.length === 0) return;

  const output = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: lines.join('\n'),
    },
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

try {
  await main();
} catch (err) {
  process.stderr.write(`claude-setup: session-context error: ${err.message}\n`);
}
process.exit(0);
