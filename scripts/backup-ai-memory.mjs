#!/usr/bin/env node
// Back up the ai-memory Docker volume (markdown wiki + db + config) to the host,
// with rotation, and optionally install a LaunchAgent that runs the backup at
// login/boot plus once a day.
//
// The backup itself is produced *inside* the container (`ai-memory backup`),
// then copied to the host and pruned to the most-recent N archives.
//
// Usage:
//   node scripts/backup-ai-memory.mjs                 # run one backup now
//   node scripts/backup-ai-memory.mjs --dry-run       # print the plan, do nothing
//   node scripts/backup-ai-memory.mjs --install       # install + load LaunchAgent
//   node scripts/backup-ai-memory.mjs --install --dry-run
//   node scripts/backup-ai-memory.mjs --uninstall     # unload + remove LaunchAgent
//   node scripts/backup-ai-memory.mjs -h | --help
//
// Env overrides:
//   AI_MEMORY_CONTAINER   container name           (default: ai-memory)
//   AI_MEMORY_BACKUP_DIR  host backup directory    (default: ~/ai-memory-backups)
//   AI_MEMORY_BACKUP_KEEP archives to retain       (default: 14)
//
// macOS only (LaunchAgent + Docker Desktop). Node 20+, stdlib only.

import { argv, exit, platform, env, execPath } from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);

const HOME = os.homedir();
const CONTAINER = env.AI_MEMORY_CONTAINER || 'ai-memory';
const BACKUP_DIR = env.AI_MEMORY_BACKUP_DIR || path.join(HOME, 'ai-memory-backups');
const DEFAULT_BACKUP_RETENTION = 14;
const BACKUP_RETENTION = resolveRetention(env.AI_MEMORY_BACKUP_KEEP);

const CONTAINER_DATA_DIR = '/data';
const BACKUP_PREFIX = 'ai-memory-';
const BACKUP_EXT = '.tar.gz';
const BACKUP_GLOB = /^ai-memory-\d{8}-\d{6}\.tar\.gz$/;

const HEALTH_TIMEOUT_MS = 10 * 60 * 1000;
const HEALTH_POLL_INTERVAL_MS = 5 * 1000;

const DOCKER_CANDIDATES = ['/opt/homebrew/bin/docker', '/usr/local/bin/docker'];

const LAUNCH_AGENTS_DIR = path.join(HOME, 'Library', 'LaunchAgents');
const AGENT_LABEL = 'com.my-configs.ai-memory-backup';
const AGENT_PLIST = path.join(LAUNCH_AGENTS_DIR, `${AGENT_LABEL}.plist`);
const AGENT_LOG = path.join(BACKUP_DIR, 'backup.log');
const AGENT_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
const DAILY_HOUR = 12;
const DAILY_MINUTE = 0;

function usage() {
  console.log(`Back up the ai-memory Docker volume to the host, with rotation.

Usage:
  node scripts/backup-ai-memory.mjs [options]

Options:
  (no flags)     run one backup now (wait for healthy, dump, copy, rotate)
  --install      write + load the LaunchAgent (login/boot + daily ${DAILY_HOUR}:${String(DAILY_MINUTE).padStart(2, '0')})
  --uninstall    unload + remove the LaunchAgent
  --dry-run      print the plan; no backup, no plist, no deletion
  -h, --help     show this help

Env overrides:
  AI_MEMORY_CONTAINER    (default: ai-memory)
  AI_MEMORY_BACKUP_DIR   (default: ~/ai-memory-backups)
  AI_MEMORY_BACKUP_KEEP  (default: 14)`);
}

function parseArgs(args) {
  const opts = { install: false, uninstall: false, dryRun: false };
  for (const a of args) {
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--install') opts.install = true;
    else if (a === '--uninstall') opts.uninstall = true;
    else if (a === '-h' || a === '--help') {
      usage();
      exit(0);
    } else {
      console.error(`! error: unknown option: ${a}`);
      usage();
      exit(1);
    }
  }
  if (opts.install && opts.uninstall) {
    die('--install and --uninstall are mutually exclusive.');
  }
  return opts;
}

function die(msg) {
  console.error(`! error: ${msg}`);
  exit(1);
}

function resolveRetention(raw) {
  if (raw === undefined || raw === '') return DEFAULT_BACKUP_RETENTION;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    die(`AI_MEMORY_BACKUP_KEEP must be an integer >= 1 (got "${raw}").`);
  }
  return n;
}

function escapeXml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function resolveDocker() {
  for (const candidate of DOCKER_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const r = spawnSync('command', ['-v', 'docker'], { shell: true, encoding: 'utf8' });
  const fromPath = (r.stdout || '').trim();
  if (fromPath) return fromPath;
  die('docker not found (checked Docker Desktop paths and PATH). Install Docker Desktop.');
}

function docker(dockerBin, args, { allowFail = false } = {}) {
  const res = spawnSync(dockerBin, args, { encoding: 'utf8' });
  if (res.error) {
    if (allowFail) return { code: 1, stdout: '', stderr: String(res.error) };
    die(`failed to run \`docker ${args.join(' ')}\`: ${res.error.message}`);
  }
  if (res.status !== 0 && !allowFail) {
    die(`\`docker ${args.join(' ')}\` exited with ${res.status}: ${(res.stderr || '').trim()}`);
  }
  return { code: res.status ?? 0, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function containerHealth(dockerBin) {
  const r = docker(
    dockerBin,
    ['inspect', '-f', '{{.State.Health.Status}}', CONTAINER],
    { allowFail: true },
  );
  if (r.code !== 0) return null;
  return r.stdout.trim();
}

function sleep(ms) {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

function waitForHealthy(dockerBin) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    const status = containerHealth(dockerBin);
    if (status === 'healthy') return;
    if (status !== last) {
      console.log(`… waiting for container "${CONTAINER}" (status: ${status ?? 'absent'})`);
      last = status;
    }
    sleep(HEALTH_POLL_INTERVAL_MS);
  }
  die(`timed out after ${HEALTH_TIMEOUT_MS / 1000}s waiting for "${CONTAINER}" to be healthy.`);
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function rotate(dryRun) {
  if (!fs.existsSync(BACKUP_DIR)) return 0;
  const archives = fs
    .readdirSync(BACKUP_DIR)
    .filter((name) => BACKUP_GLOB.test(name))
    .map((name) => path.join(BACKUP_DIR, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const stale = archives.slice(BACKUP_RETENTION);
  let removed = 0;
  for (const full of stale) {
    if (dryRun) {
      console.log(`  would remove (rotation): ${full}`);
      removed += 1;
    } else if (fs.lstatSync(full).isFile()) {
      fs.unlinkSync(full);
      removed += 1;
    }
  }
  return removed;
}

function runBackup(opts) {
  const dockerBin = resolveDocker();
  const stamp = timestamp();
  const fileName = `${BACKUP_PREFIX}${stamp}${BACKUP_EXT}`;
  const containerPath = `${CONTAINER_DATA_DIR}/${BACKUP_PREFIX}${stamp}.tmp${BACKUP_EXT}`;
  const hostPath = path.join(BACKUP_DIR, fileName);

  if (opts.dryRun) {
    console.log(`(dry-run) backup plan for container "${CONTAINER}":`);
    console.log(`  wait until "${CONTAINER}" is healthy (timeout ${HEALTH_TIMEOUT_MS / 1000}s)`);
    console.log(`  $ ${dockerBin} exec ${CONTAINER} ai-memory backup --to ${containerPath}`);
    console.log(`  $ ${dockerBin} cp ${CONTAINER}:${containerPath} ${hostPath}`);
    console.log(`  $ ${dockerBin} exec ${CONTAINER} rm -f ${containerPath}  (always, even if cp fails)`);
    console.log(`  rotate: keep newest ${BACKUP_RETENTION} matching ${BACKUP_PREFIX}*${BACKUP_EXT} in ${BACKUP_DIR}`);
    rotate(true);
    return;
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  waitForHealthy(dockerBin);

  docker(dockerBin, ['exec', CONTAINER, 'ai-memory', 'backup', '--to', containerPath]);
  try {
    docker(dockerBin, ['cp', `${CONTAINER}:${containerPath}`, hostPath]);
  } finally {
    const rm = docker(dockerBin, ['exec', CONTAINER, 'rm', '-f', containerPath], { allowFail: true });
    if (rm.code !== 0) {
      console.warn(
        `! warning: failed to remove temp backup ${containerPath} inside "${CONTAINER}": ${rm.stderr.trim()}`,
      );
    }
  }

  const sizeMb = (fs.statSync(hostPath).size / (1024 * 1024)).toFixed(1);
  const rotated = rotate(false);
  console.log(`✓ backup: ${hostPath} (${sizeMb} MB)`);
  console.log(`✓ rotation: kept newest ${BACKUP_RETENTION}, removed ${rotated}`);
}

function plistXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escapeXml(AGENT_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(execPath)}</string>
    <string>${escapeXml(__filename)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${escapeXml(AGENT_PATH)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>${DAILY_HOUR}</integer>
    <key>Minute</key><integer>${DAILY_MINUTE}</integer>
  </dict>
  <key>StandardOutPath</key><string>${escapeXml(AGENT_LOG)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(AGENT_LOG)}</string>
</dict>
</plist>
`;
}

function launchctl(args, { dryRun, allowFail = false }) {
  const printable = `launchctl ${args.join(' ')}`;
  if (dryRun) {
    console.log(`  $ ${printable}`);
    return;
  }
  const res = spawnSync('launchctl', args, { stdio: 'inherit' });
  if (res.status !== 0 && !allowFail) {
    die(`\`${printable}\` exited with ${res.status}`);
  }
}

function install(opts) {
  const xml = plistXml();
  if (opts.dryRun) {
    console.log(`(dry-run) would write ${AGENT_PLIST}:`);
    console.log(xml);
    launchctl(['unload', AGENT_PLIST], { dryRun: true });
    launchctl(['load', '-w', AGENT_PLIST], { dryRun: true });
    return;
  }
  fs.mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.writeFileSync(AGENT_PLIST, xml);
  console.log(`✓ wrote ${AGENT_PLIST}`);
  launchctl(['unload', AGENT_PLIST], { dryRun: false, allowFail: true });
  launchctl(['load', '-w', AGENT_PLIST], { dryRun: false });
  console.log(`✓ loaded ${AGENT_LABEL} (RunAtLoad + daily ${DAILY_HOUR}:${String(DAILY_MINUTE).padStart(2, '0')})`);
  console.log(`  log: ${AGENT_LOG}`);
}

function uninstall(opts) {
  if (opts.dryRun) {
    console.log('(dry-run) uninstall plan:');
    launchctl(['unload', AGENT_PLIST], { dryRun: true });
    console.log(`  would remove ${AGENT_PLIST}`);
    return;
  }
  launchctl(['unload', AGENT_PLIST], { dryRun: false, allowFail: true });
  if (fs.existsSync(AGENT_PLIST)) {
    fs.unlinkSync(AGENT_PLIST);
    console.log(`✓ removed ${AGENT_PLIST}`);
  } else {
    console.log(`✓ already absent: ${AGENT_PLIST}`);
  }
}

function main() {
  if (platform !== 'darwin') {
    die('macOS only (LaunchAgent + Docker Desktop).');
  }
  const opts = parseArgs(argv.slice(2));

  if (opts.uninstall) {
    uninstall(opts);
    return;
  }
  if (opts.install) {
    install(opts);
    return;
  }
  runBackup(opts);
}

main();
