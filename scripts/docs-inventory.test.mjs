import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const MARKDOWN = '.md';
const MODULE = '.mjs';
const TEST_MODULE = '.test.mjs';
const DIRECTORY_ENTRY = null;

const README = 'README.md';
const CLAUDE = 'CLAUDE.md';
const AGENT_SYSTEM = 'docs/agent-system.md';
const CONTRIBUTING = 'docs/contributing.md';
const INSTALLATION = 'docs/installation.md';

const ORCHESTRATOR_AGENT = 'orchestrator';
const UNWALKED_DIRECTORIES = new Set(['.git', 'node_modules', '.wave']);

const COUNT_MARKER = /<!--\s*docs-count:([A-Za-z-]+)\s*-->[ \t]*(\S+)/g;
const NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen', 'twenty',
];
const NAME_CHARACTER = /[A-Za-z0-9_-]/;

const INVENTORIES = {
  agents: {
    dir: '.claude/agents',
    suffix: MARKDOWN,
    indexes: [README, CLAUDE, AGENT_SYSTEM],
  },
  skills: {
    dir: '.claude/skills',
    suffix: DIRECTORY_ENTRY,
    sharedNamespace: true,
    indexes: [README, CLAUDE, AGENT_SYSTEM],
  },
  commands: {
    dir: '.claude/commands',
    suffix: MARKDOWN,
    indexes: [README, CLAUDE, AGENT_SYSTEM],
  },
  hooks: {
    dir: '.claude/hooks',
    suffix: MODULE,
    indexes: [README, INSTALLATION],
  },
  integrations: {
    dir: 'docs/integrations',
    suffix: MARKDOWN,
    indexes: [README, CONTRIBUTING],
  },
  waveScripts: {
    dir: 'scripts/waves',
    suffix: MODULE,
    skipSuffix: TEST_MODULE,
    indexes: [CLAUDE, CONTRIBUTING],
  },
};

function entryNames({ dir, suffix, skipSuffix }) {
  const entries = readdirSync(join(REPO_ROOT, dir), { withFileTypes: true });
  if (suffix === DIRECTORY_ENTRY) {
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .filter((entry) => !skipSuffix || !entry.name.endsWith(skipSuffix))
    .map((entry) => entry.name.slice(0, -suffix.length))
    .sort();
}

function sourceGlob({ dir, suffix }) {
  return suffix === DIRECTORY_ENTRY ? `${dir}/*/` : `${dir}/*${suffix}`;
}

function inventoryNames() {
  return Object.fromEntries(
    Object.entries(INVENTORIES).map(([key, inventory]) => [key, entryNames(inventory)]),
  );
}

function markdownFilesUnder(dir) {
  const found = [];
  for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
    const path = dir === '.' ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!UNWALKED_DIRECTORIES.has(entry.name)) found.push(...markdownFilesUnder(path));
    } else if (entry.name.endsWith(MARKDOWN)) {
      found.push(path);
    }
  }
  return found.sort();
}

function readDoc(path) {
  return readFileSync(join(REPO_ROOT, path), 'utf8');
}

function mentions(text, name) {
  const haystack = text.toLowerCase();
  const needle = name.toLowerCase();
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    const before = haystack[at - 1] ?? '';
    const after = haystack[at + needle.length] ?? '';
    if (!NAME_CHARACTER.test(before) && !NAME_CHARACTER.test(after)) return true;
    from = at + 1;
  }
}

function blankFencedBlocks(text) {
  let inside = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inside = !inside;
        return '';
      }
      return inside ? '' : line;
    })
    .join('\n');
}

function lineNumber(text, index) {
  return text.slice(0, index).split('\n').length;
}

function parseCount(token) {
  if (/^\d+$/.test(token)) return Number(token);
  const spelled = NUMBER_WORDS.indexOf(token.toLowerCase());
  return spelled < 0 ? null : spelled;
}

function escapeForRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pathReferencePattern({ dir, suffix }) {
  const tail = suffix === DIRECTORY_ENTRY ? '' : escapeForRegExp(suffix);
  return new RegExp(`${escapeForRegExp(dir)}/([A-Za-z0-9_-]+)${tail}`, 'g');
}

function report(problems) {
  return `\n${problems.join('\n')}\n`;
}

test('a name counts as mentioned only when it stands on its own', () => {
  assert.equal(mentions('the `reviewer` agent', 'reviewer'), true);
  assert.equal(mentions('the `pr-reviewer` agent', 'reviewer'), false);
  assert.equal(mentions('`wave-monitor-two`', 'wave-monitor'), false);
  assert.equal(mentions('`/wave-run` dispatches one wave', 'wave-run'), true);
  assert.equal(mentions('[`docs/integrations/ai-memory.md`]', 'ai-memory'), true);
  assert.equal(mentions('| EcoTokens | Optional Rust output filter |', 'ecotokens'), true);
});

test('a claimed count is read as digits or as an English numeral', () => {
  assert.equal(parseCount('7'), 7);
  assert.equal(parseCount('Five'), 5);
  assert.equal(parseCount('fourteen'), 14);
  assert.equal(parseCount('several'), null);
});

test('a marker inside a fenced block is an example, not a claim', () => {
  const doc = ['prose', '```markdown', 'Plus <!-- docs-count:hooks -->nine hooks', '```', ''].join('\n');
  assert.deepEqual([...blankFencedBlocks(doc).matchAll(COUNT_MARKER)], []);
  assert.equal(blankFencedBlocks(doc).split('\n').length, doc.split('\n').length);
});

for (const [key, inventory] of Object.entries(INVENTORIES)) {
  test(`every ${key} entry is named in the docs that index them`, () => {
    const entries = entryNames(inventory);
    const glob = sourceGlob(inventory);
    assert.notEqual(entries.length, 0, `${glob} matched nothing — the inventory moved or was renamed`);

    const problems = [];
    for (const doc of inventory.indexes) {
      const text = readDoc(doc);
      for (const name of entries) {
        if (!mentions(text, name)) {
          problems.push(`${glob} contains "${name}" but ${doc} never names it`);
        }
      }
    }
    assert.deepEqual(problems, [], report(problems));
  });
}

test('no doc points at a harness-owned entry that is not on disk', () => {
  const known = inventoryNames();
  const owned = Object.entries(INVENTORIES).filter(([, inventory]) => !inventory.sharedNamespace);
  const problems = [];
  for (const doc of markdownFilesUnder('.')) {
    const text = readDoc(doc);
    for (const [key, inventory] of owned) {
      for (const match of text.matchAll(pathReferencePattern(inventory))) {
        if (known[key].includes(match[1])) continue;
        problems.push(
          `${doc}:${lineNumber(text, match.index)} points at ${match[0]}, which does not exist`,
        );
      }
    }
  }
  assert.deepEqual(problems, [], report(problems));
});

test('every docs-count marker matches what the directory holds', () => {
  const entries = inventoryNames();
  const countable = {
    ...entries,
    specialists: entries.agents.filter((name) => name !== ORCHESTRATOR_AGENT),
  };
  const problems = [];

  for (const doc of markdownFilesUnder('.')) {
    const text = blankFencedBlocks(readDoc(doc));
    for (const match of text.matchAll(COUNT_MARKER)) {
      const [, key, claimed] = match;
      const at = `${doc}:${lineNumber(text, match.index)}`;

      if (!(key in countable)) {
        problems.push(`${at} uses unknown key "${key}" — known keys: ${Object.keys(countable).join(', ')}`);
        continue;
      }
      if (/^\s*$/.test(text.slice(text.lastIndexOf('\n', match.index) + 1, match.index))) {
        problems.push(`${at} starts its line — put the marker after some text, or CommonMark reads the whole line as raw HTML`);
      }

      const expected = countable[key];
      const claimedCount = parseCount(claimed);
      if (claimedCount === null) {
        problems.push(`${at} is followed by "${claimed}", which is not a number`);
      } else if (claimedCount !== expected.length) {
        problems.push(`${at} claims ${claimed} ${key}, but there are ${expected.length}: ${expected.join(', ')}`);
      }
    }
  }
  assert.deepEqual(problems, [], report(problems));
});
