// Whether the session running this hook is a wave worker.
//
// The dispatch writes `.wave/worker.json` into the root of every worker
// worktree (see `.claude/skills/wave-orchestration/SKILL.md`, section
// `Dispatch`). That marker is the whole signal: the `w<N>-issue-<n>` folder name
// is a convention of today's dispatch and will change, so nothing here reads a
// directory name. Only the presence of the marker and its parseability matter —
// the fields inside it are for the human reading a worktree, not for this code,
// because every field this module required would be one more way to be
// undetermined.
//
// ANCHORS. `CLAUDE_PROJECT_DIR` is the load-bearing one, not the `cwd` from the
// hook payload. Measured on Claude Code 2.1.220: the payload `cwd`, the hook
// process's own `process.cwd()` and `PWD` all track the Bash tool's persistent
// shell, so a `cd ..` in one tool call moves them for the next one — a worker
// could step out of its own worktree and leave the marker behind it.
// `CLAUDE_PROJECT_DIR` stayed on the directory the session opened in across the
// same `cd`. Both anchors are searched and any worker hit wins, so the payload
// `cwd` can only ever add worker verdicts, never remove one.
//
// FAILS CLOSED, on purpose, and this is the inverse of the rest of the hook.
// `guard-destructive.mjs` allows the command through on any internal error,
// because a guard that denies on its own bug turns a typo into a dead Bash tool
// for a whole session. This module does the opposite and returns
// `indeterminate` — which the caller treats as a denial — whenever it cannot
// answer: no usable anchor, a marker it cannot read, a marker that is not JSON.
// The asymmetry is deliberate and it is the reason this module catches its own
// errors instead of letting them reach the caller's fail-open handler. Blocking
// a merge that should have been allowed costs one message to Alex; allowing one
// that should have been blocked costs a merge nobody approved.
//
// Requires Node.js 24+.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const CONTEXT_WORKER = 'worker';
export const CONTEXT_OTHER = 'other';
export const CONTEXT_INDETERMINATE = 'indeterminate';

export const WORKER_MARKER_PATH = path.join('.wave', 'worker.json');

export const PROJECT_DIR_VAR = 'CLAUDE_PROJECT_DIR';

// `.git` is a directory in a normal checkout and a file in a linked worktree.
// Either one ends the walk: it is the repo root the search was told to stop at.
const REPO_ROOT_ENTRY = '.git';

const MARKER_ABSENT = null;
// Nothing at that path, or a path component that is not a directory. Both mean
// "no marker here", which is an answer; every other errno means the file system
// refused to answer, which is not.
const ABSENT_ERROR_CODES = new Set(['ENOENT', 'ENOTDIR']);

function usableAnchor(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function markerVerdictAt(dir) {
  let raw;
  try {
    raw = readFileSync(path.join(dir, WORKER_MARKER_PATH), 'utf8');
  } catch (err) {
    return ABSENT_ERROR_CODES.has(err.code) ? MARKER_ABSENT : CONTEXT_INDETERMINATE;
  }
  try {
    JSON.parse(raw);
  } catch {
    return CONTEXT_INDETERMINATE;
  }
  return CONTEXT_WORKER;
}

// Walks from `startDir` up to the repo root, inclusive. Reaching the file system
// root without ever seeing a repo root still ends the walk with an answer: every
// directory that could have held the marker was looked at.
function searchAncestors(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    const verdict = markerVerdictAt(dir);
    if (verdict !== MARKER_ABSENT) return verdict;
    if (existsSync(path.join(dir, REPO_ROOT_ENTRY))) return CONTEXT_OTHER;
    const parent = path.dirname(dir);
    if (parent === dir) return CONTEXT_OTHER;
    dir = parent;
  }
}

/**
 * @param {Record<string, string|undefined>} env Environment of the hook process.
 * @param {string|undefined} cwd `cwd` field of the hook payload.
 * @returns {'worker'|'other'|'indeterminate'}
 */
export function detectWorkerContext(env, cwd) {
  try {
    const anchors = [env?.[PROJECT_DIR_VAR], cwd].filter(usableAnchor);
    if (anchors.length === 0) return CONTEXT_INDETERMINATE;

    let verdict = CONTEXT_OTHER;
    for (const anchor of anchors) {
      const found = searchAncestors(anchor);
      if (found === CONTEXT_WORKER) return CONTEXT_WORKER;
      if (found === CONTEXT_INDETERMINATE) verdict = CONTEXT_INDETERMINATE;
    }
    return verdict;
  } catch {
    return CONTEXT_INDETERMINATE;
  }
}
