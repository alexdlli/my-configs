# Agent System

This harness ships an orchestrator + <!-- docs-count:specialists -->11 specialist subagents, all defined under `.claude/agents/`. Every session that loads this harness starts in the `orchestrator` agent (set via `.claude/settings.json`'s `agent` field).

## Roster

| Agent          | Role                                          | Tools                                              | Model   | my-setup persona |
|----------------|-----------------------------------------------|----------------------------------------------------|---------|------------------|
| `orchestrator` | Decomposes tasks, delegates in parallel, synthesizes | inherit (all)                              | inherit | sisyphus         |
| `explorer`     | Read-only research, code search, doc reading  | Read, Grep, Glob, WebFetch, WebSearch, Bash        | inherit | librarian        |
| `planner`      | Designs strategy, returns step-by-step plans  | Read, Grep, Glob, WebFetch, Bash                   | inherit | prometheus       |
| `implementer`  | Writes/edits code per a plan                  | Read, Edit, Write, Grep, Glob, Bash, NotebookEdit  | inherit | hephaestus       |
| `reviewer`     | Reviews local diffs for quality and security  | Read, Grep, Glob, Bash                             | inherit | oracle           |
| `pr-author`    | Drafts PR title/body; opens PR on confirmation | Read, Grep, Glob, Bash                            | inherit | —                |
| `pr-triage`    | Classifies a PR's open feedback threads from `threads.json`; recommends, never applies | Read, Grep, Glob             | inherit | —                |
| `tester`       | Runs lint/typecheck/test/build                | Read, Edit, Grep, Glob, Bash                       | inherit | atlas            |
| `qa`           | Runs the change and produces the artifact that proves it (screenshot, integration test, command output) | Read, Grep, Glob, Bash, `mcp__argent__*` | inherit | —                |
| `cavecrew-investigator` | Fast read-only code locator (terse caveman output) | Read, Grep, Glob, Bash                | haiku   | — (caveman)      |
| `cavecrew-builder`      | Surgical 1-2 file edit; refuses 3+ file scope     | Read, Edit, Write, Grep, Glob          | inherit | — (caveman)      |
| `atlassian`    | Confluence search, Jira lookups, task validation | Read, `mcp__atlassian__*`                        | inherit | —                |

`atlassian` and `qa` are the only agents with MCP access, and each depends on a server this repo's installer does not manage: the Atlassian Rovo MCP for `atlassian`, argent for `qa`. Without the server, `atlassian` is inert entirely; `qa` loses less than it looks — it still runs a CLI or an endpoint through `Bash`, and on `host: maestri` the device track is a Maestri portal driven by `"$MAESTRI_CLI"`, which is `Bash` as well. argent is what `qa` needs on every other host, and for everything a portal does not cover (profiling, network logs, screenshot diff, TV targets).

Inspiration credit: [`bpinheiroms/my-setup`](https://github.com/bpinheiroms/my-setup) — a non-Claude (OpenCode + Oh My OpenAgent) configuration that uses Greek-mythology personas for specialized agents. We adopted the *idea*, not the implementation; this harness uses Claude Code's official subagents mechanism.

## How delegation works

The orchestrator runs as the main session. When you give it a task, it:

1. Decides whether the task is trivial (does it itself) or composite (delegates).
2. For composite tasks, identifies independent subtasks and spawns subagents **in parallel** — multiple `Agent` calls in the same response.
3. Sequences dependent steps (e.g. `planner` → `implementer` → `reviewer` + `tester`, plus `qa` whenever the change is something that can be run).
4. Synthesizes results into a single answer.

There is no router config to maintain. Routing is description-based: each subagent's `description:` frontmatter is what Claude reads when deciding who to spawn. Edit a description, and routing behavior changes.

## Permission modes

Subagents inherit the parent session's permission mode. You don't need to configure this per-agent.

| Session mode      | What happens                                                        |
|-------------------|----------------------------------------------------------------------|
| Plan mode         | All subagents are read-only. Orchestrator should prefer explorer/planner; implementer/tester writes get blocked anyway. |
| Accept-edits      | implementer and tester edit without prompts. Full pipeline runs cleanly. |
| Default           | Subagents prompt for permission per tool, like the parent.          |

Read-only enforcement on `explorer`/`planner`/`reviewer`/`pr-author`/`pr-triage`/`qa`/`cavecrew-investigator`/`atlassian` comes from their `tools:` allowlist (no `Edit`/`Write`), **not** from `permissionMode`. This way they stay read-only regardless of session mode. `qa` is the widest of them: it runs the product under test through `Bash` and drives a simulator or a browser — a Maestri portal on `host: maestri`, `mcp__argent__*` anywhere else — and still cannot edit a line of the repo; a flow that fails goes back to `implementer` as a finding, never as a patch. Note that `pr-author` *can* call `gh pr create` via `Bash` — but that command is deliberately **not** pre-approved in `.claude/settings.json`, so it always prompts. That's the safety contract behind the "dry-run by default" posture: reads are pre-approved, writes to GitHub stay a human decision. The one command that would end a PR on its own — `gh pr merge` — is held back by **less than that, and the number is worth knowing.** It is not in `permissions.deny`: the ask-then-merge policy took it out deliberately, so that it reaches the permission prompt where a human approves. The `PreToolUse` hook `.claude/hooks/guard-destructive.mjs` denies it only inside a worker, recognized by a `.wave/worker.json` that no harness procedure writes today; everywhere else the hook is silent by design. Silence means "the prompt decides" — and `--dangerously-skip-permissions` removes the prompt, so under the bypass, outside a worker, the command runs with nothing in front of it. What *is* covered by two layers, both measured surviving the bypass, is `git push --force` and `git commit --no-verify`: the string deny plus the hook, which is also the only one of the two that sees `bash -c "..."`. The table is in [`guard-destructive.md`](guard-destructive.md). Every layer here runs in the client, so the only guarantee that does not depend on this machine is branch protection on GitHub.

`pr-triage` goes one step further and has no `Bash` at all. The thread bodies it reads are untrusted input — anyone who can comment on a PR writes text that lands in its context, and review comments routinely contain "run this" or "apply this patch". Denying it every writing and executing tool is what makes prompt injection through a comment a non-event: the worst a malicious comment can achieve is a wrong recommendation, which a human reads before anything happens.

## Skills

Skills are procedure documents Claude loads on demand. Routing works like it does for agents: the `description:` in each `SKILL.md` frontmatter is what Claude reads when deciding whether to load it. <!-- docs-count:skills -->Two ship with the harness, under `.claude/skills/`. Neither has a slash command in front of it: naming the skill, or describing the situation its description covers, is how it loads.

| Skill | What it owns |
|-------|--------------|
| `pr-babysitting` | Driving an open PR to review-ready, tracking CI and feedback as two independent states. Uses `pr-state.mjs` and `fetch-pr-threads.mjs`, and delegates thread classification to `pr-triage`. |
| `maestri-orchestration` | Orchestrating a team from inside a Maestri terminal. Deliberately narrow: it writes only what changes by being there — `"$MAESTRI_CLI"` instead of `maestri`, the fragile paste channel, the two shared notes, the recruit verbs, and the floor as an isolation primitive — including how to tell an isolated floor from a degraded one, and what to do when it degraded. Everything that holds in both environments is referenced by owner, never restated. |

`implementer` and `tester` still share an interface contract while one unit of work runs — signatures, types, error behavior, scenario list — written to `.wave/<ticket>/contract.md` when the work has a ticket id, otherwise to the scratchpad path the orchestrator hands them. It is working state, not a document: `.wave/` is gitignored, and any project driven by this harness needs that same ignore entry. The two agent prompts own the protocol.

### How skills are installed

The installer links `.claude/skills` **one entry at a time** into `~/.claude/skills`, and never symlinks the directory itself. That directory is shared ground: plugins and other toolkits (argent, maestri, tentrai, ...) install their skills there too, and linking the directory would hide all of them at once.

A name that already exists in `~/.claude/skills` and is not one of our links is **reported and skipped** — never overwritten, never backed up. The harness only ever owns names it created.

The same mechanism exposes skills that live outside the harness. `EXTERNAL_SKILL_LINKS` in `scripts/install.mjs` maps a skill name to an absolute source path, since Claude Code only loads what lives under `~/.claude/skills`. It is **empty today** — the map stays because it has already carried a real entry and is the documented extension point; if the source of an entry is missing, the installer says so and moves on.

## Slash commands

None. The harness shipped three — `/sync-harness`, `/ticket-new`, `/pr-babysit` — and across 259 measured session transcripts not one of them was ever invoked, so `.claude/commands/` and `.opencode/command/` were removed along with the `~/.claude/commands` symlink. They are preserved at the annotated tag `pre-lean-cut`.

Nothing they did is unreachable: `/pr-babysit` was a wrapper over the `pr-babysitting` skill, which loads by name; `/sync-harness` was a wrapper over `node ~/.claude/hooks/auto-update.mjs --force`, which is the actual way to bypass the 6h throttle and works from any directory through the installed symlink; `/ticket-new` went with the ticket pipeline.

Re-adding one means re-adding `.claude/commands/` to `SYMLINK_ITEMS` in `scripts/install.mjs`. `.opencode/command/` is cheaper — the installer already walks that subdirectory and skips it when absent.

## Troubleshooting

**The orchestrator isn't being used**
- Run `/agents` to see the active agent. If it's not `orchestrator`, check `~/.claude/settings.json` includes `"agent": "orchestrator"` and that `~/.claude/agents` resolves to this repo (`readlink ~/.claude/agents`).

**The orchestrator stops delegating in long sessions**
- `PreCompact` runs `~/.claude/hooks/preserve-orchestrator.mjs` to preserve the orchestrator's identity through context compaction, wired into `~/.claude/settings.json` by the installer. A second hook used to reinject the same rules on every `UserPromptSubmit`; it was removed because it cost ~4.9k tokens per 40-turn session to repeat what the agent definition already says, while compaction is the moment the framing is actually lost. It is at the tag `pre-lean-cut`.
- To disable the remaining one for a session (or permanently per-machine), export `CLAUDE_SETUP_SKIP_ORCH_REMINDER=1` — the variable kept its name.

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
