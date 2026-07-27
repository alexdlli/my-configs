import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RULE_GH_PR_MERGE,
  RULE_GIT_COMMIT_NO_VERIFY,
  RULE_GIT_PUSH_FORCE,
  classifyCommand,
  denialReason,
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

test('force-with-lease is deliberately out of scope', () => {
  assertAllowed('git push --force-with-lease origin wave/3');
});

test('a non-string command is not a command', () => {
  assertAllowed(undefined);
  assertAllowed(null);
  assertAllowed(42);
});

test('the denial reason names the rule and what to do instead', () => {
  const direct = denialReason(classifyCommand('gh pr merge 3'));
  assert.match(direct, /gh pr merge/);
  assert.match(direct, /Alex/);
  assert.match(direct, /called directly/);

  const wrapped = denialReason(classifyCommand(`bash -c 'git push --force'`));
  assert.match(wrapped, /git push --force/);
  assert.match(wrapped, /wrapped in a shell/);

  const noVerify = denialReason(classifyCommand('git commit --no-verify'));
  assert.match(noVerify, /git commit --no-verify/);
});

test('the denial reason never leaks the opt-out switch to the agent', () => {
  for (const command of ['gh pr merge 3', 'git push -f', 'git commit -n']) {
    assert.doesNotMatch(denialReason(classifyCommand(command)), /CLAUDE_SETUP_SKIP/);
  }
});

test('wrapper unwrapping is bounded and still terminates', () => {
  const deep = `bash -c "bash -c \\"bash -c 'gh pr merge 3'\\""`;
  assert.equal(typeof classifyCommand(deep).blocked, 'boolean');
});
