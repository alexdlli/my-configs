# Installation

## Quick start

```bash
git clone git@github.com:alexdlli/my-configs.git ~/Developer/my-configs
cd ~/Developer/my-configs
node scripts/install.mjs
```

## What the installer does

When you run `node scripts/install.mjs`, it:

1. Creates two symlinks:
   - `~/.claude/agents` → `<repo>/.claude/agents`
   - `~/.claude/hooks`  → `<repo>/.claude/hooks`
2. Deep-merges harness keys into `~/.claude/settings.json`:
   - `agent` (set to `"orchestrator"`)
   - `permissions.allow` (union with whatever's already there)
   - `hooks.UserPromptSubmit` and `hooks.PreCompact` (appended; hook commands rewritten to absolute paths so they fire regardless of session cwd)
3. Records what it added in `~/.claude/.my-configs-managed.json` so `--uninstall` can revert precisely.

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

**`~/.claude/agents` or `~/.claude/hooks` already exists as a real directory.**
The installer backs it up to `~/.claude/<name>.backup-<timestamp>` and proceeds. The message in the output points to the backup location.

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

## Uninstall

```bash
node scripts/install.mjs --uninstall
```

Removes the two symlinks. Reads `~/.claude/.my-configs-managed.json` and reverts ONLY the keys/permissions/hooks that the installer added — your `theme`, plugins, and unrelated permissions stay intact. Deletes the metadata file at the end.

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
