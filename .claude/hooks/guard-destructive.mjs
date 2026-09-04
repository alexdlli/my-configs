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
// FAILS OPEN FOR ORDINARY COMMANDS, CLOSED FOR DESTRUCTIVE-LOOKING ONES. A
// guard that denies on its own bug turns a typo into a dead Bash tool, so any
// internal error still exits 0 with no decision and the command falls back to
// the permission layer — but only after DESTRUCTIVE_LOOKALIKE has had a look.
// The guard denies only by writing JSON on stdout, so "the guard did not run"
// and "the guard allowed it" are the same observation from the outside: under
// --dangerously-skip-permissions a lib/ that failed to load used to mean
// `git push --force` passing in silence. Hence the dynamic import below —
// a static one fails at module resolution, before any try/catch here can run.
// The lookalike pattern lives in this file, and imports nothing, for the same
// reason: a fallback that depends on the module that may be missing protects
// nothing.
//
// The other deliberate exception is the worker question itself —
// `detectWorkerContext` answers `indeterminate` rather than throwing, and
// `indeterminate` denies. Its own header carries why.
//
// Requires Node.js 24+.

import process from 'node:process';
import { fileURLToPath } from 'node:url';

const GUARDED_TOOL = 'Bash';

const ALLOW_MERGE_REASON =
  'guard-destructive: control branch (integration/* or wave/*) — merging here is the agent\'s to do.';

const LIB_DIR = fileURLToPath(new URL('./lib/', import.meta.url));

// Last-resort pattern for when the classifier cannot run. Intentionally coarse
// and intentionally NOT a second classifier: it only has to recognise the shape
// of the four history-touching rules, envelope and all, since `[\s\S]*` walks
// straight through `bash -c "…"` and any quoting. A false positive costs one
// blocked command with a message saying how to fix the install; a false
// negative costs a force-push. `git merge` is in here too — without the lib
// there is no reading the destination branch, and an unverifiable merge is
// exactly the case this refuses.
//
// The endless-background-loop rule is deliberately absent. Recognising it
// coarsely means matching `while`/`true`, which fires on `grep -rn 'while true'
// docs/` and on every doc that quotes the rule — the false positives land on
// ordinary work, and a leaked loop is still killable, while a rewritten history
// is not. Mirrors DESTRUCTIVE_LOOKALIKE in .opencode/plugin/guard-destructive.js;
// the two are meant to stay identical.
const DESTRUCTIVE_LOOKALIKE =
  /\bgh\b[\s\S]*\bpr\b[\s\S]*\bmerge\b|\bgit\b[\s\S]*\bpush\b[\s\S]*(\s-f\b|\s--force\b)|\bgit\b[\s\S]*\bcommit\b[\s\S]*(\s-n\b|\s--no-verify\b)|\bgit\b[\s\S]*\bmerge\b/;

function unavailableReason(detail) {
  return (
    `guard-destructive: the classifier could not run (${detail}), and this command looks ` +
    'destructive (gh pr merge / git push --force / git commit --no-verify / git merge). The ' +
    'guard refuses what it cannot classify, so this is a refusal and not a verdict about the ' +
    `command. The classifier is expected under ${LIB_DIR} — run \`node scripts/install.mjs\` ` +
    'from the harness checkout to restore it, then retry. Commands that do not look destructive ' +
    'are unaffected.'
  );
}

async function loadClassifier() {
  const [destructive, worker, merge] = await Promise.all([
    import('./lib/destructive.mjs'),
    import('./lib/worker-context.mjs'),
    import('./lib/merge-destination.mjs'),
  ]);
  return { destructive, worker, merge };
}

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

// Claude Code reads one JSON object from stdout. The catch-all below can fire
// after a decision was already written, and two objects parse as none.
let decided = false;

function decide(permissionDecision, permissionDecisionReason) {
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision,
      permissionDecisionReason,
    },
  };
  decided = true;
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

function refuseUnavailable(command, detail) {
  if (decided) return;
  if (typeof command !== 'string' || !DESTRUCTIVE_LOOKALIKE.test(command)) return;
  decide('deny', unavailableReason(detail));
}

async function main(payload) {
  const lib = await loadClassifier();
  const {
    classifyCommand,
    denialReason,
    isBranchScopedRule,
    isWorkerOnlyRule,
  } = lib.destructive;
  const { CONTEXT_INDETERMINATE, CONTEXT_OTHER, detectWorkerContext } = lib.worker;
  const {
    DESTINATION_CONTROL,
    DESTINATION_INDETERMINATE,
    DESTINATION_OTHER,
    classifyMergeDestination,
  } = lib.merge;

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

// The opt-out is checked before anything else and turns off the fallback too:
// it means "no guard", not "a smaller guard".
if (process.env.CLAUDE_SETUP_SKIP_GUARD_DESTRUCTIVE !== '1') {
  let payload = null;
  try {
    payload = await readHookPayload();
    if (payload?.tool_name === GUARDED_TOOL) await main(payload);
  } catch (err) {
    process.stderr.write(`claude-setup: guard-destructive error: ${err.message}\n`);
    refuseUnavailable(payload?.tool_input?.command, err.message);
  }
}
process.exit(0);
