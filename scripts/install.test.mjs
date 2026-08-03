import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const INSTALLER = fileURLToPath(new URL('./install.mjs', import.meta.url));

// The installer derives its harness root from its own location, so every test
// runs a copy planted in a throwaway tree. That is what makes "the harness
// stopped declaring this skill" expressible at all: the real checkout's
// .claude/skills cannot be edited to prove a retraction.
const HARNESS_DIRS = ['agents', 'hooks', 'commands'];
const HARNESS_SETTINGS = { agent: 'orchestrator', permissions: { allow: ['Bash(git status:*)'] } };

const ALPHA = 'alpha';
const BETA = 'beta';
const GAMMA = 'gamma';

function declareSkills(harness, names) {
  const dir = join(harness, '.claude', 'skills');
  rmSync(dir, { recursive: true, force: true });
  for (const name of names) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, 'SKILL.md'), `# ${name}\n`);
  }
}

function createHarness(harness, skills) {
  mkdirSync(join(harness, 'scripts'), { recursive: true });
  copyFileSync(INSTALLER, join(harness, 'scripts', 'install.mjs'));
  for (const name of HARNESS_DIRS) mkdirSync(join(harness, '.claude', name), { recursive: true });
  writeFileSync(
    join(harness, '.claude', 'settings.json'),
    `${JSON.stringify(HARNESS_SETTINGS, null, 2)}\n`,
  );
  declareSkills(harness, skills);
}

// realpath, because the installer resolves its own harness root from
// import.meta.url and Node hands that back already resolved: on macOS the
// symlinked /var/folders temp dir would make every recorded target disagree
// with the path the test built.
function withSandbox(skills, body) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'install-')));
  const sandbox = {
    root,
    harness: join(root, 'harness'),
    home: join(root, 'home'),
    foreign: join(root, 'other-toolkit'),
  };
  try {
    mkdirSync(sandbox.home);
    mkdirSync(sandbox.foreign, { recursive: true });
    createHarness(sandbox.harness, skills);
    return body(sandbox);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function install({ harness, home }, ...args) {
  const result = spawnSync(process.execPath, [join(harness, 'scripts', 'install.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
  assert.equal(result.status, 0, `installer exited ${result.status}\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

function skillLink({ home }, name) {
  return join(home, '.claude', 'skills', name);
}

function harnessSkill({ harness }, name) {
  return join(harness, '.claude', 'skills', name);
}

// lstat, never existsSync: a symlink whose target was deleted does not "exist"
// while sitting right there in ~/.claude/skills. That dangling link is half of
// the bug this file covers, so the check has to see the link, not its target.
function linkPresent(p) {
  return lstatSync(p, { throwIfNoEntry: false }) !== undefined;
}

function recordedLinks({ home }) {
  const raw = readFileSync(join(home, '.claude', '.my-configs-managed.json'), 'utf8');
  return JSON.parse(raw).addedLinks;
}

function recordedPaths(sandbox) {
  return recordedLinks(sandbox).map((link) => link.path).sort();
}

function declaredPaths({ home }, skills) {
  return [
    join(home, '.claude', 'harness'),
    ...HARNESS_DIRS.map((name) => join(home, '.claude', name)),
    ...skills.map((name) => join(home, '.claude', 'skills', name)),
  ].sort();
}

function plantForeignLink(sandbox, name) {
  const target = join(sandbox.foreign, name);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'SKILL.md'), `# ${name} from another toolkit\n`);
  const link = skillLink(sandbox, name);
  mkdirSync(join(sandbox.home, '.claude', 'skills'), { recursive: true });
  if (linkPresent(link)) unlinkSync(link);
  symlinkSync(target, link);
  return target;
}

test('a link the harness still declares survives a re-install', () => {
  withSandbox([ALPHA, BETA], (sandbox) => {
    install(sandbox);
    install(sandbox);

    for (const name of [ALPHA, BETA]) {
      assert.equal(readlinkSync(skillLink(sandbox, name)), harnessSkill(sandbox, name));
    }
    assert.deepEqual(recordedPaths(sandbox), declaredPaths(sandbox, [ALPHA, BETA]));
  });
});

test('a link the harness stopped declaring is removed from disk and from the metadata', () => {
  withSandbox([ALPHA, BETA], (sandbox) => {
    install(sandbox);
    assert.ok(linkPresent(skillLink(sandbox, BETA)), 'the first install must create the link');

    declareSkills(sandbox.harness, [ALPHA]);
    const stdout = install(sandbox);

    assert.equal(
      linkPresent(skillLink(sandbox, BETA)),
      false,
      'the undeclared link must be gone, not merely dangling',
    );
    assert.match(stdout, new RegExp(`removed symlink ${skillLink(sandbox, BETA)}`));
    assert.equal(readlinkSync(skillLink(sandbox, ALPHA)), harnessSkill(sandbox, ALPHA));
    assert.deepEqual(recordedPaths(sandbox), declaredPaths(sandbox, [ALPHA]));
  });
});

test('a retracted name whose link points somewhere else is left on disk', () => {
  withSandbox([ALPHA, BETA], (sandbox) => {
    install(sandbox);
    const foreignTarget = plantForeignLink(sandbox, BETA);

    declareSkills(sandbox.harness, [ALPHA]);
    install(sandbox);

    assert.equal(
      readlinkSync(skillLink(sandbox, BETA)),
      foreignTarget,
      'a name taken over by another toolkit is not ours to delete',
    );
    assert.deepEqual(
      recordedPaths(sandbox),
      declaredPaths(sandbox, [ALPHA]),
      'the metadata stops claiming a link the installer no longer owns',
    );
  });
});

test('a declared name already held by another toolkit is never recorded as ours', () => {
  withSandbox([ALPHA, GAMMA], (sandbox) => {
    const foreignTarget = plantForeignLink(sandbox, GAMMA);

    install(sandbox);
    install(sandbox);

    assert.equal(readlinkSync(skillLink(sandbox, GAMMA)), foreignTarget);
    assert.deepEqual(
      recordedPaths(sandbox),
      declaredPaths(sandbox, [ALPHA]),
      'a skipped name belongs to nobody in the metadata, so the next run has nothing to retract',
    );
  });
});

test('--dry-run reports the retraction without performing it', () => {
  withSandbox([ALPHA, BETA], (sandbox) => {
    install(sandbox);
    declareSkills(sandbox.harness, [ALPHA]);

    const stdout = install(sandbox, '--dry-run');

    assert.match(stdout, new RegExp(`would remove symlink ${skillLink(sandbox, BETA)}`));
    assert.equal(readlinkSync(skillLink(sandbox, BETA)), harnessSkill(sandbox, BETA));
    assert.deepEqual(recordedPaths(sandbox), declaredPaths(sandbox, [ALPHA, BETA]));
  });
});

test('retraction leaves the harness directory links alone', () => {
  withSandbox([ALPHA], (sandbox) => {
    install(sandbox);
    declareSkills(sandbox.harness, []);
    install(sandbox);

    assert.equal(
      readlinkSync(join(sandbox.home, '.claude', 'harness')),
      sandbox.harness,
      'the self-reference link is declared on every run',
    );
    for (const name of HARNESS_DIRS) {
      assert.equal(
        readlinkSync(join(sandbox.home, '.claude', name)),
        join(sandbox.harness, '.claude', name),
      );
    }
    assert.deepEqual(recordedPaths(sandbox), declaredPaths(sandbox, []));
  });
});
