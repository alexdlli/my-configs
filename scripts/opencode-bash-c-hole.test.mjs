// Measured gap + live guard for OpenCode.
//
// 1. permission.bash patterns come from .opencode/opencode.json (not a hand copy).
// 2. OpenCode collects tree-sitter `command` nodes only — bash -c "…" yields the
//    outer bash line, which does not match git/gh deny|ask rules.
// 3. The plugin default export is imported and driven: wrapped force-push throws,
//    plain git status resolves. Delete the plugin and this file fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  RULE_GIT_PUSH_FORCE,
  RULE_GIT_COMMIT_NO_VERIFY,
  classifyCommand,
} from '../.claude/hooks/lib/destructive.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OPENCODE_JSON = join(ROOT, '.opencode', 'opencode.json');
const PLUGIN_PATH = join(ROOT, '.opencode', 'plugin', 'guard-destructive.js');

function loadHarnessBashRules() {
  assert.ok(existsSync(OPENCODE_JSON), `.opencode/opencode.json must exist at ${OPENCODE_JSON}`);
  const cfg = JSON.parse(readFileSync(OPENCODE_JSON, 'utf8'));
  const bash = cfg?.permission?.bash;
  assert.ok(bash && typeof bash === 'object', 'permission.bash must be an object');
  // Insertion order is the evaluation order (findLast).
  return Object.entries(bash).map(([pattern, action]) => ({ pattern, action }));
}

function wildcardMatch(text, pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(text);
}

function lastMatchingAction(text, rules) {
  let action = 'ask';
  for (const rule of rules) {
    if (wildcardMatch(text, rule.pattern)) action = rule.action;
  }
  return action;
}

// Patterns OpenCode collects for each command (shell.ts command-node walk,
// v1.18.13). bash -c keeps the script as a string child, not a nested command.
const PERMISSION_CASES = [
  {
    command: 'git push --force origin main',
    opencodePatterns: ['git push --force origin main'],
    expectAction: 'deny',
  },
  {
    command: 'git push --force-with-lease origin main',
    opencodePatterns: ['git push --force-with-lease origin main'],
    expectAction: 'allow',
  },
  {
    command: 'bash -c "git push --force origin main"',
    opencodePatterns: ['bash -c "git push --force origin main"'],
    expectAction: 'allow',
  },
  {
    command: 'gh pr merge 16',
    opencodePatterns: ['gh pr merge 16'],
    expectAction: 'ask',
  },
  {
    command: "bash -c 'gh pr merge 16'",
    opencodePatterns: ["bash -c 'gh pr merge 16'"],
    expectAction: 'allow',
  },
  {
    command: 'git commit --no-verify -m wip',
    opencodePatterns: ['git commit --no-verify -m wip'],
    expectAction: 'deny',
  },
];

test('harness bash rules put deny/ask AFTER the catch-all (findLast order)', () => {
  const rules = loadHarnessBashRules();
  assert.equal(rules[0].pattern, '*');
  assert.equal(rules[0].action, 'allow');
  const specific = rules.slice(1);
  assert.ok(specific.some((r) => r.action === 'deny'));
  assert.ok(specific.some((r) => r.pattern.startsWith('gh') && r.action === 'ask'));
  assert.ok(
    !specific.some((r) => r.pattern.includes('--force*')),
    'do not use --force* — it also denies --force-with-lease',
  );
});

test('permission.bash alone misses shell-wrapped destructive commands', () => {
  const rules = loadHarnessBashRules();
  for (const c of PERMISSION_CASES) {
    const action = c.opencodePatterns.map((p) => lastMatchingAction(p, rules)).at(-1);
    assert.equal(action, c.expectAction, c.command);
  }
});

test('classifyCommand catches the wrapped forms permission misses', () => {
  assert.equal(classifyCommand('bash -c "git push --force origin main"').rule, RULE_GIT_PUSH_FORCE);
  assert.equal(classifyCommand('bash -c "git push --force origin main"').wrapped, true);
  assert.equal(
    classifyCommand('sh -c "git commit --no-verify -m wip"').rule,
    RULE_GIT_COMMIT_NO_VERIFY,
  );
  assert.equal(classifyCommand('git push --force-with-lease origin main').blocked, false);
});

test('plugin blocks wrapped force-push and allows git status', async () => {
  assert.ok(existsSync(PLUGIN_PATH), `plugin must exist at ${PLUGIN_PATH}`);
  const mod = await import(pathToFileURL(PLUGIN_PATH).href);
  assert.equal(typeof mod.default, 'function', 'plugin must default-export a factory');
  const hooks = await mod.default({ directory: ROOT });
  assert.equal(typeof hooks['tool.execute.before'], 'function');

  await assert.rejects(
    () =>
      hooks['tool.execute.before'](
        { tool: 'bash' },
        { args: { command: 'bash -c "git push --force origin main"' } },
      ),
    /guard-destructive|git push --force/,
  );

  await assert.rejects(
    () =>
      hooks['tool.execute.before'](
        { tool: 'bash' },
        { args: { command: 'git commit --no-verify -m wip' } },
      ),
    /guard-destructive|no-verify/,
  );

  await assert.doesNotReject(() =>
    hooks['tool.execute.before']({ tool: 'bash' }, { args: { command: 'git status' } }),
  );
});

test('plugin stays silent on non-worker merge so permission ask can fire', async () => {
  const mod = await import(pathToFileURL(PLUGIN_PATH).href);
  const hooks = await mod.default({ directory: ROOT });
  // This repo has no .wave/worker.json → CONTEXT_OTHER → plugin returns.
  await assert.doesNotReject(() =>
    hooks['tool.execute.before']({ tool: 'bash' }, { args: { command: 'gh pr merge 16' } }),
  );
  // permission.bash must still ask (not allow) for the literal form.
  const rules = loadHarnessBashRules();
  assert.equal(lastMatchingAction('gh pr merge 16', rules), 'ask');
});
