# Agent System

This harness ships an orchestrator + 11 specialist subagents, all defined under `.claude/agents/`. Every session that loads this harness starts in the `orchestrator` agent (set via `.claude/settings.json`'s `agent` field).

## Roster

| Agent          | Role                                          | Tools                                              | Model   | my-setup persona |
|----------------|-----------------------------------------------|----------------------------------------------------|---------|------------------|
| `orchestrator` | Decomposes tasks, delegates in parallel, synthesizes | inherit (all)                              | inherit | sisyphus         |
| `explorer`     | Read-only research, code search, doc reading  | Read, Grep, Glob, WebFetch, WebSearch, Bash        | inherit | librarian        |
| `planner`      | Designs strategy, returns step-by-step plans  | Read, Grep, Glob, WebFetch, Bash                   | inherit | prometheus       |
| `implementer`  | Writes/edits code per a plan                  | Read, Edit, Write, Grep, Glob, Bash, NotebookEdit  | inherit | hephaestus       |
| `reviewer`     | Reviews local diffs for quality and security  | Read, Grep, Glob, Bash                             | inherit | oracle           |
| `pr-reviewer`  | Reviews an open GitHub PR via `gh` (dry-run default) | Read, Grep, Glob, Bash                       | inherit | —                |
| `pr-author`    | Drafts PR title/body; opens PR on confirmation | Read, Grep, Glob, Bash                            | inherit | —                |
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

Read-only enforcement on `explorer`/`planner`/`reviewer`/`pr-reviewer`/`pr-author`/`cavecrew-investigator`/`cavecrew-reviewer`/`atlassian` comes from their `tools:` allowlist (no `Edit`/`Write`), **not** from `permissionMode`. This way they stay read-only regardless of session mode. Note that `pr-reviewer` and `pr-author` *can* call `gh pr review` / `gh pr create` via `Bash`, but those commands are deliberately **not** pre-approved in `.claude/settings.json`, so they always prompt — that's the safety contract behind their "dry-run by default" posture.

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
