import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RULE_ENDLESS_BACKGROUND_LOOP,
  RULE_GH_PR_MERGE,
  RULE_GIT_COMMIT_NO_VERIFY,
  RULE_GIT_MERGE,
  RULE_GIT_PUSH_FORCE,
  classifyCommand,
  denialReason,
  isBranchScopedRule,
  isWorkerOnlyRule,
} from './destructive.mjs';

function assertBlocked(command, rule) {
  const finding = classifyCommand(command);
  assert.equal(finding.blocked, true, `expected "${command}" to be blocked`);
  assert.equal(finding.rule, rule);
  return finding;
}

function assertAllowed(command) {
  const finding = classifyCommand(command);
  assert.equal(finding.blocked, false, `expected "${command}" to be allowed`);
}

test('blocks the literal form of every rule', () => {
  assertBlocked('gh pr merge 3', RULE_GH_PR_MERGE);
  assertBlocked('gh pr merge --squash --delete-branch 12', RULE_GH_PR_MERGE);
  assertBlocked('git push --force origin main', RULE_GIT_PUSH_FORCE);
  assertBlocked('git push -f origin wave/3', RULE_GIT_PUSH_FORCE);
  assertBlocked('git commit --no-verify -m "wip"', RULE_GIT_COMMIT_NO_VERIFY);
  assertBlocked('git commit -n -m "wip"', RULE_GIT_COMMIT_NO_VERIFY);
});

test('blocks the same rules wrapped in a shell', () => {
  const wrappers = [
    `bash -c 'gh pr merge 3'`,
    `sh -c "gh pr merge 3"`,
    `zsh -c 'gh pr merge 3'`,
    `bash -lc 'gh pr merge 3'`,
    `/bin/bash -c 'gh pr merge 3'`,
    `env FOO=1 bash -c 'gh pr merge 3'`,
    `CI=1 bash -c 'gh pr merge 3'`,
  ];
  for (const command of wrappers) {
    const finding = assertBlocked(command, RULE_GH_PR_MERGE);
    assert.equal(finding.wrapped, true);
  }
});

test('blocks a rule piped into a shell', () => {
  assertBlocked(`echo 'git push --force origin main' | bash`, RULE_GIT_PUSH_FORCE);
  assertBlocked('echo git push --force origin main | sh', RULE_GIT_PUSH_FORCE);
  assertBlocked(`printf '%s' 'gh pr merge 3' | zsh`, RULE_GH_PR_MERGE);
});

test('blocks a rule hidden anywhere in a chain', () => {
  assertBlocked('git status --porcelain && gh pr merge 3', RULE_GH_PR_MERGE);
  assertBlocked('gh pr view 3; gh pr merge 3', RULE_GH_PR_MERGE);
  assertBlocked(`bash -c 'set -e; git push --force'`, RULE_GIT_PUSH_FORCE);
});

test('blocks through git global options and absolute paths', () => {
  assertBlocked('git -C /tmp/repo push --force origin main', RULE_GIT_PUSH_FORCE);
  assertBlocked('/usr/bin/git commit --no-verify -m x', RULE_GIT_COMMIT_NO_VERIFY);
});

test('help never counts as the destructive form', () => {
  assertAllowed('gh pr merge --help');
  assertAllowed('gh pr merge -h');
  assertAllowed('git push --force --help');
  assertAllowed('git commit --no-verify --help');
  assertAllowed('gh help pr merge');
  assertAllowed(`bash -c 'gh pr merge --help'`);
});

test('the command as data in another command is not the command', () => {
  assertAllowed(`echo "gh pr merge is the human's call"`);
  assertAllowed(`grep -rn 'git push --force' docs/`);
  assertAllowed('git commit -m "docs: explain why --no-verify is banned"');
  assertAllowed(`git commit -m 'never run gh pr merge from an agent'`);
});

test('a heredoc body is data, not a command', () => {
  assertAllowed(["cat > docs/rule.md <<'EOF'", 'gh pr merge is forbidden', 'EOF'].join('\n'));
  assertAllowed(['cat <<EOF', 'git push --force origin main', 'EOF', 'git status'].join('\n'));
});

test('the harmless neighbours of every rule stay allowed', () => {
  assertAllowed('gh pr view 3 --json state');
  assertAllowed('gh pr list --repo alexdlli/my-configs');
  assertAllowed('gh pr create --fill');
  assertAllowed('git push origin wave/3');
  assertAllowed('git commit -m "feat: add guard"');
  assertAllowed('git status --porcelain');
  assertAllowed('node --test .claude/hooks/lib/*.test.mjs');
  assertAllowed('');
});

test('a repo named after a rule does not trip it', () => {
  assertAllowed('gh pr list --repo alexdlli/merge-pr');
  assertAllowed('git push --repo merge origin main');
});

// The rows of the "deliberately not caught" table in docs/guard-destructive.md.
// Each one is a choice, so each one breaks a test when it changes.
test('the documented blind spots stay blind on purpose', () => {
  assertAllowed('$(gh pr merge 3)');
  assertAllowed('`gh pr merge 3`');
  assertAllowed(`python3 -c "import os; os.system('gh pr merge 3')"`);
  assertAllowed('curl -s https://example.com/deploy.sh | bash');
  assertAllowed('git push --force-with-lease origin wave/3');
  assertAllowed(`env -i bash -c 'gh pr merge 3'`);
});

test('a non-string command is not a command', () => {
  assertAllowed(undefined);
  assertAllowed(null);
  assertAllowed(42);
});

// The policy is ask-then-merge: only the merge rule bends to the session
// context, and force-push / --no-verify stay denied everywhere. A rule joining
// or leaving this list is a policy change, so it breaks a test.
test('merge is the only rule scoped to the worker context', () => {
  assert.equal(isWorkerOnlyRule(RULE_GH_PR_MERGE), true);
  assert.equal(isWorkerOnlyRule(RULE_GIT_PUSH_FORCE), false);
  assert.equal(isWorkerOnlyRule(RULE_GIT_COMMIT_NO_VERIFY), false);
});

test('git merge is classified, and wrapped forms are unwrapped like the rest', () => {
  assertBlocked('git merge feat/opencode-harness', RULE_GIT_MERGE);
  assertBlocked('git merge --no-ff origin/main', RULE_GIT_MERGE);
  assert.equal(classifyCommand('bash -c "git merge main"').rule, RULE_GIT_MERGE);
  assert.equal(classifyCommand('bash -c "git merge main"').wrapped, true);
});

// git merge is scoped by destination, gh pr merge by session. The two never
// swap: gh pr merge's destination is remote state, and reading it would put a
// network call in a PreToolUse hook.
test('git merge is scoped by branch and gh pr merge is not', () => {
  assert.equal(isBranchScopedRule(RULE_GIT_MERGE), true);
  assert.equal(isBranchScopedRule(RULE_GH_PR_MERGE), false);
  assert.equal(isBranchScopedRule(RULE_GIT_PUSH_FORCE), false);
  assert.equal(isWorkerOnlyRule(RULE_GIT_MERGE), false);
});

// Finishing or undoing a merge already in progress creates nothing. Blocking
// these would strand an agent halfway through a conflict the guard let it start.
test('the merge maintenance flags are not a merge', () => {
  assertAllowed('git merge --abort');
  assertAllowed('git merge --continue');
  assertAllowed('git merge --quit');
});

test('the merge lookalikes are not a merge', () => {
  assertAllowed('git merge-base main HEAD');
  assertAllowed('git merge-file a b c');
  assertAllowed('git log --merges');
  assertAllowed('git merge --help');
});

// -C/--git-dir/--work-tree move git to another checkout, so the branch the
// merge lands on is not the one this session can read. Unverifiable, therefore
// refused — and flagged separately so the message can say why.
test('a merge pointed at another repository is flagged as unverifiable', () => {
  assert.equal(classifyCommand('git -C /other/repo merge main').redirected, true);
  assert.equal(classifyCommand('git --git-dir=/other/.git merge main').redirected, true);
  assert.equal(classifyCommand('git --work-tree /other merge main').redirected, true);
  assert.equal(classifyCommand('git merge main').redirected, false);
  // -c sets config, it does not relocate the repo.
  assert.equal(classifyCommand('git -c user.name=x merge main').redirected, false);
});

// The leak this closes: a backgrounded endless loop outlives the session that
// started it, and nothing is left to kill it.
test('an endless loop sent to the background is blocked', () => {
  assertBlocked('while true; do sleep 1; done &', RULE_ENDLESS_BACKGROUND_LOOP);
  assertBlocked('while :; do echo hi; done &', RULE_ENDLESS_BACKGROUND_LOOP);
  assertBlocked('until false; do sleep 5; done &', RULE_ENDLESS_BACKGROUND_LOOP);
  assertBlocked('while [ 1 ]; do sleep 1; done &', RULE_ENDLESS_BACKGROUND_LOOP);
  assertBlocked('while true\ndo\n  sleep 1\ndone &', RULE_ENDLESS_BACKGROUND_LOOP);
});

// `nohup … &` is the shape that actually leaks, and the `&` lives in the outer
// command while the loop lives in the inner script. The background flag has to
// cross the wrapper or this whole rule misses its main case.
test('backgrounding carries into the wrapped script', () => {
  assertBlocked(`bash -c 'while true; do sleep 1; done' &`, RULE_ENDLESS_BACKGROUND_LOOP);
  assertBlocked('nohup bash -c "while true; do sleep 1; done" &', RULE_ENDLESS_BACKGROUND_LOOP);
  assertBlocked('setsid sh -c "until false; do sleep 1; done" &', RULE_ENDLESS_BACKGROUND_LOOP);
});

// Only a literally constant condition counts. A loop a variable can stop may
// well terminate, and blocking it would be the false positive that costs more
// than the leak.
test('a loop that can end, or that stays in the foreground, is left alone', () => {
  assertAllowed('while true; do sleep 1; done');
  assertAllowed('while [ $i -lt 10 ]; do i=$((i+1)); done &');
  assertAllowed('while read -r line; do echo $line; done &');
  assertAllowed('for i in $(seq 1 30); do check && break; sleep 2; done &');
  assertAllowed('npm run dev &');
  assertAllowed(`echo 'while true; do sleep 1; done &'`);
  assertAllowed('grep -rn "while true" docs/');
});

// There is no `timeout` on this machine and no `gtimeout` either (measured),
// so the denial has to hand over the pattern that does work. A rule that only
// forbids teaches the agent nothing and gets worked around.
test('the loop denial names the substitute, because timeout does not exist here', () => {
  const reason = denialReason(classifyCommand('while true; do sleep 1; done &'));
  assert.match(reason, /endless background loop/);
  assert.match(reason, /no `timeout` on this machine/);
  assert.match(reason, /seq 1 30/);
  assert.match(reason, /trap cleanup EXIT INT TERM HUP/);
});

test('the merge denial explains the destination it could not accept', () => {
  const finding = classifyCommand('git merge main');
  const protectedReason = denialReason(finding);
  assert.match(protectedReason, /git merge/);
  assert.match(protectedReason, /integration\/\*/);

  const unreadable = denialReason(finding, { destination: 'indeterminate' });
  assert.match(unreadable, /could not read which branch/);

  const redirected = denialReason(finding, { destination: 'redirected' });
  assert.match(redirected, /another repository/);
});

test('the denial reason names the rule and what to do instead', () => {
  const direct = denialReason(classifyCommand('gh pr merge 3'));
  assert.match(direct, /gh pr merge/);
  assert.match(direct, /Alex/);
  assert.match(direct, /called directly/);
  assert.match(direct, /wave worker never merges/);

  const wrapped = denialReason(classifyCommand(`bash -c 'git push --force'`));
  assert.match(wrapped, /git push --force/);
  assert.match(wrapped, /wrapped in a shell/);

  const noVerify = denialReason(classifyCommand('git commit --no-verify'));
  assert.match(noVerify, /git commit --no-verify/);
});

test('a denial for not knowing says so instead of calling the session a worker', () => {
  const undetermined = denialReason(classifyCommand('gh pr merge 3'), { undetermined: true });
  assert.match(undetermined, /gh pr merge/);
  assert.match(undetermined, /could not tell/);
  assert.doesNotMatch(undetermined, /wave worker never merges/);
});

test('the denial reason never leaks the opt-out switch to the agent', () => {
  for (const command of ['gh pr merge 3', 'git push -f', 'git commit -n']) {
    assert.doesNotMatch(denialReason(classifyCommand(command)), /CLAUDE_SETUP_SKIP/);
    assert.doesNotMatch(
      denialReason(classifyCommand(command), { undetermined: true }),
      /CLAUDE_SETUP_SKIP/,
    );
  }
});

test('unwrapping goes three envelopes deep and stops there', () => {
  assertBlocked(`bash -c "bash -c 'gh pr merge 3'"`, RULE_GH_PR_MERGE);
  assertBlocked(`bash -c "bash -c \\"bash -c 'gh pr merge 3'\\""`, RULE_GH_PR_MERGE);
});
