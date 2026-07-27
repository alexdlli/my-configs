#!/usr/bin/env node
// Install (or uninstall) the personal Claude Code harness into ~/.claude/.
//
// Symlinks ~/.claude/{agents,hooks} into the harness checkout, and deep-merges
// a managed slice of ~/.claude/settings.json (agent, permissions.allow, and
// the SessionStart/UserPromptSubmit/PreCompact hooks) without disturbing keys
// the user owns (theme, enabledPlugins, extraKnownMarketplaces, ...).
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
const MANAGED_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreCompact'];
const TARGET_HOOKS_DIR = path.join(TARGET_DIR, 'hooks');

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
                     and SessionStart/UserPromptSubmit/PreCompact hooks. All
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

// Returns { merged, added: { addedKeys, addedAllowEntries, addedHooks } }.
// `merged` is the full settings to write; `added` records only what this run
// introduced (so uninstall can revert exactly that, nothing else).
function buildMergedSettings(userSettings, harnessSettings, opts) {
  const merged = cloneJson(userSettings);
  const added = { addedKeys: [], addedAllowEntries: [], addedHooks: [] };

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

  const harnessAllow = harnessSettings?.permissions?.allow;
  if (Array.isArray(harnessAllow) && harnessAllow.length > 0) {
    if (!isPlainObject(merged.permissions)) merged.permissions = {};
    if (!Array.isArray(merged.permissions.allow)) merged.permissions.allow = [];
    const existing = new Set(merged.permissions.allow);
    for (const entry of harnessAllow) {
      if (!existing.has(entry)) {
        merged.permissions.allow.push(entry);
        existing.add(entry);
        added.addedAllowEntries.push(entry);
      }
    }
  }

  const harnessHooks = harnessSettings?.hooks;
  if (isPlainObject(harnessHooks)) {
    if (!isPlainObject(merged.hooks)) merged.hooks = {};
    for (const event of MANAGED_HOOK_EVENTS) {
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

function mergeMetadata(prior, added) {
  const priorKeys = Array.isArray(prior?.addedKeys) ? prior.addedKeys : [];
  const priorAllow = Array.isArray(prior?.addedAllowEntries) ? prior.addedAllowEntries : [];
  const priorHooks = Array.isArray(prior?.addedHooks) ? prior.addedHooks : [];
  const keySet = new Set([...priorKeys, ...added.addedKeys]);
  const allowSet = new Set([...priorAllow, ...added.addedAllowEntries]);
  const hookSeen = new Set(priorHooks.map(hookSignature));
  const mergedHooks = [...priorHooks];
  for (const h of added.addedHooks) {
    const sig = hookSignature(h);
    if (!hookSeen.has(sig)) {
      hookSeen.add(sig);
      mergedHooks.push(h);
    }
  }
  return {
    version: 1,
    addedKeys: [...keySet],
    addedAllowEntries: [...allowSet],
    addedHooks: mergedHooks,
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

async function planSymlink(name, dryRun) {
  const src = path.join(HARNESS_ROOT, '.claude', name);
  const dest = path.join(TARGET_DIR, name);
  const kind = await pathKind(dest);

  if (kind === 'symlink') {
    let current;
    try {
      current = await fs.readlink(dest);
    } catch {
      current = null;
    }
    if (current === src) {
      console.log(`✓ ${dest} already points to ${src}`);
      return;
    }
    if (dryRun) {
      console.log(`→ would replace symlink ${dest} (currently → ${current}) with → ${src}`);
      return;
    }
    await fs.unlink(dest);
    await fs.symlink(src, dest, 'dir');
    console.log(`✓ replaced symlink ${dest} → ${src}`);
    return;
  }

  if (kind === 'absent') {
    if (dryRun) {
      console.log(`→ would symlink ${dest} → ${src}`);
      return;
    }
    await fs.symlink(src, dest, 'dir');
    console.log(`✓ symlinked ${dest} → ${src}`);
    return;
  }

  const backupPath = `${dest}.backup-${Date.now()}`;
  if (dryRun) {
    console.log(`→ would back up ${dest} (${kind}) → ${backupPath}, then symlink → ${src}`);
    return;
  }
  await fs.rename(dest, backupPath);
  console.log(`! backed up existing ${kind} at ${dest} → ${backupPath}`);
  await fs.symlink(src, dest, 'dir');
  console.log(`✓ symlinked ${dest} → ${src}`);
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

  for (const name of SYMLINK_ITEMS) {
    await planSymlink(name, opts.dryRun);
  }

  const userSettings = await readJsonOrEmpty(SETTINGS_PATH);
  const harnessSettings = await readJsonOrEmpty(
    path.join(HARNESS_ROOT, '.claude', 'settings.json'),
  );
  const { merged, added } = buildMergedSettings(userSettings, harnessSettings, opts);

  const preservedKeys = describePreserved(userSettings, added);
  const summaryParts = [];
  if (preservedKeys.length > 0) summaryParts.push(`preserved ${preservedKeys.join(', ')}`);
  const addedSummary = [];
  if (added.addedKeys.length > 0) addedSummary.push(added.addedKeys.join(', '));
  if (added.addedAllowEntries.length > 0)
    addedSummary.push(`${added.addedAllowEntries.length} permissions.allow entries`);
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

async function removeManagedSymlink(name, dryRun) {
  const expectedSrc = path.join(HARNESS_ROOT, '.claude', name);
  const dest = path.join(TARGET_DIR, name);
  const kind = await pathKind(dest);

  if (kind === 'absent') {
    console.log(`  ${dest} not present`);
    return;
  }
  if (kind !== 'symlink') {
    console.log(`! ${dest} exists but is not a symlink — leaving alone`);
    return;
  }
  let current;
  try {
    current = await fs.readlink(dest);
  } catch {
    current = null;
  }
  if (current !== expectedSrc) {
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

function revertSettings(userSettings, metadata) {
  const reverted = cloneJson(userSettings);
  for (const key of metadata.addedKeys ?? []) {
    delete reverted[key];
  }
  if (Array.isArray(metadata.addedAllowEntries) && metadata.addedAllowEntries.length > 0) {
    if (Array.isArray(reverted?.permissions?.allow)) {
      const drop = new Set(metadata.addedAllowEntries);
      reverted.permissions.allow = reverted.permissions.allow.filter((e) => !drop.has(e));
      if (reverted.permissions.allow.length === 0) delete reverted.permissions.allow;
      if (isPlainObject(reverted.permissions) && Object.keys(reverted.permissions).length === 0) {
        delete reverted.permissions;
      }
    }
  }
  if (Array.isArray(metadata.addedHooks) && metadata.addedHooks.length > 0) {
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

  for (const name of SYMLINK_ITEMS) {
    await removeManagedSymlink(name, opts.dryRun);
  }

  const metadata = await readJsonOrEmpty(METADATA_PATH);
  if (!metadata.version) {
    console.log('  no .my-configs-managed.json metadata — leaving settings.json untouched');
    return;
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
