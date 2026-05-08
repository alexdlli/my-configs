# my-configs

Personal Claude Code harness — orchestrator agent + specialists, installed globally to `~/.claude/` via symlinks.

## What you get

| Agent          | Role                                          |
|----------------|-----------------------------------------------|
| `orchestrator` | Decomposition + parallel delegation (default) |
| `explorer`     | Read-only research and discovery              |
| `planner`      | Implementation strategy (read-only)           |
| `implementer`  | Writes/edits code per a plan                  |
| `reviewer`     | Code review, quality, security                |
| `tester`       | Lint / typecheck / test / build               |
| `pr-author`    | Drafts PRs from the current branch            |
| `pr-reviewer`  | Reviews open GitHub PRs                       |

Plus two hooks that reinforce delegation behavior across prompts and through context compaction.

## Install

```bash
git clone git@github.com:alexdlli/my-configs.git ~/Developer/my-configs
cd ~/Developer/my-configs
node scripts/install.mjs
```

That symlinks `~/.claude/agents` and `~/.claude/hooks` to this checkout, and deep-merges the harness keys (`agent`, `permissions.allow`, `hooks.UserPromptSubmit`, `hooks.PreCompact`) into your `~/.claude/settings.json`. Existing keys (theme, plugins, etc.) are preserved.

Open a new Claude Code session anywhere and run `/agents` — `orchestrator` should be active.

## Update

```bash
cd ~/Developer/my-configs
git pull
node scripts/install.mjs   # idempotent; refreshes symlinks + re-merges settings
```

## Uninstall

```bash
node scripts/install.mjs --uninstall
```

Removes the symlinks and reverts only the keys the installer added to `~/.claude/settings.json` (your other settings stay intact).

## Layout

```
.claude/
├── agents/              # orchestrator + specialists
├── hooks/               # orchestrator reminder + preserve-orchestrator
└── settings.json        # baseline merged into ~/.claude/settings.json
scripts/
└── install.mjs          # installer (symlink + merge + uninstall)
docs/
├── agent-system.md      # full agent reference
└── installation.md      # detailed install + troubleshooting
```

## Why

Claude Code's default behavior is fine for one-off prompts but rough on multi-step work. The orchestrator + specialists pattern enforces parallel decomposition and keeps each agent focused. Installing globally means every Claude Code session in any directory benefits from this.

Inspired by [`bpinheiroms/my-setup`](https://github.com/bpinheiroms/my-setup) — same idea, built on Claude Code's official subagents mechanism.

## Notes

- macOS-only. Windows users: PRs welcome.
- Re-running the installer creates `~/.claude/settings.json.backup-<ts>` snapshots; clean up with `rm ~/.claude/*.backup-*` once you're confident.
