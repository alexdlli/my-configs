// Session environment detection: which terminal host is running this session,
// which GitHub account / issue tracker applies to the working directory, and
// whether a wave can be dispatched from here.
//
// `detectContext` is pure: env and cwd come in as parameters, nothing is read
// from disk, no process is spawned. That is what makes it cheap enough for a
// SessionStart hook and testable without touching the real process.
//
// `verifyAccount` is the opt-in exception — one `git config` subprocess plus a
// read of ~/.gitconfig. Never call it from the hook path.
//
// Signals below are empirically confirmed on this machine; see
// docs/integrations/orca.md for the confirmation status of each one.
//
// Requires Node.js 24+.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOST_MAESTRI = 'maestri';
export const HOST_ORCA = 'orca';
export const HOST_PLAIN = 'plain';

export const DISPATCH_DRIVER_ORCA = 'orca-cli';

const ORCA_TERM_PROGRAM = 'Orca';
const ORCA_WORKTREE_SEPARATOR = '::';

const DISPATCH_REASON_ORCA =
  'orca worktree create + orca terminal: one worktree per ticket, agent in its first terminal';
// Maestri exports its CLI only as $MAESTRI_CLI inside the app's own terminal, so
// nothing outside it can spawn a wave — and no wave adapter targets it yet either.
const DISPATCH_REASON_MAESTRI =
  'no wave adapter for Maestri yet, and its CLI exists only as $MAESTRI_CLI inside the app terminal';
const DISPATCH_REASON_PLAIN = 'no worktree manager in this session — the human dispatches by hand';

const WORK_DIR_NAME = 'work';
const WORK_TRACKER = 'jira';
const PERSONAL_TRACKER = 'linear';

const TRACKER_SOURCE_CWD_WORK = 'cwd-work';
const TRACKER_SOURCE_GIT_IDENTITY = 'git-identity';
const TRACKER_SOURCE_UNKNOWN = 'unknown';

const ACCOUNT_WORK = 'work';
const ACCOUNT_PERSONAL = 'personal';
const ACCOUNT_UNKNOWN = 'unknown';

const GIT_CONFIG_TIMEOUT_MS = 5_000;

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function homeDir(env) {
  return nonEmpty(env.HOME) ?? os.homedir();
}

// ORCA_WORKTREE_ID is `<repoId>::<absPath>`. The repo id is a uuid and never
// contains the separator, but an absolute path legally can, so the split is on
// the first occurrence only.
function parseOrcaWorktreeId(worktreeId) {
  if (!worktreeId) return { repoId: null, worktreePath: null };
  const separatorAt = worktreeId.indexOf(ORCA_WORKTREE_SEPARATOR);
  if (separatorAt === -1) return { repoId: null, worktreePath: null };
  return {
    repoId: worktreeId.slice(0, separatorAt) || null,
    worktreePath: worktreeId.slice(separatorAt + ORCA_WORKTREE_SEPARATOR.length) || null,
  };
}

// Maestri wins ties: MAESTRI_TERMINAL_ID is set per terminal, and a Maestri
// terminal can be launched from inside Orca, inheriting the ORCA_* vars. Never
// detect Maestri by the presence of its socket or its running app — both exist
// while the app is alive, including for sessions that are not inside it.
function detectHost(env) {
  const terminalId = nonEmpty(env.MAESTRI_TERMINAL_ID);
  if (terminalId) {
    return {
      host: HOST_MAESTRI,
      hostDetail: { terminalId, cliPath: nonEmpty(env.MAESTRI_CLI) },
    };
  }

  const terminalHandle = nonEmpty(env.ORCA_TERMINAL_HANDLE);
  if (terminalHandle || env.TERM_PROGRAM === ORCA_TERM_PROGRAM) {
    const worktreeId = nonEmpty(env.ORCA_WORKTREE_ID);
    const { repoId, worktreePath } = parseOrcaWorktreeId(worktreeId);
    return {
      host: HOST_ORCA,
      hostDetail: { terminalHandle, worktreeId, repoId, worktreePath },
    };
  }

  return { host: HOST_PLAIN, hostDetail: {} };
}

// Same rule git itself applies: ~/.gitconfig carries a single
// `includeIf gitdir:~/work/`, so a cwd under ~/work resolves to the work
// identity. Outside it, the default identity applies — which covers /tmp,
// ~/Desktop and everything else, so it is not evidence of the personal account.
function isUnderWorkRoot(env, cwd) {
  const workRoot = path.join(homeDir(env), WORK_DIR_NAME);
  const resolved = path.resolve(cwd);
  return resolved === workRoot || resolved.startsWith(workRoot + path.sep);
}

// Describes whether a wave can be dispatched from this host, never dispatches.
// The description is a property of the host alone: no CLI is probed, no worktree
// is read. A caller that wants to know whether the Orca app is actually up asks
// the `orca` binary; this only says which adapter would be used if it were.
function describeDispatch(host) {
  if (host === HOST_ORCA) {
    return { available: true, driver: DISPATCH_DRIVER_ORCA, reason: DISPATCH_REASON_ORCA };
  }
  return {
    available: false,
    driver: null,
    reason: host === HOST_MAESTRI ? DISPATCH_REASON_MAESTRI : DISPATCH_REASON_PLAIN,
  };
}

export function detectContext(env = process.env, cwd = process.cwd()) {
  const { host, hostDetail } = detectHost(env);
  const underWork = isUnderWorkRoot(env, cwd);

  return {
    host,
    hostDetail,
    dispatch: describeDispatch(host),
    tracker: underWork ? WORK_TRACKER : null,
    trackerSource: underWork ? TRACKER_SOURCE_CWD_WORK : TRACKER_SOURCE_UNKNOWN,
    account: underWork ? ACCOUNT_WORK : ACCOUNT_UNKNOWN,
    repoRoot: hostDetail.worktreePath ?? null,
  };
}

// The `[user] email` declared before the includeIf block is the default (personal)
// identity; reading it here avoids hardcoding either address.
function readDefaultGitEmail(env) {
  let raw;
  try {
    raw = readFileSync(path.join(homeDir(env), '.gitconfig'), 'utf8');
  } catch {
    return null;
  }

  let section = null;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    const header = trimmed.match(/^\[([^\]\s]+)/);
    if (header) {
      section = header[1].toLowerCase();
      continue;
    }
    if (section !== 'user') continue;
    const entry = trimmed.match(/^email\s*=\s*(.+)$/i);
    if (entry) return entry[1].trim();
  }
  return null;
}

// Opt-in confirmation of the account behind a cwd, for the cases the cwd rule
// cannot decide: it compares the identity git actually resolves against the
// default one. A work repo cloned outside ~/work is detected here, and only
// here can `linear` be asserted instead of guessed.
export function verifyAccount(env = process.env, cwd = process.cwd()) {
  const res = spawnSync('git', ['-C', cwd, 'config', '--get', 'user.email'], {
    encoding: 'utf8',
    timeout: GIT_CONFIG_TIMEOUT_MS,
  });
  const email = res.status === 0 ? nonEmpty(res.stdout.trim()) : null;
  const defaultEmail = readDefaultGitEmail(env);

  if (!email || !defaultEmail) {
    return {
      email,
      account: ACCOUNT_UNKNOWN,
      tracker: null,
      trackerSource: TRACKER_SOURCE_UNKNOWN,
    };
  }

  const isPersonal = email.toLowerCase() === defaultEmail.toLowerCase();
  return {
    email,
    account: isPersonal ? ACCOUNT_PERSONAL : ACCOUNT_WORK,
    tracker: isPersonal ? PERSONAL_TRACKER : WORK_TRACKER,
    trackerSource: TRACKER_SOURCE_GIT_IDENTITY,
  };
}
