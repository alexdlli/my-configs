# my-configs

Personal Claude Code harness — orchestrator agent + specialists, installed globally to `~/.claude/` via symlinks.

## What you get

| Agent          | Role                                          |
|----------------|-----------------------------------------------|
| `orchestrator` | Decomposition + parallel delegation (default) |
| `explorer`     | Read-only research and discovery              |
| `planner`      | Implementation strategy (read-only)           |
| `pm`           | Spec/discussion into contract-compliant tickets (read-only on code) |
| `implementer`  | Writes/edits code per a plan                  |
| `reviewer`     | Code review, quality, security                |
| `tester`       | Lint / typecheck / test / build               |
| `pr-author`    | Drafts PRs from the current branch            |
| `pr-reviewer`  | Reviews open GitHub PRs                       |
| `pr-triage`    | Classifies PR feedback threads; never applies, never posts |
| `cavecrew-investigator` | Fast read-only locator (haiku, terse output) |
| `cavecrew-builder`      | Surgical 1-2 file edit                        |
| `cavecrew-reviewer`     | Single-line review findings (haiku)           |
| `atlassian`    | Confluence / Jira via the Atlassian Rovo MCP  |

Plus four hooks: two that reinforce delegation behavior across prompts and through context compaction, one that keeps the harness checkout up to date at session start, and one that reports the terminal host and account context.

## Install

```bash
git clone git@github.com:alexdlli/my-configs.git ~/Developer/my-configs
cd ~/Developer/my-configs
node scripts/install.mjs
```

That symlinks `~/.claude/{harness,agents,hooks,commands}` to this checkout, links each `.claude/skills` entry individually into the shared `~/.claude/skills` (third-party skills are never displaced), and deep-merges the harness keys (`agent`, `permissions.allow`, `permissions.deny`, and every hook event declared in `.claude/settings.json`) into your `~/.claude/settings.json`. Existing keys (theme, plugins, etc.) are preserved.

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

Removes only the links this installer created (matched by recorded target) and reverts only the keys it added to `~/.claude/settings.json`. Your other settings and any third-party skills stay intact.

## Layout

```
.claude/
├── agents/              # orchestrator + specialists
├── hooks/               # orchestrator reminder + preserve-orchestrator + auto-update
├── commands/            # slash commands (/sync-harness)
├── skills/              # skills, linked one by one into ~/.claude/skills
└── settings.json        # baseline merged into ~/.claude/settings.json
scripts/
├── install.mjs          # installer (symlink + merge + uninstall)
├── setup-ai-memory.mjs  # one-shot ai-memory (long-term memory) setup
├── verify-ai-memory.mjs # read-only end-to-end check of the ai-memory chain
├── backup-ai-memory.mjs # ai-memory volume backup, rotation + daily LaunchAgent
└── claude-openai-shim.mjs  # OpenAI-compat shim over `claude -p` (subscription)
docs/
├── agent-system.md      # full agent reference
└── installation.md      # detailed install + troubleshooting
```

## Why

Claude Code's default behavior is fine for one-off prompts but rough on multi-step work. The orchestrator + specialists pattern enforces parallel decomposition and keeps each agent focused. Installing globally means every Claude Code session in any directory benefits from this.

## Credits

- Inspired by [`bpinheiroms/my-setup`](https://github.com/bpinheiroms/my-setup) — same idea, built on Claude Code's official subagents mechanism.
- `cavecrew-*` subagents adapted from [`juliusbrussee/caveman`](https://github.com/JuliusBrussee/caveman) (MIT).

## Notes

- macOS-only. Windows users: PRs welcome.
- Re-running the installer creates `~/.claude/settings.json.backup-<ts>` snapshots; clean up with `rm ~/.claude/*.backup-*` once you're confident.
- EcoTokens (optional Rust output filter): see [`docs/integrations/ecotokens.md`](docs/integrations/ecotokens.md).
- ai-memory (long-term cross-agent memory wiki + Hermes auto-improve): `node scripts/setup-ai-memory.mjs` — default `claude-sub` provider uses your Claude subscription via a local `claude -p` shim. See [`docs/integrations/ai-memory.md`](docs/integrations/ai-memory.md).
