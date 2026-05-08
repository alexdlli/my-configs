# Contributing

Notes for working on this harness. It's small on purpose — settings, agents, hooks, and an installer. Keep additions targeted and reversible.

## Repo layout

```
.claude/
  settings.json        # baseline merged into ~/.claude/settings.json
  agents/              # one .md per agent
  hooks/               # hook scripts (.mjs)
docs/                  # this file + agent-system.md + installation.md
scripts/install.mjs    # symlink + merge installer
CLAUDE.md              # session-level guidance Claude reads automatically
```

## Adding a new specialist subagent

1. Create `.claude/agents/<name>.md` with YAML frontmatter:

   ```markdown
   ---
   name: <name>
   description: <one-sentence routing hint — Claude reads this to decide when to spawn>
   tools: <comma-separated allowlist; omit to inherit all>
   model: inherit
   ---

   <system prompt body — focused, terse, no marketing>
   ```

2. Update `orchestrator.md`'s "Roster" section so the orchestrator knows it can delegate to the new agent.
3. Update the roster table in `CLAUDE.md`, `README.md`, and `docs/agent-system.md`.
4. Re-run `node scripts/install.mjs` (no-op for symlinks, but confirms nothing broke), then open a session, run `/agents`, confirm the new agent appears and routes for an example task.

Guidelines:

- **Description drives routing.** Vague descriptions = bad delegation. Use phrases like "use proactively" or "use immediately after X" if you want Claude to pick this agent assertively.
- **Tools allowlist enforces read-only.** Don't rely on `permissionMode` — `tools:` is what guarantees an agent can't write regardless of session mode.
- **Single responsibility.** If an agent's description grows past one sentence with multiple "or"s, split it.

## Editing existing agents

Treat the system prompts as code. Small focused changes; verify with a real session before committing.

When changing `orchestrator.md`, test the parallel-delegation pattern with a composite task and confirm subagents are spawned in the same response (real concurrency).

## Adding hooks

Hooks live in two places:

- **`.claude/settings.json`** — registers the hook event and matcher. The installer rewrites the `command` to an absolute path under `~/.claude/hooks/` so it fires regardless of session cwd.
- **`.claude/hooks/<name>.mjs`** — the actual script.

Default to Node.js (`.mjs`) — Node ≥24 is assumed. Avoid extra dependencies; the installer doesn't run `npm install`.

Test before committing:

- `node --check .claude/hooks/<name>.mjs`
- Run the hook directly with a fake stdin payload to confirm it behaves.

Don't add a hook just because you can. Add one when there's a real recurring pain.

## Updating the installer

`scripts/install.mjs` is intentionally small (Node.js stdlib only — no deps). When changing it:

- Maintain the flags: default install, `--dry-run`, `--uninstall`, `--force-agent`, `--help`.
- Keep the deep-merge behavior for `settings.json` — never clobber unrelated keys (`theme`, `enabledPlugins`, etc.).
- Keep the metadata file (`~/.claude/.my-configs-managed.json`) accurate — `--uninstall` reads it to revert precisely what was added.
- Test with `--dry-run` against a fake `$HOME`:
  ```bash
  HOME=/tmp/fake-home node scripts/install.mjs --dry-run
  ```
- Then a real install in the same fake home and confirm the symlinks + merged settings look right.
- Syntax check: `node --check scripts/install.mjs`.

## Commit rules

- Never include "Claude Code" or "Claude" as co-author.
- Test before committing — syntax check + a real dry run against a fake `$HOME`.
