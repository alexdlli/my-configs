// Where a `git merge` would land, resolved offline.
//
// This is what makes `git merge` different from `gh pr merge` and the reason
// only the first one can be delegated to an agent at all. `gh pr merge` names a
// PR whose base branch lives on GitHub: deciding it is safe means a network
// call, inside a PreToolUse hook, on every command. `git merge` has no
// destination argument — it always lands on the current HEAD — so the
// destination is readable from the checkout with two file reads and no network.
// `gh pr merge` stays human for that reason and no other.
//
// POLICY. A control branch exists to be merged into: it is the wave's or the
// integration's own staging ground, and a wrong merge there is undone with
// `git reset --hard` on a branch nobody else has. The protected names are the
// opposite and are listed EXPLICITLY rather than left to fall off the allowlist:
// an allowlist that denies `main` only by not mentioning it goes silently
// permissive the day someone adds a prefix, and the branch that must never be
// merged into by an agent would be the one it stopped naming.
//
// FAILS CLOSED, like worker-context.mjs and for the same reason: every path
// that cannot answer returns `indeterminate`, which the caller denies. A merge
// wrongly blocked costs one message; a merge wrongly allowed costs history on a
// branch other people pull.
//
// Requires Node.js 24+.

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const DESTINATION_CONTROL = 'control';
export const DESTINATION_PROTECTED = 'protected';
export const DESTINATION_OTHER = 'other';
export const DESTINATION_INDETERMINATE = 'indeterminate';

export const PROJECT_DIR_VAR = 'CLAUDE_PROJECT_DIR';

// Branches an agent may merge into on its own.
export const CONTROL_BRANCH_PREFIXES = ['integration/', 'wave/'];

// Never merged into by an agent, named one by one on purpose.
export const PROTECTED_BRANCHES = new Set(['main', 'master', 'prod', 'staging']);

const GIT_ENTRY = '.git';
const HEAD_FILE = 'HEAD';
const BRANCH_REF_PREFIX = 'ref: refs/heads/';
// `.git` in a linked worktree is a file pointing at the real git dir.
const GITDIR_POINTER = /^gitdir:\s*(.+)$/m;

const BRANCH_UNRESOLVED = null;

function usableAnchor(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// Resolves the git directory holding HEAD for `startDir`, walking up until a
// `.git` entry appears. A linked worktree has its own HEAD under
// `<main>/.git/worktrees/<name>`, which is exactly what the pointer file
// resolves to — a wave worker asking "what branch am I on" must not read the
// main checkout's HEAD.
function gitDirFor(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    const entry = path.join(dir, GIT_ENTRY);
    const stat = statSync(entry, { throwIfNoEntry: false });
    if (stat?.isDirectory()) return entry;
    if (stat?.isFile()) {
      const pointer = readFileSync(entry, 'utf8').match(GITDIR_POINTER);
      if (!pointer) return null;
      return path.resolve(dir, pointer[1].trim());
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// A detached HEAD holds a raw sha and names no branch, so there is nothing to
// check against the lists and the answer is "cannot tell", not "some branch".
function branchAt(startDir) {
  const gitDir = gitDirFor(startDir);
  if (gitDir === null || !existsSync(gitDir)) return BRANCH_UNRESOLVED;
  const head = readFileSync(path.join(gitDir, HEAD_FILE), 'utf8').trim();
  if (!head.startsWith(BRANCH_REF_PREFIX)) return BRANCH_UNRESOLVED;
  const branch = head.slice(BRANCH_REF_PREFIX.length).trim();
  return branch === '' ? BRANCH_UNRESOLVED : branch;
}

/**
 * @param {string} branch Branch name, without `refs/heads/`.
 * @returns {'control'|'protected'|'other'}
 */
export function classifyBranch(branch) {
  if (PROTECTED_BRANCHES.has(branch)) return DESTINATION_PROTECTED;
  if (CONTROL_BRANCH_PREFIXES.some((prefix) => branch.startsWith(prefix))) {
    return DESTINATION_CONTROL;
  }
  return DESTINATION_OTHER;
}

function verdictAt(startDir) {
  const branch = branchAt(startDir);
  return branch === BRANCH_UNRESOLVED ? DESTINATION_INDETERMINATE : classifyBranch(branch);
}

/**
 * Destination of a `git merge` issued in this session.
 *
 * Both anchors are read and the most restrictive answer wins, because they can
 * disagree: `CLAUDE_PROJECT_DIR` stays on the directory the session opened in
 * while the payload `cwd` follows the Bash tool's shell across a `cd`. Only
 * unanimous agreement on a control branch is permissive.
 *
 * @param {Record<string, string|undefined>} env Environment of the hook process.
 * @param {string|undefined} cwd `cwd` field of the hook payload.
 * @returns {'control'|'protected'|'other'|'indeterminate'}
 */
export function classifyMergeDestination(env, cwd) {
  try {
    const anchors = [env?.[PROJECT_DIR_VAR], cwd].filter(usableAnchor);
    if (anchors.length === 0) return DESTINATION_INDETERMINATE;

    const verdicts = anchors.map((anchor) => {
      try {
        return verdictAt(anchor);
      } catch {
        return DESTINATION_INDETERMINATE;
      }
    });

    if (verdicts.includes(DESTINATION_PROTECTED)) return DESTINATION_PROTECTED;
    if (verdicts.includes(DESTINATION_INDETERMINATE)) return DESTINATION_INDETERMINATE;
    if (verdicts.every((verdict) => verdict === DESTINATION_CONTROL)) return DESTINATION_CONTROL;
    return DESTINATION_OTHER;
  } catch {
    return DESTINATION_INDETERMINATE;
  }
}
