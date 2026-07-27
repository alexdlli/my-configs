# Installation

## Quick start

```bash
git clone git@github.com:alexdlli/my-configs.git ~/Developer/my-configs
cd ~/Developer/my-configs
node scripts/install.mjs
```

## What the installer does

When you run `node scripts/install.mjs`, it:

1. Creates symlinks:
   - `~/.claude/harness`  → `<repo>` (stable path to the checkout, so skills and hooks reach `scripts/**` without hardcoding a clone location)
   - `~/.claude/agents`   → `<repo>/.claude/agents`
   - `~/.claude/hooks`    → `<repo>/.claude/hooks`
   - `~/.claude/commands` → `<repo>/.claude/commands`
   - `~/.claude/skills/<name>` → one link **per entry**, never the directory itself (see below)
2. Deep-merges harness keys into `~/.claude/settings.json`:
   - `agent` (set to `"orchestrator"`)
   - `permissions.allow` (union with whatever's already there)
   - `permissions.deny` (union; blocks `gh pr merge`, `git push --force` and `git commit --no-verify` so merges and history rewrites stay a human decision)
   - every hook event declared in the harness `.claude/settings.json` (appended; hook commands rewritten to absolute paths so they fire regardless of session cwd)
3. Records what it added in `~/.claude/.my-configs-managed.json` so `--uninstall` can revert precisely.

### Why skills are linked one by one

`~/.claude/skills` is shared ground — plugins and other toolkits (argent, maestri, ...) install their skills there too. Symlinking the whole directory to the harness would hide every one of them, so the installer links each entry of `<repo>/.claude/skills` individually. The same mechanism exposes skills that live outside the harness (currently `orca-cli`, from `~/.agents/skills/orca-cli`); if the source is missing the installer says so and moves on.

A name that already exists in `~/.claude/skills` and is not one of our links is **reported and skipped** — never overwritten, never backed up.

Other keys in your `~/.claude/settings.json` (`theme`, `enabledPlugins`, `extraKnownMarketplaces`, anything custom) are left untouched.

## Flags

| Flag | Purpose |
|------|---------|
| (none) | Install or refresh (idempotent) |
| `--dry-run` | Print the plan without writing anything |
| `--uninstall` | Remove symlinks and revert merged keys |
| `--force-agent` | Override conflict if `~/.claude/settings.json` already has a different `agent` |
| `-h`, `--help` | Usage |

## Conflicts

**`~/.claude/agents`, `~/.claude/hooks`, `~/.claude/commands` or `~/.claude/harness` already exists as a real directory.**
The installer backs it up to `~/.claude/<name>.backup-<timestamp>` and proceeds. The message in the output points to the backup location. This does **not** apply to `~/.claude/skills` entries, which are only ever skipped.

**`~/.claude/settings.json` already has `agent` set to something other than `orchestrator`.**
The installer aborts with a clear message. Re-run with `--force-agent` to overwrite, or remove the field manually.

**Settings backups accumulate** (`~/.claude/settings.json.backup-<ts>`). Clean them with `rm ~/.claude/*.backup-*` once you're confident the install is stable.

## Update

```bash
cd ~/Developer/my-configs
git pull
node scripts/install.mjs
```

The installer is idempotent: running again refreshes the symlinks (no-op if already correct), re-runs the merge, and updates the metadata file.

### Automatic update on session start

`.claude/hooks/auto-update.mjs` runs as a `SessionStart` hook and keeps the checkout fresh for you. It is deliberately conservative:

- At most one check every 6 hours (cache file under `~/Library/Caches/claude-setup/last-check`, plus a PID lock next to it). A lock left behind by a killed session is detected via its PID and broken, so auto-update can't get stuck off.
- Only when the harness is on `main` with a clean working tree; it uses `git pull --ff-only`.
- Git runs non-interactively (`GIT_TERMINAL_PROMPT=0`, `ssh -oBatchMode=yes`), so a missing credential fails fast instead of hanging the session.
- Every failure path exits 0 — the hook never blocks a session.
- It never runs the installer. When the pulled diff touches `.claude/skills/` or `.claude/settings.json`, it prints a one-line reminder to run `node scripts/install.mjs` yourself.

Force a check now (bypasses only the 6h throttle): `/sync-harness`, or `node ~/.claude/hooks/auto-update.mjs --force`.

Opt out per-machine: `export CLAUDE_SETUP_SKIP_AUTOUPDATE=1`. It also self-skips when `CI` is set.

## Uninstall

```bash
node scripts/install.mjs --uninstall
```

Reads `~/.claude/.my-configs-managed.json` and reverts ONLY what the installer added — your `theme`, plugins, and unrelated permissions stay intact. Deletes the metadata file at the end.

Every link the installer created is recorded in the metadata as a `{path, target}` pair, and a link is removed only when its current `readlink` matches the recorded target exactly. A third-party entry that happens to share a name is left where it is. With no metadata file there is nothing to revert, and the uninstaller touches nothing.

Metadata written before this scheme (`version: 1`) has no link records; uninstalling one of those removes the only two links that version ever created (`agents` and `hooks`).

## Optional: ai-memory (long-term memory)

Separate from the agent harness, [ai-memory](https://github.com/akitaonrails/ai-memory) gives every coding agent a shared, git-versioned markdown wiki so context survives across sessions and across agents. The default `claude-sub` provider routes ai-memory's LLM work through a local `claude -p` shim so it uses your Claude subscription (sanctioned CLI path). Prerequisites: Docker Desktop, the `claude` CLI logged into your subscription, and no `ANTHROPIC_API_KEY` exported.

```bash
node scripts/setup-ai-memory.mjs --dry-run    # preview
node scripts/setup-ai-memory.mjs              # claude-sub (default)
# or: --provider anthropic | local | none
```

Full walkthrough, provider table, the in-flux subscription-policy caveat, and multi-machine sync: [`integrations/ai-memory.md`](integrations/ai-memory.md).

## Platform support

macOS only. Windows is not supported (`process.platform === 'win32'` exits with a friendly message). PRs welcome.

## Troubleshooting

**Hooks don't fire.** Check `cat ~/.claude/settings.json | jq '.hooks'`. The `command` strings should be absolute paths starting with `node /Users/<you>/.claude/hooks/`. If they're relative, re-run the installer.

**`/agents` doesn't show orchestrator.** Confirm `~/.claude/agents` is a symlink (`readlink ~/.claude/agents` should print the repo path) and that `~/.claude/settings.json` has `"agent": "orchestrator"`.

**Want a clean slate.** `--uninstall`, then delete any leftover `~/.claude/*.backup-*` files, then re-install.
