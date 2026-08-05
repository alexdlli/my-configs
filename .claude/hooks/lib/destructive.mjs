// Classification of the Bash commands the harness holds back: merging a PR,
// merging a branch, force-pushing, and committing with the hooks skipped.
//
// The four are not held back equally. Force-push and `--no-verify` are denied
// in every context, no exception. `gh pr merge` is scoped by session context —
// `ask-then-merge`: a wave worker never merges, and anywhere else the command
// falls through to Claude Code's own permission prompt so Alex can approve it.
// `git merge` is scoped by its destination instead, which is the branch the
// session is standing on: allowed on a control branch, denied on a protected
// one. None of that scoping is decided here — `classifyCommand` only reports
// which rule a command line matches. `isWorkerOnlyRule` says which rules the
// caller weighs against the session context (lib/worker-context.mjs), and
// `isBranchScopedRule` which it weighs against the destination
// (lib/merge-destination.mjs).
//
// Why this exists as code and not only as `permissions.deny`: the deny list is
// string matching against the command as typed. It survives
// `--dangerously-skip-permissions` (measured), but `Bash(gh pr merge *)` only
// ever sees the literal form — `bash -c "gh pr merge 3"` walks straight past
// it, and under bypass there is no approval prompt left as a backstop. This
// module unwraps the common envelopes before deciding.
//
// THREAT MODEL: a distracted agent, not an attacker. Everything here is
// defeatable on purpose by someone who wants to defeat it (base64, command
// substitution, a python one-liner). Chasing that would cost precision, and
// precision is what matters: a false positive blocks legitimate work, while a
// false negative costs a command that branch protection on GitHub still
// refuses. Branch protection is the real guarantee; this is the local net.
//
// Deliberately NOT caught (see docs/guard-destructive.md):
//   - command substitution: `$(gh pr merge 3)`, backticks
//   - heredoc bodies — they are stripped before scanning, because docs and
//     tests legitimately contain these strings
//   - interpreters other than a shell: `python -c`, `perl -e`, `xargs`
//   - `curl ... | bash` — the payload is not in the command line
//   - `git push --force-with-lease`, which refuses to clobber unseen work and
//     is how an agent fixes up its own wave branch
//
// `classifyCommand` is pure: a string in, a verdict out. No process spawned,
// no file read — cheap enough for a PreToolUse hook and testable without a
// session.
//
// Requires Node.js 24+.

export const RULE_GH_PR_MERGE = 'gh-pr-merge';
export const RULE_GIT_PUSH_FORCE = 'git-push-force';
export const RULE_GIT_COMMIT_NO_VERIFY = 'git-commit-no-verify';
export const RULE_GIT_MERGE = 'git-merge';

const RULE_LABELS = {
  [RULE_GH_PR_MERGE]: 'gh pr merge',
  [RULE_GIT_PUSH_FORCE]: 'git push --force',
  [RULE_GIT_COMMIT_NO_VERIFY]: 'git commit --no-verify',
  [RULE_GIT_MERGE]: 'git merge',
};

const RULE_GUIDANCE = {
  [RULE_GH_PR_MERGE]:
    "A wave worker never merges, whatever else is available to it: the merge is Alex's. Open the PR, report it in your summary, and stop there.",
  [RULE_GIT_PUSH_FORCE]:
    'Force-pushing rewrites history someone else may already have. Push a normal commit; if the branch really needs a rewrite, ask Alex.',
  [RULE_GIT_COMMIT_NO_VERIFY]:
    'The commit hooks are the check, not an obstacle. Fix what they report; if the bypass is genuinely required, ask Alex.',
  [RULE_GIT_MERGE]:
    'A merge lands on the branch you are standing on, and this one is protected. Agents merge into control branches only (integration/*, wave/*). Switch to the control branch and merge there, or leave the merge to Alex.',
};

const UNDETERMINED_GUIDANCE =
  'The guard could not tell whether this session is a wave worker, and it denies the merge when it cannot tell. Report it and let Alex merge.';

const UNDETERMINED_DESTINATION_GUIDANCE =
  'The guard could not read which branch this merge would land on, and it denies the merge when it cannot tell. Check out the control branch explicitly, or let Alex merge.';

const REDIRECTED_DESTINATION_GUIDANCE =
  'This command points git at another repository (-C, --git-dir, --work-tree), so the branch it would land on is not the one this session is standing on and the guard cannot verify it. Run the merge from inside that checkout.';

// Rules whose denial depends on the session context. Only merge is on this list;
// putting a second rule here means deciding that the same command is acceptable
// from the coordinator, which is a policy change, not a refactor.
const WORKER_ONLY_RULES = new Set([RULE_GH_PR_MERGE]);

// Rules whose denial depends on the branch the merge would land on, weighed by
// the caller against lib/merge-destination.mjs.
const BRANCH_SCOPED_RULES = new Set([RULE_GIT_MERGE]);

const ALLOWED = { blocked: false };

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
// Commands whose arguments become shell source when piped into a shell.
const PIPE_WRITERS = new Set(['echo', 'printf']);
const ENV_COMMAND = 'env';

const HELP_FLAGS = new Set(['-h', '--help']);
const FORCE_PUSH_FLAGS = new Set(['-f', '--force']);
const NO_VERIFY_FLAGS = new Set(['-n', '--no-verify']);
// `git merge --abort|--continue|--quit` finishes or undoes a merge already in
// progress. It creates nothing, and blocking it would strand an agent that is
// resolving a conflict the guard let it start.
const MERGE_MAINTENANCE_FLAGS = new Set(['--abort', '--continue', '--quit']);
// git options that consume the next argument, so the subcommand scan skips it.
const GIT_VALUE_FLAGS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
]);
// Options that move git to another checkout: the merge then lands on that
// repository's HEAD, not the one the session can read. `-c` is config, not a
// relocation, so it is deliberately absent.
const REPO_REDIRECT_FLAGS = new Set(['-C', '--git-dir', '--work-tree']);

// `-c`, and the clusters that carry it: `bash -lc`, `sh -ec`, `zsh -euc`.
const SHELL_SCRIPT_FLAG = /^-[a-zA-Z]*c$/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const HEREDOC_START = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/;

const PIPE = '|';
const SEQUENCE_OPERATORS = new Set([';', '\n']);
// A wrapper nested deeper than this is no longer a distracted agent.
const MAX_WRAPPER_DEPTH = 3;

// A heredoc body is data by definition, and this repo's own docs and tests are
// full of the very strings the rules match. Dropping the body keeps the
// document-writing case out of the guard entirely.
function stripHeredocBodies(command) {
  const lines = command.split('\n');
  const kept = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    kept.push(line);
    index += 1;
    const start = line.match(HEREDOC_START);
    if (!start) continue;
    const delimiter = start[2];
    while (index < lines.length && lines[index].trim() !== delimiter) index += 1;
    if (index < lines.length) index += 1;
  }
  return kept.join('\n');
}

function readQuoted(command, openAt) {
  const quote = command[openAt];
  let value = '';
  let index = openAt + 1;
  while (index < command.length && command[index] !== quote) {
    if (quote === '"' && command[index] === '\\' && index + 1 < command.length) {
      value += command[index + 1];
      index += 2;
      continue;
    }
    value += command[index];
    index += 1;
  }
  return { value, next: index + 1 };
}

// Splits a command line into segments (one per `;`, `&&`, `||`, `|`, `&`,
// newline) and each segment into tokens. A token remembers whether it came
// from a quoted string: that is what separates `gh pr merge` the command from
// "gh pr merge" the argument of an echo.
function scan(command) {
  const segments = [];
  let tokens = [];
  let precededBy = null;
  let value = '';
  let started = false;
  let quoted = false;

  const endToken = () => {
    if (!started) return;
    tokens.push({ value, quoted });
    value = '';
    started = false;
    quoted = false;
  };

  const endSegment = (operator) => {
    endToken();
    segments.push({ tokens, precededBy });
    tokens = [];
    precededBy = operator;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    if (char === '\\' && index + 1 < command.length) {
      value += command[index + 1];
      started = true;
      index += 1;
      continue;
    }

    if (char === "'" || char === '"') {
      const read = readQuoted(command, index);
      value += read.value;
      started = true;
      quoted = true;
      index = read.next - 1;
      continue;
    }

    if (char === ' ' || char === '\t' || char === '\r') {
      endToken();
      continue;
    }

    if (char === PIPE || char === '&') {
      const doubled = command[index + 1] === char;
      if (doubled) index += 1;
      endSegment(doubled ? char + char : char);
      continue;
    }

    if (SEQUENCE_OPERATORS.has(char)) {
      endSegment(char);
      continue;
    }

    value += char;
    started = true;
  }

  endSegment(null);
  return segments;
}

function commandName(token) {
  const slash = token.value.lastIndexOf('/');
  return slash === -1 ? token.value : token.value.slice(slash + 1);
}

// `FOO=1 bash -c ...` and `env FOO=1 bash -c ...` reach the same shell.
function stripEnvPrefix(tokens) {
  let start = 0;
  while (start < tokens.length) {
    const token = tokens[start];
    if (ENV_ASSIGNMENT.test(token.value) || commandName(token) === ENV_COMMAND) {
      start += 1;
      continue;
    }
    break;
  }
  return tokens.slice(start);
}

function shellScriptArgument(argv) {
  for (let index = 1; index < argv.length; index += 1) {
    if (SHELL_SCRIPT_FLAG.test(argv[index].value)) return argv[index + 1]?.value ?? null;
  }
  return null;
}

// `echo '<script>' | bash`: the shell reads its source from the pipe, so the
// candidates are the quoted strings — and the echo/printf arguments — of every
// segment feeding this pipeline.
function pipelineScripts(segments, index) {
  const scripts = [];
  for (let i = index - 1; i >= 0; i -= 1) {
    const segment = segments[i];
    for (const token of segment.tokens) {
      if (token.quoted) scripts.push(token.value);
    }
    const argv = stripEnvPrefix(segment.tokens);
    if (argv.length > 0 && PIPE_WRITERS.has(commandName(argv[0]))) {
      scripts.push(argv.slice(1).map((token) => token.value).join(' '));
    }
    if (segment.precededBy !== PIPE) break;
  }
  return scripts;
}

function blockedBy(rule) {
  return { blocked: true, rule, wrapped: false };
}

function classifyGh(argv) {
  const args = argv.slice(1).map((token) => token.value);
  if (args.some((arg) => HELP_FLAGS.has(arg))) return ALLOWED;
  const positional = args.filter((arg) => !arg.startsWith('-'));
  if (positional[0] === 'pr' && positional[1] === 'merge') return blockedBy(RULE_GH_PR_MERGE);
  return ALLOWED;
}

function gitSubcommand(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('-')) {
      return { name: arg, args: args.slice(index + 1), options: args.slice(0, index) };
    }
    if (GIT_VALUE_FLAGS.has(arg)) index += 1;
  }
  return null;
}

// `--git-dir=x` and `--git-dir x` are the same relocation.
function redirectsRepo(options) {
  return options.some((option) => REPO_REDIRECT_FLAGS.has(option.split('=', 1)[0]));
}

function classifyGit(argv) {
  const args = argv.slice(1).map((token) => token.value);
  if (args.some((arg) => HELP_FLAGS.has(arg))) return ALLOWED;
  const subcommand = gitSubcommand(args);
  if (subcommand === null) return ALLOWED;
  if (subcommand.name === 'push' && subcommand.args.some((arg) => FORCE_PUSH_FLAGS.has(arg))) {
    return blockedBy(RULE_GIT_PUSH_FORCE);
  }
  if (subcommand.name === 'commit' && subcommand.args.some((arg) => NO_VERIFY_FLAGS.has(arg))) {
    return blockedBy(RULE_GIT_COMMIT_NO_VERIFY);
  }
  if (subcommand.name === 'merge') {
    if (subcommand.args.some((arg) => MERGE_MAINTENANCE_FLAGS.has(arg))) return ALLOWED;
    return { ...blockedBy(RULE_GIT_MERGE), redirected: redirectsRepo(subcommand.options) };
  }
  return ALLOWED;
}

function classifySegment(segment, segments, index, depth) {
  const argv = stripEnvPrefix(segment.tokens);
  if (argv.length === 0) return ALLOWED;
  const name = commandName(argv[0]);

  if (SHELLS.has(name)) {
    const script = shellScriptArgument(argv);
    let scripts = [];
    if (script !== null) scripts = [script];
    else if (segment.precededBy === PIPE) scripts = pipelineScripts(segments, index);
    for (const source of scripts) {
      const finding = classify(source, depth + 1);
      if (finding.blocked) return { ...finding, wrapped: true };
    }
    return ALLOWED;
  }

  if (name === 'gh') return classifyGh(argv);
  if (name === 'git') return classifyGit(argv);
  return ALLOWED;
}

function classify(command, depth) {
  if (depth > MAX_WRAPPER_DEPTH || command.trim() === '') return ALLOWED;
  const segments = scan(stripHeredocBodies(command));
  for (let index = 0; index < segments.length; index += 1) {
    const finding = classifySegment(segments[index], segments, index, depth);
    if (finding.blocked) return finding;
  }
  return ALLOWED;
}

/**
 * @param {string} command Command line as the Bash tool received it.
 * @returns {{blocked: boolean, rule?: string, wrapped?: boolean}}
 */
export function classifyCommand(command) {
  if (typeof command !== 'string') return ALLOWED;
  return classify(command, 0);
}

/**
 * @param {string} rule One of the exported `RULE_*` constants.
 * @returns {boolean} True when the denial depends on the session being a worker.
 */
export function isWorkerOnlyRule(rule) {
  return WORKER_ONLY_RULES.has(rule);
}

/**
 * @param {string} rule One of the exported `RULE_*` constants.
 * @returns {boolean} True when the denial depends on the branch the merge lands on.
 */
export function isBranchScopedRule(rule) {
  return BRANCH_SCOPED_RULES.has(rule);
}

/**
 * @param {{rule: string, wrapped: boolean}} finding Verdict from `classifyCommand`.
 * @param {{undetermined?: boolean, destination?: string}} [context] Set
 *   `undetermined` when the denial comes from not being able to tell whether
 *   this session is a worker; set `destination` to `'indeterminate'` or
 *   `'redirected'` when the merge destination is what could not be established.
 * @returns {string} Reason shown to the agent, naming the rule and the way out.
 */
export function denialReason(finding, { undetermined = false, destination } = {}) {
  const origin = finding.wrapped ? 'wrapped in a shell' : 'called directly';
  let guidance = RULE_GUIDANCE[finding.rule];
  if (undetermined) guidance = UNDETERMINED_GUIDANCE;
  else if (destination === 'redirected') guidance = REDIRECTED_DESTINATION_GUIDANCE;
  else if (destination === 'indeterminate') guidance = UNDETERMINED_DESTINATION_GUIDANCE;
  return `guard-destructive: blocked "${RULE_LABELS[finding.rule]}" (${origin}). ${guidance}`;
}
