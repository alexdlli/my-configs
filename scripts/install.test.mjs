import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
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
const EXTERNAL = 'ext-skill';

// EXTERNAL_SKILL_LINKS is a module constant with no runtime override, so the
// only way to exercise a skill declared from outside the checkout is to write
// the declaration into the planted copy — the same move as editing the
// throwaway .claude/skills, one level up. Always regenerated from the pristine
// installer, so re-declaring works as often as the test needs it.
const EXTERNAL_LINKS_DECLARATION = 'const EXTERNAL_SKILL_LINKS = {};';

function plantInstaller(harness, externalLinks) {
  const source = readFileSync(INSTALLER, 'utf8');
  assert.ok(
    source.includes(EXTERNAL_LINKS_DECLARATION),
    'the installer must still declare EXTERNAL_SKILL_LINKS as an empty object literal',
  );
  const declaration = `const EXTERNAL_SKILL_LINKS = ${JSON.stringify(externalLinks)};`;
  writeFileSync(
    join(harness, 'scripts', 'install.mjs'),
    source.replace(EXTERNAL_LINKS_DECLARATION, declaration),
  );
}

// The directory always exists afterwards, empty when `names` is: declaring no
// skill and having no readable declaration are different states, and only the
// first one may retract.
function declareSkills(harness, names) {
  const dir = join(harness, '.claude', 'skills');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const name of names) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, 'SKILL.md'), `# ${name}\n`);
  }
}

function declareExternalSkills(sandbox, names) {
  plantInstaller(
    sandbox.harness,
    Object.fromEntries(names.map((name) => [name, externalSkill(sandbox, name)])),
  );
}

function createHarness(harness, skills) {
  mkdirSync(join(harness, 'scripts'), { recursive: true });
  plantInstaller(harness, {});
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
    external: join(root, 'external-toolkit'),
  };
  try {
    mkdirSync(sandbox.home);
    mkdirSync(sandbox.foreign, { recursive: true });
    mkdirSync(sandbox.external, { recursive: true });
    createHarness(sandbox.harness, skills);
    return body(sandbox);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function run({ harness, home }, ...args) {
  return spawnSync(process.execPath, [join(harness, 'scripts', 'install.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
}

function install(sandbox, ...args) {
  const result = run(sandbox, ...args);
  assert.equal(result.status, 0, `installer exited ${result.status}\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

function skillLink({ home }, name) {
  return join(home, '.claude', 'skills', name);
}

function harnessSkill({ harness }, name) {
  return join(harness, '.claude', 'skills', name);
}

function externalSkill({ external }, name) {
  return join(external, name);
}

function createExternalSkill(sandbox, name) {
  const target = externalSkill(sandbox, name);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'SKILL.md'), `# ${name} installed outside the harness\n`);
  return target;
}

function setInstalledAgent({ home }, agent) {
  const settingsPath = join(home, '.claude', 'settings.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  settings.agent = agent;
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
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

test('an external skill whose target went missing keeps its link', () => {
  withSandbox([ALPHA], (sandbox) => {
    const target = createExternalSkill(sandbox, EXTERNAL);
    declareExternalSkills(sandbox, [EXTERNAL]);
    install(sandbox);
    assert.equal(readlinkSync(skillLink(sandbox, EXTERNAL)), target);

    rmSync(target, { recursive: true, force: true });
    const stdout = install(sandbox);

    assert.match(stdout, new RegExp(`external skill ${EXTERNAL} not found`));
    assert.doesNotMatch(
      stdout,
      new RegExp(`removed symlink ${skillLink(sandbox, EXTERNAL)}`),
      'a target that vanished is not the harness dropping the declaration',
    );
    assert.ok(linkPresent(skillLink(sandbox, EXTERNAL)), 'the link must survive on disk');
    assert.deepEqual(recordedPaths(sandbox), declaredPaths(sandbox, [ALPHA, EXTERNAL]));
  });
});

test('an external skill the harness stopped declaring is retracted', () => {
  withSandbox([ALPHA], (sandbox) => {
    const target = createExternalSkill(sandbox, EXTERNAL);
    declareExternalSkills(sandbox, [EXTERNAL]);
    install(sandbox);

    declareExternalSkills(sandbox, []);
    const stdout = install(sandbox);

    assert.equal(linkPresent(skillLink(sandbox, EXTERNAL)), false);
    assert.match(stdout, new RegExp(`removed symlink ${skillLink(sandbox, EXTERNAL)}`));
    assert.deepEqual(recordedPaths(sandbox), declaredPaths(sandbox, [ALPHA]));
    assert.ok(
      lstatSync(target).isDirectory(),
      'retracting the link never touches the toolkit that installed the skill',
    );
  });
});

test('an unreadable harness skills directory aborts instead of retracting every skill', () => {
  withSandbox([ALPHA, BETA], (sandbox) => {
    install(sandbox);

    rmSync(join(sandbox.harness, '.claude', 'skills'), { recursive: true, force: true });
    const result = run(sandbox);

    assert.notEqual(result.status, 0, 'a harness that cannot be read declares nothing knowable');
    assert.match(result.stderr, /cannot read .*\.claude\/skills/);
    for (const name of [ALPHA, BETA]) {
      assert.ok(linkPresent(skillLink(sandbox, name)), `${name} must still be linked`);
    }
    assert.deepEqual(recordedPaths(sandbox), declaredPaths(sandbox, [ALPHA, BETA]));
  });
});

test('an install that aborts on the agent conflict retracts nothing', () => {
  withSandbox([ALPHA, BETA], (sandbox) => {
    install(sandbox);
    setInstalledAgent(sandbox, 'someone-elses-agent');

    declareSkills(sandbox.harness, [ALPHA]);
    const result = run(sandbox);

    assert.equal(result.status, 1, 'the agent conflict must still abort the install');
    assert.ok(
      linkPresent(skillLink(sandbox, BETA)),
      'a non-zero exit must not leave the machine changed by a run that wrote no metadata',
    );
    assert.deepEqual(recordedPaths(sandbox), declaredPaths(sandbox, [ALPHA, BETA]));
  });
});

test('a retracted path that is a real directory is left on disk', () => {
  withSandbox([ALPHA, BETA], (sandbox) => {
    install(sandbox);

    // ~/.claude/skills is shared ground, so a recorded path can stop being a
    // symlink between two runs: another toolkit installs its own copy there.
    const dest = skillLink(sandbox, BETA);
    const marker = '# beta, installed for real by another toolkit\n';
    unlinkSync(dest);
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'SKILL.md'), marker);

    declareSkills(sandbox.harness, [ALPHA]);
    const stdout = install(sandbox);

    assert.equal(lstatSync(dest).isSymbolicLink(), false, 'the directory must not be replaced');
    assert.equal(readFileSync(join(dest, 'SKILL.md'), 'utf8'), marker, 'and not be emptied');
    assert.match(stdout, new RegExp(`${dest} exists but is not a symlink`));
    assert.deepEqual(recordedPaths(sandbox), declaredPaths(sandbox, [ALPHA]));
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
