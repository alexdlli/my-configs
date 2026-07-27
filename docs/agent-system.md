# Agent System

This harness ships an orchestrator + <!-- docs-count:specialists -->14 specialist subagents, all defined under `.claude/agents/`. Every session that loads this harness starts in the `orchestrator` agent (set via `.claude/settings.json`'s `agent` field).

## Roster

| Agent          | Role                                          | Tools                                              | Model   | my-setup persona |
|----------------|-----------------------------------------------|----------------------------------------------------|---------|------------------|
| `orchestrator` | Decomposes tasks, delegates in parallel, synthesizes | inherit (all)                              | inherit | sisyphus         |
| `explorer`     | Read-only research, code search, doc reading  | Read, Grep, Glob, WebFetch, WebSearch, Bash        | inherit | librarian        |
| `planner`      | Designs strategy, returns step-by-step plans  | Read, Grep, Glob, WebFetch, Bash                   | inherit | prometheus       |
| `pm`           | Turns a spec or discussion into contract-compliant tickets + a `blockedBy` graph | Read, Grep, Glob, Bash, WebFetch | inherit | —                |
| `implementer`  | Writes/edits code per a plan                  | Read, Edit, Write, Grep, Glob, Bash, NotebookEdit  | inherit | hephaestus       |
| `reviewer`     | Reviews local diffs for quality and security  | Read, Grep, Glob, Bash                             | inherit | oracle           |
| `pr-reviewer`  | Reviews an open GitHub PR via `gh` (dry-run default) | Read, Grep, Glob, Bash                       | inherit | —                |
| `pr-author`    | Drafts PR title/body; opens PR on confirmation | Read, Grep, Glob, Bash                            | inherit | —                |
| `pr-triage`    | Classifies a PR's open feedback threads from `threads.json`; recommends, never applies | Read, Grep, Glob             | inherit | —                |
| `wave-monitor` | Reports the state of a wave's branches as one compact table; never fixes, never merges | Read, Bash                  | haiku   | —                |
| `tester`       | Runs lint/typecheck/test/build                | Read, Edit, Grep, Glob, Bash                       | inherit | atlas            |
| `cavecrew-investigator` | Fast read-only code locator (terse caveman output) | Read, Grep, Glob, Bash                | haiku   | — (caveman)      |
| `cavecrew-builder`      | Surgical 1-2 file edit; refuses 3+ file scope     | Read, Edit, Write, Grep, Glob          | inherit | — (caveman)      |
| `cavecrew-reviewer`     | Single-line, severity-tagged findings              | Read, Grep, Bash                       | haiku   | — (caveman)      |
| `atlassian`    | Confluence search, Jira lookups, task validation | Read, `mcp__atlassian__*`                        | inherit | —                |

`atlassian` is the only agent with MCP access, and it needs the Atlassian Rovo MCP server configured in the session (this repo's installer does not manage MCP servers). Without it the agent is inert.

Inspiration credit: [`bpinheiroms/my-setup`](https://github.com/bpinheiroms/my-setup) — a non-Claude (OpenCode + Oh My OpenAgent) configuration that uses Greek-mythology personas for specialized agents. We adopted the *idea*, not the implementation; this harness uses Claude Code's official subagents mechanism.

## How delegation works

The orchestrator runs as the main session. When you give it a task, it:

1. Decides whether the task is trivial (does it itself) or composite (delegates).
2. For composite tasks, identifies independent subtasks and spawns subagents **in parallel** — multiple `Agent` calls in the same response.
3. Sequences dependent steps (e.g. `planner` → `implementer` → `reviewer` + `tester`).
4. Synthesizes results into a single answer.

There is no router config to maintain. Routing is description-based: each subagent's `description:` frontmatter is what Claude reads when deciding who to spawn. Edit a description, and routing behavior changes.

## Permission modes

Subagents inherit the parent session's permission mode. You don't need to configure this per-agent.

| Session mode      | What happens                                                        |
|-------------------|----------------------------------------------------------------------|
| Plan mode         | All subagents are read-only. Orchestrator should prefer explorer/planner; implementer/tester writes get blocked anyway. |
| Accept-edits      | implementer and tester edit without prompts. Full pipeline runs cleanly. |
| Default           | Subagents prompt for permission per tool, like the parent.          |

Read-only enforcement on `explorer`/`planner`/`pm`/`reviewer`/`pr-reviewer`/`pr-author`/`pr-triage`/`wave-monitor`/`cavecrew-investigator`/`cavecrew-reviewer`/`atlassian` comes from their `tools:` allowlist (no `Edit`/`Write`), **not** from `permissionMode`. This way they stay read-only regardless of session mode. Note that `pr-reviewer` and `pr-author` *can* call `gh pr review` / `gh pr create` via `Bash`, and `pm` can call `orca linear create` — but those commands are deliberately **not** pre-approved in `.claude/settings.json`, so they always prompt. That's the safety contract behind the "dry-run by default" posture: reads are pre-approved, writes to GitHub or the tracker stay a human decision. `wave-monitor` is the same shape from the other side: its `Bash` exists to query `pr-state.mjs`, `git` and `gh`, and the one command that would end a wave on its own — `gh pr merge` — is held back by two layers, not one. `permissions.deny` blocks the literal command as a string and does survive `--dangerously-skip-permissions`, but it never sees the wrapped form: under the bypass, `bash -c "gh pr merge 3"` has no approval prompt left to catch it. What closes the wrapper is the `PreToolUse` hook `.claude/hooks/guard-destructive.mjs`, which is still evaluated under the bypass. Both facts were measured rather than assumed — [`docs/guard-destructive.md`](docs/guard-destructive.md) carries the table. Both layers also run in the client, so "merge stays human" holds exactly as long as the worker runs this client; the guarantee that doesn't depend on it is branch protection on GitHub.

`pr-triage` goes one step further and has no `Bash` at all. The thread bodies it reads are untrusted input — anyone who can comment on a PR writes text that lands in its context, and review comments routinely contain "run this" or "apply this patch". Denying it every writing and executing tool is what makes prompt injection through a comment a non-event: the worst a malicious comment can achieve is a wrong recommendation, which a human reads before anything happens.

## Skills

Skills are procedure documents Claude loads on demand. Routing works like it does for agents: the `description:` in each `SKILL.md` frontmatter is what Claude reads when deciding whether to load it. <!-- docs-count:skills -->Five ship with the harness, under `.claude/skills/`.

| Skill | What it owns |
|-------|--------------|
| `ticket-contract` | The 12 fields a ticket needs in order to work as a standalone agent prompt, plus the project-creation rules, the readiness check and the tracker adapter. Source of truth for the `pm` agent. |
| `orca-linear` | Discovery stub for the `orca linear` CLI — reading, creating and triaging Linear issues. Deliberately thin: the full, version-matched guide comes from the binary via `orca skills get orca-linear`. |
| `adversarial-review` | Reviewing a diff through two independent lenses. Spawns `reviewer` twice in parallel, each with a distinct lens and fresh context, then confronts the two reports. |
| `wave-orchestration` | Planning execution in waves from a ticket dependency graph: how to pick the source (Linear via `orca linear`, or GitHub Issues via `gh`), how to build the graph, how to present the plan, and the wave's non-negotiable rules. |
| `pr-babysitting` | Driving an open PR to review-ready, tracking CI and feedback as two independent states. Uses `pr-state.mjs` and `fetch-pr-threads.mjs`, and delegates thread classification to `pr-triage`. |

### Two different things are called a "contract"

The names are close enough to merge in a reader's head, so keep them apart:

| | Skill `ticket-contract` | File `.wave/<ticket>/contract.md` |
|---|---|---|
| What it governs | Quality of the **ticket** — the 12 fields that make a ticket usable as an agent prompt | The **interface** between `implementer` and `tester` while one ticket is executed: signatures, types, error behavior, scenario list |
| Who writes it | `pm`, when the project is created | Both agents, in parallel, before either writes code |
| When it exists | Before the wave starts | Inside the execution of a single ticket |
| Lifetime | Lives in the tracker | Working state; `.wave/` is gitignored |

Neither replaces the other. The ticket contract decides whether work is ready to start; the wave contract keeps two parallel agents building and testing the same shape.

### How skills are installed

The installer links `.claude/skills` **one entry at a time** into `~/.claude/skills`, and never symlinks the directory itself. That directory is shared ground: plugins and other toolkits (argent, maestri, tentrai, ...) install their skills there too, and linking the directory would hide all of them at once.

A name that already exists in `~/.claude/skills` and is not one of our links is **reported and skipped** — never overwritten, never backed up. The harness only ever owns names it created.

The same mechanism exposes skills that live outside the harness. `EXTERNAL_SKILL_LINKS` in `scripts/install.mjs` maps a skill name to an absolute source path; today it links `orca-cli` from `~/.agents/skills/orca-cli`, since Claude Code only loads what lives under `~/.claude/skills`. If the source is missing, the installer says so and moves on.

## Slash commands

One `.md` per command under `.claude/commands/`, symlinked as a whole directory into `~/.claude/commands/` (unlike skills — that path is not shared with third parties). A new command file is live as soon as it is pulled; it needs no re-install.

| Command | What it does |
|---------|--------------|
| `/sync-harness` | Force a harness update now, bypassing only the 6h throttle. All other safety checks still apply. |
| `/ticket-new` | Turn a discussion, spec or raw scope into tickets that satisfy the ticket contract. Spawns `pm`; approval is required before anything is published to the tracker. |
| `/review-adversarial` | Adversarial review of the diff against a base (default `main`) via the `adversarial-review` skill. |
| `/wave-plan` | Read a Linear project or a GitHub repo slice, build its dependency graph, and print the wave plan via the `wave-orchestration` skill. |
| `/wave-run` | Dispatch **one** wave of that plan — one worktree and one agent per ticket, cut from an up-to-date `origin/main`. Never merges, never chains the next wave. |
| `/wave-status` | Spawn `wave-monitor` for the branches of a running wave and print its table. Reports only: no fixing, no merging. |
| `/pr-babysit` | Drive a PR to review-ready via the `pr-babysitting` skill, with CI and feedback tracked as separate states. |

The wave and PR commands invoke `scripts/waves/*` through the `~/.claude/harness` symlink, so their paths are stable regardless of where the checkout lives. Their read-only invocations are pre-approved in `.claude/settings.json`; the tracker writes they may lead to (`orca linear create`, `status set`, `comment add`, `attach`) are not, and prompt every time.

## Troubleshooting

**The orchestrator isn't being used**
- Run `/agents` to see the active agent. If it's not `orchestrator`, check `~/.claude/settings.json` includes `"agent": "orchestrator"` and that `~/.claude/agents` resolves to this repo (`readlink ~/.claude/agents`).

**The orchestrator stops delegating in long sessions**
- Two hooks help with this: `UserPromptSubmit` runs `~/.claude/hooks/orchestrator-reminder.mjs` to reinject a short delegation reminder on every prompt, and `PreCompact` runs `~/.claude/hooks/preserve-orchestrator.mjs` to preserve the orchestrator's identity through context compaction. Both are wired into `~/.claude/settings.json` by the installer.
- To disable both for one session (or permanently per-machine), export `CLAUDE_SETUP_SKIP_ORCH_REMINDER=1`.

**A subagent isn't being spawned when it should be**
- Routing is description-based. Read the subagent's `description:` field — does it cover the task you expected? Edit it to be more precise. Phrases like "use proactively" and "use immediately after X" influence Claude to pick that agent.

**A subagent keeps trying to edit when it shouldn't**
- Check its `tools:` allowlist — `Edit` or `Write` shouldn't be there for read-only roles.

**I want to opt out for one session**
- Start with `claude --agent default` (or whatever agent name you want) to override.

**Adding a new specialist**
- Create `.claude/agents/<name>.md` in this repo with frontmatter (`name`, `description`, `tools`, `model: inherit`).
- Update `orchestrator.md`'s roster section so it knows the new agent exists.
- Update this doc's roster table.
