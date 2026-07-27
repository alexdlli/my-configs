# Contributing

Notes for working on this harness. It's small on purpose — settings, agents, hooks, and an installer. Keep additions targeted and reversible.

## Repo layout

```
.claude/
  settings.json        # baseline merged into ~/.claude/settings.json
  agents/              # one .md per agent
  hooks/               # hook scripts (.mjs)
    lib/               # shared helpers used by more than one hook, with their tests
  commands/            # one .md per slash command; the directory is linked as a whole
  skills/              # one directory per skill (SKILL.md), linked entry by entry
docs/
  agent-system.md      # agents, skills, slash commands
  installation.md      # install, flags, conflicts, troubleshooting
  contributing.md      # this file
  waves.md             # ticket contract, dependency graph, wave plan
  integrations/        # orca.md, maestri.md, ecotokens.md, ai-memory.md
scripts/
  install.mjs          # symlink + merge installer
  docs-inventory.test.mjs  # fails when the docs stop matching the real directories
  waves/               # wave pipeline: tickets-linear, tickets-github, graph, gh, pr-state, fetch-pr-threads
  setup-ai-memory.mjs  # one-shot ai-memory setup
  verify-ai-memory.mjs # read-only end-to-end check of the ai-memory chain
  backup-ai-memory.mjs # volume backup + rotation + LaunchAgent
  claude-openai-shim.mjs  # OpenAI-compat shim over `claude -p`
CLAUDE.md              # session-level guidance Claude reads automatically
```

`.claude/hooks/lib/` holds logic shared by more than one hook — it is the only place in `.claude/hooks/` that is not itself a hook. Claude Code never invokes it directly; hooks import from it. It is also where the hook unit tests live (`*.test.mjs`), since a hook script's own top level runs on import.

`.claude/skills/` and `.claude/commands/` are installed differently, and the difference matters. The commands directory is symlinked whole, so a new command is live on pull. Skills are linked **entry by entry** because `~/.claude/skills` is shared with third-party skills; adding one requires re-running the installer. See [`agent-system.md`](agent-system.md) for the full policy.

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
3. Update the roster table in `CLAUDE.md`, `README.md`, and `docs/agent-system.md` — including the specialist **count** in that file's opening line, and the read-only allowlist paragraph if the new agent has no `Edit`/`Write`. Don't count by hand: `node --test 'scripts/*.test.mjs'` names every doc that still omits the agent, and every count that no longer adds up (see [Docs that list or count things](#docs-that-list-or-count-things)).
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
- Keep the metadata file (`~/.claude/.my-configs-managed.json`) accurate — `--uninstall` reads it to revert precisely what was added, and removes a link only when its `readlink` still matches the recorded target.
- Never symlink `~/.claude/skills` itself; it is shared with plugins and other toolkits. Add skills to `.claude/skills/` (linked per entry automatically) or, for a skill installed elsewhere on disk, to `EXTERNAL_SKILL_LINKS`.
- Bump `METADATA_VERSION` when the metadata shape changes, and teach `normalizeMetadata` how to read the old shape.
- Test with `--dry-run` against a fake `$HOME`:
  ```bash
  HOME=/tmp/fake-home node scripts/install.mjs --dry-run
  ```
- Then a real install in the same fake home and confirm the symlinks + merged settings look right.
- Syntax check: `node --check scripts/install.mjs`.

## Docs that list or count things

Prose that says "five hooks", or a table that claims to list every agent, goes stale in silence: nothing breaks, no error appears, and nobody notices until someone counts. It has already happened four times here. `scripts/docs-inventory.test.mjs` reads the real directories and fails when a doc disagrees. It checks two separate things.

**Every entry must be named in the docs that index it.** The test holds, per inventory, the docs that enumerate it, and asserts each entry name appears there — case-insensitive and delimited, so `pr-reviewer` does not stand in for `reviewer`.

| Inventory | Read from | Docs that must name every entry |
|---|---|---|
| `agents` | `.claude/agents/*.md` | `README.md`, `CLAUDE.md`, `docs/agent-system.md` |
| `skills` | `.claude/skills/*/` | `README.md`, `CLAUDE.md`, `docs/agent-system.md` |
| `commands` | `.claude/commands/*.md` | `README.md`, `CLAUDE.md`, `docs/agent-system.md` |
| `hooks` | `.claude/hooks/*.mjs` | `README.md`, `docs/installation.md` |
| `integrations` | `docs/integrations/*.md` | `README.md`, `docs/contributing.md` |
| `waveScripts` | `scripts/waves/*.mjs` minus `*.test.mjs` | `CLAUDE.md`, `docs/contributing.md` |

Naming the entry is the point; the number is only its symptom. A new agent that nobody documented is the actual defect, and the failure says which file exists and which doc omits it. When a new doc becomes an index for an inventory, add it to that inventory's `indexes` in the test.

**A number in prose must carry a marker.** Where a sentence states a cardinality, pin it with an HTML comment immediately before the number:

```markdown
Plus <!-- docs-count:hooks -->five hooks: two that reinforce delegation ...
```

The test reads the token right after the marker — digits or spelled out, up to twenty — and compares it with the directory. Pinning the position is what keeps this from being a regex guessing at prose: rewrite the sentence and the marker travels with the number, or the test reports that the marker no longer has one after it. Valid keys are the inventory names above plus `specialists` (agents minus `orchestrator`). **Never put the marker at the start of a line** — CommonMark then treats the whole line as raw HTML and stops rendering the markdown on it. The test flags that too.

Three limits, all deliberate:

- A count written **without** a marker is invisible to the test. Add the marker when you write the count; there is no way to find an unmarked one without regex-guessing at prose, which is what makes this class of test untrustworthy.
- Markers inside fenced code blocks are ignored, so an example like the one above is never a live claim.
- `.claude/skills` is exempt from the reverse "this path is not on disk" check. `~/.claude/skills` is shared ground: docs there legitimately point at a skill installed outside this repo (`to-tickets`) or at a planned destination (`maestri-orchestration`). The other five directories are owned by the harness alone, so a path into them that does not resolve is a real broken reference.

## Running the tests

```bash
node --test 'scripts/*.test.mjs'
node --test 'scripts/waves/*.test.mjs'
node --test '.claude/hooks/lib/*.test.mjs'
```

Both forms are validated. Quoting hands the glob to Node's own matcher instead of the shell; unquoted, the shell expands it first. Either works.

**Never pass a directory to `node --test`.** On the Node in use here (24.15.0) it is broken for *any* directory: the positional is resolved by the CJS loader as a module and the runner never starts. The failure is not obvious — instead of erroring out, it reports the directory path itself as a single failing test named `scripts/waves`, with the message `'test failed'` and a plausible duration. So a suite that never ran looks like a suite that ran and failed. This has already cost two people time. Pass a glob or explicit file paths.

Every push to `main` and every pull request runs `.github/workflows/ci.yml` — `node --check` on every `.mjs` in the tree, the three globs above, and one install/uninstall cycle against a throwaway `$HOME`.

## Commit rules

- Never include "Claude Code" or "Claude" as co-author.
- Test before committing — syntax check + a real dry run against a fake `$HOME`.
