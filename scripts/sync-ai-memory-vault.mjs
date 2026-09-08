#!/usr/bin/env node
// sync-ai-memory-vault.mjs — one-way mirror of the ai-memory wiki into a
// navigable Obsidian vault, with human project names instead of UUID paths.
//
// The wiki inside the ai-memory data volume is the source of truth and is
// written by the server; this mirror is for READING in Obsidian, iCloud and
// other tools. Edits made in the vault are overwritten by the next sync —
// durable notes go in through the agent (memory_write_page) or the CLI.
//
// The vault defaults to Obsidian's own iCloud container, the only location
// Obsidian on iOS can open. Only entries this script created (tracked in
// .ai-memory-mirror.json) are ever deleted from the vault, so user files and
// the .obsidian config directory survive every sync.
//
// Usage:
//   node scripts/sync-ai-memory-vault.mjs             # sync once now
//   node scripts/sync-ai-memory-vault.mjs --dry-run   # print the plan only
//   node scripts/sync-ai-memory-vault.mjs --install   # + LaunchAgent (login/boot + hourly)
//   node scripts/sync-ai-memory-vault.mjs --uninstall # remove the LaunchAgent
//
// Env: AI_MEMORY_CONTAINER (default ai-memory), AI_MEMORY_VAULT_DIR.
// macOS only (LaunchAgent, iCloud path). Node.js 24+, zero dependencies.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const HOME = os.homedir();

const CONTAINER = process.env.AI_MEMORY_CONTAINER || 'ai-memory';
const VAULT_DIR =
  process.env.AI_MEMORY_VAULT_DIR ||
  path.join(HOME, 'Library', 'Mobile Documents', 'iCloud~md~obsidian', 'Documents', 'AI Memory');
const MANIFEST = '.ai-memory-mirror.json';

const LABEL = 'com.my-configs.ai-memory-vault-sync';
const PLIST = path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG_DIR = path.join(HOME, '.local', 'share', 'ai-memory');
const SYNC_INTERVAL_SECONDS = 3600;

function die(msg) {
  console.error(`! error: ${msg}`);
  process.exit(1);
}

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { ok: r.status === 0, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

// First value of `key:` in the page's YAML frontmatter, or null. The wiki's
// _meta.md files are small and flat; a YAML parser would be a dependency.
export function metaValue(text, key) {
  const m = String(text).match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') || null : null;
}

// A wiki project name becomes a vault directory name: no path separators or
// control characters, no leading dot (Obsidian hides dotfiles).
export function sanitizeName(raw) {
  const cleaned = String(raw ?? '')
    .replace(/[\/\\:]|[\0-\x1f]/g, "-")
    .trim()
    .replace(/^\.+/, '');
  return cleaned || null;
}

// Unique vault directory per project. Two checkouts can carry the same
// basename, so a collision keeps both apart with a UUID prefix instead of
// silently merging their pages.
export function assignVaultNames(projects) {
  const taken = new Map(); // name -> uuid that claimed it first
  const result = new Map(); // uuid -> vault dir name
  for (const { uuid, name } of projects) {
    const base = sanitizeName(name) || uuid;
    const finalName = taken.has(base) ? `${base} (${uuid.slice(0, 8)})` : base;
    taken.set(base, uuid);
    result.set(uuid, finalName);
  }
  return result;
}

function readMeta(dir, key) {
  try {
    return metaValue(fs.readFileSync(path.join(dir, '_meta.md'), 'utf8'), key);
  } catch {
    return null;
  }
}

function copyWikiOut(tmp) {
  const running = sh('docker', ['inspect', '-f', '{{.State.Running}}', CONTAINER]);
  if (!running.ok || running.stdout !== 'true') {
    die(`container "${CONTAINER}" is not running — the wiki lives in its data volume`);
  }
  const cp = sh('docker', ['cp', `${CONTAINER}:/data/wiki`, tmp]);
  if (!cp.ok) die(`docker cp failed: ${cp.stderr}`);
  const wiki = path.join(tmp, 'wiki');
  // The wiki is one git repo at its root; history stays out of the vault.
  fs.rmSync(path.join(wiki, '.git'), { recursive: true, force: true });
  return wiki;
}

// stage/<project>/... for every project in every workspace. A single
// workspace (the common case) is flattened away; more than one keeps a
// workspace level so same-named projects in different workspaces cannot merge.
function stageVault(wiki, stage) {
  const workspaces = fs
    .readdirSync(wiki, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const flatten = workspaces.length === 1;
  const entries = [];
  for (const ws of workspaces) {
    const wsDir = path.join(wiki, ws);
    const wsName = flatten ? null : sanitizeName(readMeta(wsDir, 'workspace')) || ws;
    const projects = fs
      .readdirSync(wsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ uuid: e.name, name: readMeta(path.join(wsDir, e.name), 'project') }));
    const names = assignVaultNames(projects);
    for (const { uuid } of projects) {
      const target = wsName ? path.join(wsName, names.get(uuid)) : names.get(uuid);
      fs.cpSync(path.join(wsDir, uuid), path.join(stage, target), { recursive: true });
      entries.push(wsName ?? names.get(uuid));
    }
  }
  return [...new Set(entries)].sort();
}

function readManifest() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(VAULT_DIR, MANIFEST), 'utf8'));
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

// Replace only what the previous sync created. Anything else in the vault —
// .obsidian, user notes, plugins — is never touched, which is what makes a
// one-way mirror safe to point at a real vault.
function swapIntoVault(stage, entries) {
  fs.mkdirSync(VAULT_DIR, { recursive: true });
  for (const old of readManifest()) {
    fs.rmSync(path.join(VAULT_DIR, old), { recursive: true, force: true });
  }
  for (const entry of fs.readdirSync(stage)) {
    fs.cpSync(path.join(stage, entry), path.join(VAULT_DIR, entry), { recursive: true });
  }
  fs.writeFileSync(
    path.join(VAULT_DIR, MANIFEST),
    JSON.stringify({ entries, synced_at: new Date().toISOString() }, null, 2),
  );
  fs.writeFileSync(
    path.join(VAULT_DIR, 'README.md'),
    `# AI Memory (read-only mirror)\n\n` +
      `Mirrored from the ai-memory wiki by \`scripts/sync-ai-memory-vault.mjs\` ` +
      `(my-configs). Edits here are OVERWRITTEN by the next sync — write durable ` +
      `notes through the agent (\`memory_write_page\`) or \`ai-memory\` instead.\n\n` +
      `Last sync: ${new Date().toISOString()}\n`,
  );
}

function installAgent() {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${__filename}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AI_MEMORY_CONTAINER</key><string>${CONTAINER}</string>
    <key>AI_MEMORY_VAULT_DIR</key><string>${VAULT_DIR}</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>${SYNC_INTERVAL_SECONDS}</integer>
  <key>StandardOutPath</key><string>${path.join(LOG_DIR, 'vault-sync.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(LOG_DIR, 'vault-sync.log')}</string>
</dict>
</plist>
`;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.writeFileSync(PLIST, plist);
  sh('launchctl', ['unload', PLIST]);
  const load = sh('launchctl', ['load', '-w', PLIST]);
  if (!load.ok) die(`launchctl load failed: ${load.stderr}`);
  console.log(`✓ LaunchAgent ${LABEL}: sync at login/boot and every ${SYNC_INTERVAL_SECONDS / 60} min`);
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  if (args.includes('--uninstall')) {
    sh('launchctl', ['unload', PLIST]);
    fs.rmSync(PLIST, { force: true });
    console.log(`✓ removed ${LABEL}`);
    return;
  }

  if (dryRun) {
    console.log(`(dry-run) would mirror ${CONTAINER}:/data/wiki → ${VAULT_DIR}`);
    console.log(`(dry-run) currently managed entries: ${readManifest().join(', ') || '(none)'}`);
    if (args.includes('--install')) console.log(`(dry-run) would install LaunchAgent ${LABEL}`);
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-memory-vault-'));
  try {
    const wiki = copyWikiOut(tmp);
    const stage = path.join(tmp, 'stage');
    fs.mkdirSync(stage);
    const entries = stageVault(wiki, stage);
    swapIntoVault(stage, entries);
    console.log(`✓ vault: ${VAULT_DIR} (${entries.length} top-level entr${entries.length === 1 ? 'y' : 'ies'})`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (args.includes('--install')) installAgent();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
