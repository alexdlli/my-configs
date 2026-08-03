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
| `qa`           | Runs the change and produces the proof artifact (screenshot, test, command output) |
| `pr-author`    | Drafts PRs from the current branch            |
| `pr-reviewer`  | Reviews open GitHub PRs                       |
| `pr-triage`    | Classifies PR feedback threads; never applies, never posts |
| `wave-monitor` | Wave branch state in one compact table (haiku); never fixes, never merges |
| `cavecrew-investigator` | Fast read-only locator (haiku, terse output) |
| `cavecrew-builder`      | Surgical 1-2 file edit                        |
| `cavecrew-reviewer`     | Single-line review findings (haiku)           |
| `atlassian`    | Confluence / Jira via the Atlassian Rovo MCP  |

Plus <!-- docs-count:hooks -->five hooks: two that reinforce delegation behavior across prompts and through context compaction, one that keeps the harness checkout up to date at session start, one that reports the terminal host and account context, and one `PreToolUse` guard that blocks `gh pr merge`, `git push --force` and `git commit --no-verify` — including the `bash -c "..."` form the `permissions.deny` list can't see, and including under `--dangerously-skip-permissions`. See [`docs/guard-destructive.md`](docs/guard-destructive.md).

The harness ships <!-- docs-count:skills -->five skills — `ticket-contract`, `adversarial-review`, `wave-orchestration`, `pr-babysitting`, `maestri-orchestration` — and the <!-- docs-count:commands -->six slash commands that drive them: `/sync-harness`, `/ticket-new`, `/review-adversarial`, `/wave-plan`, `/wave-status`, `/pr-babysit`. See [`docs/agent-system.md`](docs/agent-system.md) for what each one owns.

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
├── hooks/               # orchestrator-reminder, preserve-orchestrator, auto-update,
│                        # session-context, guard-destructive
│   └── lib/             # shared hook helpers (+ their tests)
├── commands/            # /sync-harness /ticket-new /review-adversarial /wave-plan
│                        # /wave-status /pr-babysit
├── skills/              # ticket-contract, adversarial-review, wave-orchestration,
│                        # pr-babysitting, maestri-orchestration — linked one by one
└── settings.json        # baseline merged into ~/.claude/settings.json
scripts/
├── install.mjs          # installer (symlink + merge + uninstall)
├── waves/               # ticket graph + wave plan + shared gh access +
│                        # PR state/threads readers (+ tests)
├── setup-ai-memory.mjs  # one-shot ai-memory (long-term memory) setup
├── verify-ai-memory.mjs # read-only end-to-end check of the ai-memory chain
├── backup-ai-memory.mjs # ai-memory volume backup, rotation + daily LaunchAgent
└── claude-openai-shim.mjs  # OpenAI-compat shim over `claude -p` (subscription)
docs/
├── agent-system.md      # full agent, skill and command reference
├── installation.md      # detailed install + troubleshooting
├── usage.md             # driving the harness day to day
├── contributing.md      # conventions for working on this harness
├── waves.md             # ticket contract, dependency graph, wave plan
├── guard-destructive.md # the PreToolUse guard: the three permission layers,
│                        # what it blocks and what it deliberately doesn't
└── integrations/        # session-context, maestri, ecotokens, ai-memory
```

## Why

Claude Code's default behavior is fine for one-off prompts but rough on multi-step work. The orchestrator + specialists pattern enforces parallel decomposition and keeps each agent focused. Installing globally means every Claude Code session in any directory benefits from this.

## Credits

- Inspired by [`bpinheiroms/my-setup`](https://github.com/bpinheiroms/my-setup) — same idea, built on Claude Code's official subagents mechanism.
- `cavecrew-*` subagents adapted from [`juliusbrussee/caveman`](https://github.com/JuliusBrussee/caveman) (MIT).

## Integrations

| Integration | What it gives you | Doc |
|-------------|-------------------|-----|
| Session context | Terminal-host, account and tracker detection at session start, by environment variable — no process spawned | [`docs/integrations/session-context.md`](docs/integrations/session-context.md) |
| Maestri persona | Canonical copy of the Tech Lead / Maestro orchestration persona, its three measured defects, and the map of where each of its rules ended up now that it is ported to the `maestri-orchestration` skill | [`docs/integrations/maestri.md`](docs/integrations/maestri.md) |
| EcoTokens | Optional Rust output filter | [`docs/integrations/ecotokens.md`](docs/integrations/ecotokens.md) |
| ai-memory | Long-term cross-agent memory wiki + Hermes auto-improve. `node scripts/setup-ai-memory.mjs`; the default `claude-sub` provider uses your Claude subscription through a local `claude -p` shim | [`docs/integrations/ai-memory.md`](docs/integrations/ai-memory.md) |

All <!-- docs-count:integrations -->four are optional and independent of the agent harness.

## Notes

- macOS-only. Windows users: PRs welcome.
- Re-running the installer creates `~/.claude/settings.json.backup-<ts>` snapshots; clean up with `rm ~/.claude/*.backup-*` once you're confident.
