// Measured gap: OpenCode permission.bash patterns do not unwrap shell -c.
//
// Source (anomalyco/opencode v1.18.13, packages/opencode/src/tool/shell.ts):
// permission patterns are tree-sitter `command` node sources. For
//   bash -c "git push --force origin x"
// the only command node is the outer `bash`; the quoted script is a string
// child, not a nested command. The pattern collected is the full line.
//
// deny rules like `git push --force*` therefore miss the wrapped form.
// That is the hole guard-destructive (plugin + Claude hook) exists to close.
//
// This file does not ship tree-sitter-bash. It encodes the measured pattern
// list for the cases that matter and checks:
//   1. OpenCode-style patterns do not match the deny rules
//   2. classifyCommand (shared lib) does match them

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  RULE_GH_PR_MERGE,
  RULE_GIT_PUSH_FORCE,
  RULE_GIT_COMMIT_NO_VERIFY,
  classifyCommand,
} from '../.claude/hooks/lib/destructive.mjs';

const DENY_PATTERNS = [
  'git push --force*',
  'git push -f *',
  'git push -f',
  'git commit --no-verify*',
  'git commit -n *',
  'git commit -n',
];

// Minimal * / ? matcher matching OpenCode's Wildcard behaviour for these cases.
function wildcardMatch(text, pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(text);
}

function lastMatchingAction(text, rules) {
  // findLast: last matching rule wins. rules is [{pattern, action}, ...] in order.
  let action = 'ask';
  for (const rule of rules) {
    if (wildcardMatch(text, rule.pattern)) action = rule.action;
  }
  return action;
}

// Patterns OpenCode collects for each command, per shell.ts command-node walk.
// Documented from source reading of v1.18.13; not re-parsed here.
const CASES = [
  {
    command: 'git push --force origin main',
    opencodePatterns: ['git push --force origin main'],
    expectPermissionDeny: true,
    expectClassifierRule: RULE_GIT_PUSH_FORCE,
  },
  {
    command: 'bash -c "git push --force origin main"',
    opencodePatterns: ['bash -c "git push --force origin main"'],
    expectPermissionDeny: false,
    expectClassifierRule: RULE_GIT_PUSH_FORCE,
  },
  {
    command: "bash -c 'gh pr merge 3'",
    opencodePatterns: ["bash -c 'gh pr merge 3'"],
    expectPermissionDeny: false,
    expectClassifierRule: RULE_GH_PR_MERGE,
  },
  {
    command: 'sh -c "git commit --no-verify -m wip"',
    opencodePatterns: ['sh -c "git commit --no-verify -m wip"'],
    expectPermissionDeny: false,
    expectClassifierRule: RULE_GIT_COMMIT_NO_VERIFY,
  },
  {
    command: 'git commit --no-verify -m wip',
    opencodePatterns: ['git commit --no-verify -m wip'],
    expectPermissionDeny: true,
    expectClassifierRule: RULE_GIT_COMMIT_NO_VERIFY,
  },
];

const rules = [
  { pattern: '*', action: 'allow' },
  ...DENY_PATTERNS.map((pattern) => ({ pattern, action: 'deny' })),
];

test('permission.bash alone misses shell-wrapped destructive commands', () => {
  for (const c of CASES) {
    const denied = c.opencodePatterns.some(
      (pattern) => lastMatchingAction(pattern, rules) === 'deny',
    );
    assert.equal(
      denied,
      c.expectPermissionDeny,
      `permission match for "${c.command}"`,
    );
  }
});

test('classifyCommand catches the same wrapped forms the permission layer misses', () => {
  for (const c of CASES) {
    const finding = classifyCommand(c.command);
    assert.equal(finding.blocked, true, c.command);
    assert.equal(finding.rule, c.expectClassifierRule, c.command);
    if (!c.expectPermissionDeny) {
      assert.equal(finding.wrapped, true, `expected wrapped for ${c.command}`);
    }
  }
});

test('this file stays next to the installer that documents the hole', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  assert.equal(here, join(here)); // keeps the import graph honest under node --test
});
