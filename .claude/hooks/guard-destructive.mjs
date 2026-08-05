#!/usr/bin/env node
// PreToolUse hook (Bash matcher): deny `git push --force` and
// `git commit --no-verify` everywhere, and deny `gh pr merge` in a wave worker
// — including when any of them is wrapped in `bash -c` or piped into a shell.
//
// Why: `permissions.deny` was measured to survive
// `--dangerously-skip-permissions`, but it matches strings, so it only ever
// sees the literal form. Under bypass there is no approval prompt behind it
// either. Wave workers run with the bypass on by default, so the wrapped form
// was a real hole in the dispatch flow. A PreToolUse hook returning
// `permissionDecision: "deny"` is evaluated under bypass and closes it.
//
// ASK-THEN-MERGE. `Bash(gh pr merge *)` is no longer in `permissions.deny`, so
// this hook is the only thing standing between an agent and a merge, and it is
// the only thing that can tell a worker from the coordinator. Staying silent for
// a non-worker is what lets the command reach the permission prompt where Alex
// approves it — that is the feature, not a gap. Force-push and `--no-verify` are
// untouched by this and stay denied in every context.
//
// MERGE AUTONOMY, `git merge` only. A merge lands on the branch the session is
// standing on, so this hook can read the destination offline and decide: allow
// on a control branch (`integration/*`, `wave/*`), deny on a protected one
// (`main`, `master`, `prod`, `staging`), stay silent in between so the
// permission prompt decides. `gh pr merge` gets none of this and stays human —
// its destination is the PR's base branch on GitHub, and establishing that
// means a network call on every Bash command. The asymmetry is the point:
// what the guard can verify offline is what it is allowed to grant.
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
// the command falls back to the permission layer. The one deliberate exception
// is the worker question itself — `detectWorkerContext` answers `indeterminate`
// rather than throwing, and `indeterminate` denies. Its own header carries why.
//
// Requires Node.js 24+.

import process from 'node:process';
import {
  classifyCommand,
  denialReason,
  isBranchScopedRule,
  isWorkerOnlyRule,
} from './lib/destructive.mjs';
import {
  CONTEXT_INDETERMINATE,
  CONTEXT_OTHER,
  detectWorkerContext,
} from './lib/worker-context.mjs';
import {
  DESTINATION_CONTROL,
  DESTINATION_INDETERMINATE,
  DESTINATION_OTHER,
  classifyMergeDestination,
} from './lib/merge-destination.mjs';

const GUARDED_TOOL = 'Bash';

const ALLOW_MERGE_REASON =
  'guard-destructive: control branch (integration/* or wave/*) — merging here is the agent\'s to do.';

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

function decide(permissionDecision, permissionDecisionReason) {
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision,
      permissionDecisionReason,
    },
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

async function main() {
  if (process.env.CLAUDE_SETUP_SKIP_GUARD_DESTRUCTIVE === '1') return;

  const payload = await readHookPayload();
  if (payload?.tool_name !== GUARDED_TOOL) return;

  const finding = classifyCommand(payload?.tool_input?.command);
  if (!finding.blocked) return;

  let undetermined = false;
  if (isWorkerOnlyRule(finding.rule)) {
    const context = detectWorkerContext(process.env, payload?.cwd);
    if (context === CONTEXT_OTHER) return;
    undetermined = context === CONTEXT_INDETERMINATE;
  }

  let destination;
  if (isBranchScopedRule(finding.rule)) {
    if (finding.redirected) {
      destination = 'redirected';
    } else {
      const landing = classifyMergeDestination(process.env, payload?.cwd);
      // A control branch is the one place the agent decides on its own, so the
      // hook says `allow` outright instead of staying silent: silence would
      // still cost Alex a prompt, and the point of the allowlist is that it
      // does not.
      if (landing === DESTINATION_CONTROL) {
        decide('allow', ALLOW_MERGE_REASON);
        return;
      }
      // Neither control nor protected: not the agent's call, not a refusal
      // either. Falling through hands it to the permission prompt.
      if (landing === DESTINATION_OTHER) return;
      if (landing === DESTINATION_INDETERMINATE) destination = 'indeterminate';
    }
  }

  decide('deny', denialReason(finding, { undetermined, destination }));
}

try {
  await main();
} catch (err) {
  process.stderr.write(
    `claude-setup: guard-destructive error (command allowed through): ${err.message}\n`,
  );
}
process.exit(0);
