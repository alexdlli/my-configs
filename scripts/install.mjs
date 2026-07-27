#!/usr/bin/env node
// Install (or uninstall) the personal Claude Code harness into ~/.claude/.
//
// Symlinks ~/.claude/{agents,hooks} into the harness checkout, and deep-merges
// a managed slice of ~/.claude/settings.json (agent, permissions.allow, and
// every hook event the harness declares) without disturbing keys the user owns
// (theme, enabledPlugins, extraKnownMarketplaces, ...).
//
// Usage:
//   node scripts/install.mjs                # install or refresh
//   node scripts/install.mjs --dry-run      # show plan, touch nothing
//   node scripts/install.mjs --force-agent  # override existing settings.agent
//   node scripts/install.mjs --uninstall    # revert what this installer added
//   node scripts/install.mjs -h | --help
//
// macOS/Linux only. Requires Node.js 24+.

import { argv, exit, platform } from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_ROOT = path.resolve(__dirname, '..');

const HOME = os.homedir();
const TARGET_DIR = path.join(HOME, '.claude');
const SETTINGS_PATH = path.join(TARGET_DIR, 'settings.json');
const METADATA_PATH = path.join(TARGET_DIR, '.my-configs-managed.json');
const SYMLINK_ITEMS = ['agents', 'hooks'];
const TARGET_HOOKS_DIR = path.join(TARGET_DIR, 'hooks');
const METADATA_VERSION = 2;

// v1 metadata predates addedLinks. That installer only ever created these two
// symlinks, so they are exactly what an uninstall of a v1 install must remove.
const V1_MANAGED_LINK_NAMES = ['agents', 'hooks'];

// An existing entry that is not one of ours is either backed up out of the way
// or left untouched, depending on how much the target directory belongs to us.
const CONFLICT_BACKUP = 'backup';
const CONFLICT_SKIP = 'skip';

function usage() {
  console.log(`Install the personal Claude Code harness into ~/.claude/.

Usage:
  node scripts/install.mjs [options]

Options:
  --dry-run        Print the plan; do not touch the filesystem
  --force-agent    Overwrite settings.agent even if user already set it
  --uninstall      Remove symlinks and revert the keys this installer added
  -h, --help       Show this help

What gets installed:
  ~/.claude/agents   → symlink to <harness>/.claude/agents
  ~/.claude/hooks    → symlink to <harness>/.claude/hooks
  ~/.claude/settings.json deep-merged: adds agent, permissions.allow entries,
                     and every hook event declared by the harness settings. All
                     other keys (theme, enabledPlugins, extraKnownMarketplaces,
                     ...) are left untouched.
  ~/.claude/.my-configs-managed.json records exactly what was added so that
                     --uninstall can revert it without nuking user state.`);
}

function die(msg) {
  console.error(`! error: ${msg}`);
  exit(1);
}

function parseArgs(args) {
  const opts = { mode: 'install', dryRun: false, forceAgent: false };
  for (const a of args) {
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--force-agent') opts.forceAgent = true;
    else if (a === '--uninstall') opts.mode = 'uninstall';
    else if (a === '-h' || a === '--help') {
      usage();
      exit(0);
    } else {
      console.error(`! error: unknown option: ${a}`);
      usage();
      exit(1);
    }
  }
  return opts;
}

async function pathKind(p) {
  try {
    const stat = await fs.lstat(p);
    if (stat.isSymbolicLink()) return 'symlink';
    if (stat.isDirectory()) return 'dir';
    if (stat.isFile()) return 'file';
    return 'other';
  } catch {
    return 'absent';
  }
}

async function readJsonOrEmpty(p) {
  try {
    const raw = await fs.readFile(p, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function cloneJson(v) {
  return JSON.parse(JSON.stringify(v));
}

// Rewrite "node .claude/hooks/x.mjs" → "node <TARGET_HOOKS_DIR>/x.mjs" so the
// hook fires regardless of the session's cwd. Leaves other commands alone.
function absolutizeHookCommand(command) {
  const relPrefix = 'node .claude/hooks/';
  if (typeof command !== 'string' || !command.startsWith(relPrefix)) {
    return command;
  }
  const rest = command.slice(relPrefix.length);
  return `node ${path.join(TARGET_HOOKS_DIR, rest)}`;
}

function rewriteHookEntries(entries) {
  return entries.map((entry) => {
    const next = cloneJson(entry);
    if (Array.isArray(next.hooks)) {
      next.hooks = next.hooks.map((h) => ({
        ...h,
        command: absolutizeHookCommand(h.command),
      }));
    }
    return next;
  });
}

function hookEntryScriptName(entry) {
  if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) return null;
  for (const h of entry.hooks) {
    if (typeof h?.command !== 'string') continue;
    const match = h.command.match(/([\w.-]+\.mjs)/);
    if (match) return match[1];
  }
  return null;
}

function userHasHookForScript(userEntries, scriptName) {
  if (!Array.isArray(userEntries)) return false;
  return userEntries.some((entry) => {
    if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) return false;
    return entry.hooks.some(
      (h) => typeof h?.command === 'string' && h.command.includes(scriptName),
    );
  });
}

// Appends the harness entries missing from merged.permissions[listName],
// returning only the ones this run introduced.
function appendPermissionEntries(merged, listName, harnessEntries) {
  if (!Array.isArray(harnessEntries) || harnessEntries.length === 0) return [];
  if (!isPlainObject(merged.permissions)) merged.permissions = {};
  if (!Array.isArray(merged.permissions[listName])) merged.permissions[listName] = [];
  const existing = new Set(merged.permissions[listName]);
  const appended = [];
  for (const entry of harnessEntries) {
    if (existing.has(entry)) continue;
    merged.permissions[listName].push(entry);
    existing.add(entry);
    appended.push(entry);
  }
  return appended;
}

// Returns { merged, added }. `merged` is the full settings to write; `added`
// records only what this run introduced (so uninstall can revert exactly that,
// nothing else). `addedLinks` is filled in by the caller.
function buildMergedSettings(userSettings, harnessSettings, opts) {
  const merged = cloneJson(userSettings);
  const added = {
    addedKeys: [],
    addedAllowEntries: [],
    addedDenyEntries: [],
    addedHooks: [],
    addedLinks: [],
  };

  if (Object.hasOwn(harnessSettings, 'agent')) {
    const harnessAgent = harnessSettings.agent;
    if (Object.hasOwn(merged, 'agent')) {
      if (merged.agent !== harnessAgent) {
        if (!opts.forceAgent) {
          die(
            `settings.agent is already "${merged.agent}". ` +
              `Re-run with --force-agent to overwrite to "${harnessAgent}".`,
          );
        }
        merged.agent = harnessAgent;
      }
    } else {
      merged.agent = harnessAgent;
      added.addedKeys.push('agent');
    }
  }

  added.addedAllowEntries = appendPermissionEntries(
    merged,
    'allow',
    harnessSettings?.permissions?.allow,
  );
  added.addedDenyEntries = appendPermissionEntries(
    merged,
    'deny',
    harnessSettings?.permissions?.deny,
  );

  const harnessHooks = harnessSettings?.hooks;
  if (isPlainObject(harnessHooks)) {
    if (!isPlainObject(merged.hooks)) merged.hooks = {};
    for (const event of Object.keys(harnessHooks)) {
      const harnessEntries = harnessHooks[event];
      if (!Array.isArray(harnessEntries) || harnessEntries.length === 0) continue;
      const rewritten = rewriteHookEntries(harnessEntries);
      if (!Array.isArray(merged.hooks[event])) merged.hooks[event] = [];
      for (const entry of rewritten) {
        const scriptName = hookEntryScriptName(entry);
        if (scriptName && userHasHookForScript(merged.hooks[event], scriptName)) {
          continue;
        }
        merged.hooks[event].push(entry);
        const command = entry.hooks?.[0]?.command ?? '';
        added.addedHooks.push({ event, command });
      }
    }
  }

  return { merged, added };
}

function hookSignature(hook) {
  return JSON.stringify([hook.event, hook.command]);
}

function linkSignature(link) {
  return JSON.stringify([link.path, link.target]);
}

function dedupeBySignature(prior, incoming, signature) {
  const seen = new Set(prior.map(signature));
  const merged = [...prior];
  for (const item of incoming) {
    const sig = signature(item);
    if (seen.has(sig)) continue;
    seen.add(sig);
    merged.push(item);
  }
  return merged;
}

function normalizeMetadata(raw) {
  const asArray = (v) => (Array.isArray(v) ? v : []);
  let addedLinks;
  if (Array.isArray(raw?.addedLinks)) {
    addedLinks = raw.addedLinks;
  } else if (raw?.version) {
    addedLinks = V1_MANAGED_LINK_NAMES.map((name) => ({
      path: path.join(TARGET_DIR, name),
      target: path.join(HARNESS_ROOT, '.claude', name),
    }));
  } else {
    addedLinks = [];
  }
  return {
    addedKeys: asArray(raw?.addedKeys),
    addedAllowEntries: asArray(raw?.addedAllowEntries),
    addedDenyEntries: asArray(raw?.addedDenyEntries),
    addedHooks: asArray(raw?.addedHooks),
    addedLinks,
  };
}

function mergeMetadata(prior, added) {
  const normalized = normalizeMetadata(prior);
  return {
    version: METADATA_VERSION,
    addedKeys: [...new Set([...normalized.addedKeys, ...added.addedKeys])],
    addedAllowEntries: [
      ...new Set([...normalized.addedAllowEntries, ...added.addedAllowEntries]),
    ],
    addedDenyEntries: [
      ...new Set([...normalized.addedDenyEntries, ...added.addedDenyEntries]),
    ],
    addedHooks: dedupeBySignature(normalized.addedHooks, added.addedHooks, hookSignature),
    addedLinks: dedupeBySignature(normalized.addedLinks, added.addedLinks, linkSignature),
  };
}

function describePreserved(userSettings, added) {
  const userKeys = Object.keys(userSettings);
  const managed = new Set(['agent', 'permissions', 'hooks']);
  return userKeys.filter((k) => !managed.has(k));
}

async function ensureTargetDir(dryRun) {
  if (existsSync(TARGET_DIR)) return;
  if (dryRun) {
    console.log(`→ would create ${TARGET_DIR}`);
    return;
  }
  await fs.mkdir(TARGET_DIR, { recursive: true });
  console.log(`✓ created ${TARGET_DIR}`);
}

async function readLinkTarget(p) {
  try {
    return await fs.readlink(p);
  } catch {
    return null;
  }
}

// Returns null when the destination is left alone, otherwise
// { path, target, changed } — `changed` marks a link this run created.
async function ensureLink(dest, target, dryRun, onConflict) {
  const kind = await pathKind(dest);

  if (kind === 'symlink') {
    const current = await readLinkTarget(dest);
    if (current === target) {
      console.log(`✓ ${dest} already points to ${target}`);
      return { path: dest, target, changed: false };
    }
    if (onConflict === CONFLICT_SKIP) {
      console.log(`! ${dest} → ${current} (not ours) — skipping`);
      return null;
    }
    if (dryRun) {
      console.log(`→ would replace symlink ${dest} (currently → ${current}) with → ${target}`);
    } else {
      await fs.unlink(dest);
      await fs.symlink(target, dest, 'dir');
      console.log(`✓ replaced symlink ${dest} → ${target}`);
    }
    return { path: dest, target, changed: true };
  }

  if (kind === 'absent') {
    if (dryRun) {
      console.log(`→ would symlink ${dest} → ${target}`);
    } else {
      await fs.symlink(target, dest, 'dir');
      console.log(`✓ symlinked ${dest} → ${target}`);
    }
    return { path: dest, target, changed: true };
  }

  if (onConflict === CONFLICT_SKIP) {
    console.log(`! ${dest} already exists (${kind}) and is not ours — skipping`);
    return null;
  }

  const backupPath = `${dest}.backup-${Date.now()}`;
  if (dryRun) {
    console.log(`→ would back up ${dest} (${kind}) → ${backupPath}, then symlink → ${target}`);
  } else {
    await fs.rename(dest, backupPath);
    console.log(`! backed up existing ${kind} at ${dest} → ${backupPath}`);
    await fs.symlink(target, dest, 'dir');
    console.log(`✓ symlinked ${dest} → ${target}`);
  }
  return { path: dest, target, changed: true };
}

async function linkHarnessDirs(dryRun) {
  const links = [];
  for (const name of SYMLINK_ITEMS) {
    const link = await ensureLink(
      path.join(TARGET_DIR, name),
      path.join(HARNESS_ROOT, '.claude', name),
      dryRun,
      CONFLICT_BACKUP,
    );
    if (link) links.push(link);
  }
  return links;
}

async function writeSettingsAtomic(merged) {
  const tmpPath = path.join(TARGET_DIR, '.settings.json.tmp');
  if (existsSync(SETTINGS_PATH)) {
    const backupPath = `${SETTINGS_PATH}.backup-${Date.now()}`;
    await fs.copyFile(SETTINGS_PATH, backupPath);
    console.log(`✓ backed up previous settings.json → ${backupPath}`);
  }
  const serialized = `${JSON.stringify(merged, null, 2)}\n`;
  await fs.writeFile(tmpPath, serialized);
  await fs.rename(tmpPath, SETTINGS_PATH);
}

async function runInstall(opts) {
  console.log(`harness: ${HARNESS_ROOT}`);
  console.log(`target:  ${TARGET_DIR}`);
  console.log(`mode:    ${opts.dryRun ? 'install (dry-run)' : 'install'}`);
  console.log();

  await ensureTargetDir(opts.dryRun);

  const links = await linkHarnessDirs(opts.dryRun);

  const userSettings = await readJsonOrEmpty(SETTINGS_PATH);
  const harnessSettings = await readJsonOrEmpty(
    path.join(HARNESS_ROOT, '.claude', 'settings.json'),
  );
  const { merged, added } = buildMergedSettings(userSettings, harnessSettings, opts);
  added.addedLinks = links.map(({ path: dest, target }) => ({ path: dest, target }));

  const preservedKeys = describePreserved(userSettings, added);
  const summaryParts = [];
  if (preservedKeys.length > 0) summaryParts.push(`preserved ${preservedKeys.join(', ')}`);
  const addedSummary = [];
  const createdLinks = links.filter((link) => link.changed).length;
  if (createdLinks > 0) addedSummary.push(`${createdLinks} link(s)`);
  if (added.addedKeys.length > 0) addedSummary.push(added.addedKeys.join(', '));
  if (added.addedAllowEntries.length > 0)
    addedSummary.push(`${added.addedAllowEntries.length} permissions.allow entries`);
  if (added.addedDenyEntries.length > 0)
    addedSummary.push(`${added.addedDenyEntries.length} permissions.deny entries`);
  if (added.addedHooks.length > 0)
    addedSummary.push(`${added.addedHooks.length} hook(s)`);
  if (addedSummary.length > 0) summaryParts.push(`added ${addedSummary.join(', ')}`);
  if (summaryParts.length === 0) summaryParts.push('no changes needed');

  if (opts.dryRun) {
    console.log(`→ would merge settings.json (${summaryParts.join('; ')})`);
    console.log('--- merged settings.json (dry-run) ---');
    console.log(JSON.stringify(merged, null, 2));
    console.log('--- end ---');
    const prior = await readJsonOrEmpty(METADATA_PATH);
    const metadata = mergeMetadata(prior, added);
    console.log('→ would write metadata:');
    console.log(JSON.stringify(metadata, null, 2));
    console.log('\n(dry-run) nothing changed.');
    return;
  }

  console.log(`→ merging settings.json (${summaryParts.join('; ')})`);
  await writeSettingsAtomic(merged);
  console.log(`✓ wrote ${SETTINGS_PATH}`);

  const prior = await readJsonOrEmpty(METADATA_PATH);
  const metadata = mergeMetadata(prior, added);
  await fs.writeFile(METADATA_PATH, `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(`✓ wrote ${METADATA_PATH}`);

  console.log('\nDone. Open a new Claude Code session and run /agents to confirm orchestrator is active.');
}

async function removeManagedLink(dest, expectedTarget, dryRun) {
  const kind = await pathKind(dest);

  if (kind === 'absent') {
    console.log(`  ${dest} not present`);
    return;
  }
  if (kind !== 'symlink') {
    console.log(`! ${dest} exists but is not a symlink — leaving alone`);
    return;
  }
  const current = await readLinkTarget(dest);
  if (current !== expectedTarget) {
    console.log(`! ${dest} → ${current} (not ours) — leaving alone`);
    return;
  }
  if (dryRun) {
    console.log(`→ would remove symlink ${dest}`);
    return;
  }
  await fs.unlink(dest);
  console.log(`✓ removed symlink ${dest}`);
}

function dropPermissionEntries(reverted, listName, entries) {
  if (entries.length === 0) return;
  if (!Array.isArray(reverted?.permissions?.[listName])) return;
  const drop = new Set(entries);
  reverted.permissions[listName] = reverted.permissions[listName].filter((e) => !drop.has(e));
  if (reverted.permissions[listName].length === 0) delete reverted.permissions[listName];
}

function revertSettings(userSettings, metadata) {
  const reverted = cloneJson(userSettings);
  for (const key of metadata.addedKeys) {
    delete reverted[key];
  }
  dropPermissionEntries(reverted, 'allow', metadata.addedAllowEntries);
  dropPermissionEntries(reverted, 'deny', metadata.addedDenyEntries);
  if (isPlainObject(reverted.permissions) && Object.keys(reverted.permissions).length === 0) {
    delete reverted.permissions;
  }
  if (metadata.addedHooks.length > 0) {
    const byEvent = new Map();
    for (const { event, command } of metadata.addedHooks) {
      if (!byEvent.has(event)) byEvent.set(event, new Set());
      byEvent.get(event).add(command);
    }
    if (isPlainObject(reverted.hooks)) {
      for (const [event, commands] of byEvent) {
        const entries = reverted.hooks[event];
        if (!Array.isArray(entries)) continue;
        reverted.hooks[event] = entries.filter((entry) => {
          const cmd = entry?.hooks?.[0]?.command;
          return !(typeof cmd === 'string' && commands.has(cmd));
        });
        if (reverted.hooks[event].length === 0) delete reverted.hooks[event];
      }
      if (Object.keys(reverted.hooks).length === 0) delete reverted.hooks;
    }
  }
  return reverted;
}

async function runUninstall(opts) {
  console.log(`harness: ${HARNESS_ROOT}`);
  console.log(`target:  ${TARGET_DIR}`);
  console.log(`mode:    ${opts.dryRun ? 'uninstall (dry-run)' : 'uninstall'}`);
  console.log();

  const rawMetadata = await readJsonOrEmpty(METADATA_PATH);
  if (!rawMetadata.version) {
    console.log('  no .my-configs-managed.json metadata — nothing to revert');
    return;
  }
  const metadata = normalizeMetadata(rawMetadata);

  for (const { path: dest, target } of metadata.addedLinks) {
    await removeManagedLink(dest, target, opts.dryRun);
  }

  const userSettings = await readJsonOrEmpty(SETTINGS_PATH);
  const reverted = revertSettings(userSettings, metadata);

  if (opts.dryRun) {
    console.log('→ would revert settings.json to:');
    console.log(JSON.stringify(reverted, null, 2));
    console.log(`→ would delete ${METADATA_PATH}`);
    console.log('\n(dry-run) nothing changed.');
    return;
  }

  if (existsSync(SETTINGS_PATH)) {
    const backupPath = `${SETTINGS_PATH}.backup-${Date.now()}`;
    await fs.copyFile(SETTINGS_PATH, backupPath);
    console.log(`✓ backed up settings.json → ${backupPath}`);
  }
  if (Object.keys(reverted).length === 0) {
    if (existsSync(SETTINGS_PATH)) {
      await fs.unlink(SETTINGS_PATH);
      console.log(`✓ removed empty ${SETTINGS_PATH}`);
    }
  } else {
    const tmpPath = path.join(TARGET_DIR, '.settings.json.tmp');
    await fs.writeFile(tmpPath, `${JSON.stringify(reverted, null, 2)}\n`);
    await fs.rename(tmpPath, SETTINGS_PATH);
    console.log(`✓ reverted ${SETTINGS_PATH}`);
  }

  await fs.unlink(METADATA_PATH);
  console.log(`✓ removed ${METADATA_PATH}`);

  console.log('\nDone.');
}

async function main() {
  if (platform === 'win32') {
    console.error('Windows is not supported by this personal harness — patches welcome.');
    exit(1);
  }
  const opts = parseArgs(argv.slice(2));
  if (opts.mode === 'uninstall') {
    await runUninstall(opts);
  } else {
    await runInstall(opts);
  }
}

main().catch((err) => {
  console.error(`\nInstall failed: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  exit(1);
});
