# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Purpose

Personal Claude Code harness: an orchestrator agent + specialists, installed globally to `~/.claude/` via symlinks. Centralizes the agent definitions, hooks, and settings I want available in every Claude Code session.

## Before writing or modifying any code (required)

Always read these first, every session, without me having to ask:

- [`docs/agent-system.md`](docs/agent-system.md) — agent system architecture and roles
- [`docs/contributing.md`](docs/contributing.md) — contribution conventions for this repo
- The **Token-saving conventions** and **Commit Rules** sections below in this file — they are the code standards

If any of these is missing or out of date, tell me before proceeding.

## Memory protocol (every session)

**At the start:** query project memory via the ai-memory MCP (`memory_query` / `memory_recent`) before answering anything non-trivial. The SessionStart hook already fetches the pending handoff ("where we left off"); look also for prior decisions, project rules, and known gotchas. Do not guess architecture — ask the memory. (Setup: [`docs/integrations/ai-memory.md`](docs/integrations/ai-memory.md).)

**During:** if I correct you on a pattern, treat it as a rule, not a one-off fix for this session.

**At the end (or when something durable appears):** record in memory ONLY what matters for the future — a decision with consequences, a reproducible gotcha, a procedure that repeats, an explicit preference of mine, or an important project pattern. Do NOT record: a test command, a transient error, an environment-of-the-day failure, or the whole session narrative. Golden rule: **bad memory is worse than no memory.** (This is why `[auto_improve] require_approval = true` — nothing enters the wiki without my approval.)

## What Goes Here

- **`.claude/settings.json`** — baseline tool permissions (`allow` + `deny`), default agent, and hooks (deep-merged into `~/.claude/settings.json` by the installer)
- **`.claude/agents/`** — orchestrator + specialist subagent definitions (symlinked into `~/.claude/agents/`)
- **`.claude/hooks/`** — Claude Code hook scripts (symlinked into `~/.claude/hooks/`). <!-- docs-count:hooks -->Five today; the one that carries a guarantee is `guard-destructive.mjs`, a `PreToolUse` hook on `Bash` that denies `gh pr merge`, `git push --force` and `git commit --no-verify` **including the shell-wrapped form** (`bash -c "..."`, pipe to a shell) that `permissions.deny` matches as a string and therefore misses. Both layers were measured to survive `--dangerously-skip-permissions`, which is what keeps "merge is always human" true for a wave worker running with the bypass on — the deny list alone would not, since the bypass removes the approval prompt that used to catch the wrapper. See [`docs/guard-destructive.md`](docs/guard-destructive.md).
- **`.claude/commands/`** — slash commands, symlinked as a whole directory into `~/.claude/commands/`: `/sync-harness`, `/ticket-new`, `/review-adversarial`, `/wave-plan`, `/wave-run`, `/wave-status`, `/pr-babysit`. A new command file goes live on pull, with no re-install.
- **`.claude/skills/`** — `ticket-contract` (the 12 fields that make a ticket a self-sufficient agent prompt), `orca-linear` (discovery stub for the `orca linear` CLI), `adversarial-review` (two reviewers, two lenses, fresh context each), `wave-orchestration` (wave plan from the dependency graph), `pr-babysitting` (CI and feedback as two independent states). Linked **one entry at a time** into `~/.claude/skills/` — that directory is shared with 30+ third-party skills, so the installer never symlinks it wholesale, and a name it doesn't own is reported and skipped rather than overwritten. The same mechanism exposes skills living outside the harness: `EXTERNAL_SKILL_LINKS` links `orca-cli` from `~/.agents/skills/orca-cli`.
- **`scripts/install.mjs`** — installer (symlinks + settings merge + uninstall)
- **`scripts/waves/`** — read-only wave pipeline: `tickets-linear.mjs` (Linear project into normalized tickets), `tickets-github.mjs` (GitHub Issues into the same shape, via `gh`), `graph.mjs` (`planWaves()`), `gh.mjs` (the shared `gh` access plus the exit-code table both PR readers honour), `pr-state.mjs` (CI state), `fetch-pr-threads.mjs` (PR feedback). See [`docs/waves.md`](docs/waves.md).
- **`scripts/setup-ai-memory.mjs`** — one-shot [ai-memory](https://github.com/akitaonrails/ai-memory) setup (long-term markdown-wiki memory + Hermes-style auto-improve for coding agents). `--provider` selects the LLM backend; default `claude-sub` routes ai-memory's `openai-compat` provider through the local `claude -p` shim so it uses your Claude subscription via the sanctioned CLI path. ai-memory owns its own MCP/hooks/instructions and merges them idempotently, coexisting with `install.mjs`. See [`docs/integrations/ai-memory.md`](docs/integrations/ai-memory.md).
- **`scripts/claude-openai-shim.mjs`** — zero-dep OpenAI-compatible HTTP server that shells out to `claude -p` (stripping `ANTHROPIC_API_KEY` to force subscription auth). Kept alive by a LaunchAgent so memory works in every session.
- **`scripts/verify-ai-memory.mjs`** — read-only end-to-end check of the ai-memory chain (container, the LLM backend the server is actually configured with, `ai-memory status`, bootstrap reachability, wiki git history). `--json` for a machine-readable summary; exit 2 means a prerequisite was missing and part of the setup went unverified.
- **`scripts/backup-ai-memory.mjs`** — dumps the `ai-memory-data` volume to `~/ai-memory-backups` with rotation; `--install` adds a LaunchAgent that repeats it at login/boot and daily. Supports `--dry-run` and `--uninstall`.
- **`docs/`** — install guide, agent/skill/command reference, contributing conventions, the wave flow ([`docs/waves.md`](docs/waves.md)) and the integration notes under [`docs/integrations/`](docs/integrations/)

Two different artifacts are called a "contract" — don't merge them. The skill **`ticket-contract`** governs the quality of a *ticket* (the 12 fields that let an agent execute it from a clean context); the file **`.wave/<ticket>/contract.md`** is the *interface* contract between `implementer` and `tester` while one ticket runs (signatures, types, error behavior, scenario list). The first exists before the wave starts and lives in the tracker; the second is working state, born inside a ticket's execution, and `.wave/` is gitignored. Any project driving waves with this harness needs that same ignore entry.

## Agent System

Every session starts in the `orchestrator` agent (set via `.claude/settings.json`). It decomposes tasks and delegates in parallel to specialists:

| Agent                   | Role                                          |
|-------------------------|-----------------------------------------------|
| `orchestrator`          | Decomposition, parallel delegation, synthesis |
| `explorer`              | Read-only research and discovery              |
| `planner`               | Implementation strategy (read-only)           |
| `pm`                    | Spec/discussion into contract-compliant tickets (read-only on code) |
| `implementer`           | Writes/edits code per a plan                  |
| `reviewer`              | Code review, quality, security                |
| `tester`                | Lint / typecheck / test / build               |
| `qa`                    | Runs the change and produces the proof artifact (screenshot, test, command output) |
| `pr-author`             | Drafts PRs from the current branch            |
| `pr-reviewer`           | Reviews open GitHub PRs                       |
| `pr-triage`             | Classifies PR feedback threads; never applies, never posts |
| `wave-monitor`          | Wave branch state in one compact table (haiku); never fixes, never merges |
| `cavecrew-investigator` | Fast read-only locator (haiku, terse output)  |
| `cavecrew-builder`      | Surgical 1-2 file edit                        |
| `cavecrew-reviewer`     | Single-line review findings (haiku)           |
| `atlassian`             | Confluence / Jira via the Atlassian Rovo MCP  |

Subagents inherit the parent's permission mode, so plan mode and accept-edits propagate naturally. Read-only enforcement on research agents is via `tools:` allowlist, not `permissionMode`.

Inspiration credit: [`bpinheiroms/my-setup`](https://github.com/bpinheiroms/my-setup) — adopted the *idea* of specialized agents with personas, built on Claude Code's official subagents mechanism.

Full details: [`docs/agent-system.md`](docs/agent-system.md).

## Installation

`node scripts/install.mjs` — see [`docs/installation.md`](docs/installation.md). Supports `--dry-run`, `--uninstall`, `--force-agent`. macOS-only.

## Token-saving conventions

When invoking shell commands, prefer compact flags that produce structured, parseable output. This captures the bulk of what dedicated tools (e.g. RTK) try to do via post-hoc filtering, without the round-trip cost of re-reading truncated output.

| Command family | Verbose default | Prefer |
|---|---|---|
| `git status` | full porcelain v1 | `git status --porcelain` (or `--short`) |
| `git log` | full body | `git log --oneline` (add `-n N` to cap) |
| `git diff` | full hunks | `git diff --stat` for overview; full diff only when reviewing |
| `git branch` | full | `git branch --list --format='%(refname:short)'` |
| `pytest` | full traceback | `pytest --tb=short -q` (use `--tb=line` for one-liners) |
| `cargo build` | progress bars | `cargo build --quiet` (or pipe through `2>&1 \| tail -50`) |
| `npm test` / `pnpm test` | full | run with `--silent` if available |
| `ls` | full `ls -l` | `ls -1` (one per line) or `ls -1A` |
| Long outputs (anything) | full | pipe through `head -N`, `tail -N`, `grep -E pattern`, or `wc -l` first |

Hard rules:

- Never grep through `node_modules`, `.git`, build artifacts, or vendored deps. Use `--exclude-dir` / `-not -path` filters.
- For file reads, prefer reading the specific lines/symbols you need (`Read` tool with `offset`/`limit`) over `cat`-ing the whole file.
- For repo-wide searches, prefer `Grep`/`Glob` (claude-code native, structured) over piped shell commands.

These conventions are enforced by the agents (`tester`, `implementer`, `cavecrew-*`) — but documenting them here means any new agent or one-off prompt inherits them.

## Commit Rules

- Never include Claude Code as co-author in commits.
- Scripts and hooks default to Node.js stdlib (`.mjs`, no deps) for portability.
- Test before committing: `node --check scripts/<name>.mjs`, then a dry run (`node scripts/install.mjs --dry-run` against a fake `$HOME`).

## Code quality standards (always apply)

These complement the **Commit Rules** and **Token-saving conventions** above; they do not replace them.

- No dead code and no unnecessary duplication.
- No magic hardcoded values; turn them into named constants and/or document them.
- Adequate test coverage for whatever changed.
- Update documentation when behavior changes.
- Don't trust a PR description; audit the actual code.
- Keep structure clear enough for an agent to navigate (clean code for agents).

## Project-specific standards

This repo's concrete conventions are already documented above and in `docs/` — in particular: Node.js stdlib only (`.mjs`, no deps); macOS-only; never co-author commits with Claude Code; idempotent installers with `--dry-run`. Add any further naming/layout/library rules here as they solidify, so they don't have to be repeated each session.

## Perfil de risco do projeto

Project-level declaration read by the `ticket-contract` skill. The heading and the declaration below stay in Portuguese even though the rest of this file is English: tickets cite them verbatim (`.claude/skills/ticket-contract/SKILL.md`, section "Declaração de perfil do projeto", and the rendering example under "Como renderizar os 12 campos"), so translating either breaks the citation.

> Este harness não tem runtime em produção, não emite telemetria e não toca dado pessoal. Os artefatos são markdown e scripts Node stdlib instalados por symlink, e o rollback padrão de qualquer mudança é `git revert` do PR.

**What this waives: fields 11 (events and metrics) and 12 (i18n / LGPD / factories), and nothing else.** A ticket covered by the declaration resolves each of those in one line citing this section, instead of spending a paragraph to say "não se aplica".

**Field 10 (rollout and kill switch) stays mandatory in every ticket.** The `git revert` sentence above states the *default* rollback; it does not state that a ticket has no risk to contain. Measured on the 6 tickets of this repo's first real project (`alexdlli/my-configs` issues #1-#6): field 10 carried real content in all 6 — the concrete risk plus its containment (a fake `$HOME` for the permissions experiment, "diff empty inside the extracted functions" for the refactor, the Actions toggle for the first CI workflow). A declaration cannot pre-answer that.

The per-ticket exception still applies to 11 and 12: a ticket that starts touching personal data or adding user-facing text fills the field in full and names which premise of the declaration it breaks. The declaration covers the repo, not the ticket.

## What NOT to do

- Don't rewrite from scratch to fit an imagined "ideal" structure (no over-engineering). Make it work, then make it right, then make it fast — in that order.
- Don't introduce an abstraction that has no real usage yet to justify it.

<!-- ai-memory:start -->
## Long-term memory (ai-memory)

This project uses [ai-memory](https://github.com/akitaonrails/ai-memory)
for cross-session continuity.

**Default to the current project — always.** Every ai-memory tool
auto-scopes to the project resolved from your session's working
directory. **Do NOT pass `project`, `workspace`, or `cwd` arguments unless the user
explicitly references a *different* project by name** (e.g. "what did we
decide in the `other-app` project?"). Phrases like "this project",
"here", "we", "our work", "where did we leave off" all mean the *current*
project — call the tool with no scoping args. If the user asks about a
handoff and the SessionStart auto-fetched block is already in your
context, just answer from it; do not re-call the tool to "find it again"
in another project.

**Lifecycle hooks already capture every prompt + tool call
automatically.** You never need to manually write routine notes; the
SessionStart hook auto-fetches pending handoffs, and on session end
ai-memory writes a session-summary page and a handoff.
LLM consolidation (compiling observations into topical wiki pages) runs
on PreCompact, on demand via `memory_consolidate`, and at session end
only when the server sets `AI_MEMORY_CONSOLIDATE_ON_SESSION_END`. Only
write a durable wiki page when the user explicitly asks to remember or
annotate something permanently.

### When to reach for each tool

The user can express any of the intents below in plain English —
match the intent to the tool. They do not need to name the tool.

| User says / situation | Tool |
|---|---|
| "have we discussed X?" / "search memory for Y" / before proposing architecture | `memory_query` (current project; `scopes` for named siblings; `global=true` to search every project) |
| "what's been going on" / "show recent activity" (light) | `memory_recent` |
| "is ai-memory healthy?" / "how big is the wiki?" | `memory_status` |
| "give me the stats" / structured snapshot for the agent to consume | `memory_briefing` (read-only; never creates handoffs) |
| "catch me up" / "I've been away" / "what's important right now?" / open-ended exploration | `memory_explore` |
| "where did we leave off?" — and you see a `📥 ai-memory: pending handoff` block in your context | already done — answer from that block; do NOT re-call `memory_handoff_accept` |
| "where did we leave off?" — and no such block is visible | `memory_handoff_accept` (rare; the SessionStart hook usually got there first; pass `workspace` + `project` together only for a named sibling workspace/project) |
| "save context for the next session" / wrapping up / ending this session | `memory_handoff_begin` (session-end only; do **not** use for status/briefing; single-use handoff; terse summary; put detail in `open_questions` + `next_steps` bullets; pass `workspace` + `project` together only for a named sibling workspace/project) |
| "discard that handoff" / "I created a handoff by mistake" | `memory_handoff_cancel` (requires exact `handoff_id` from `memory_handoff_begin`; marks it expired before the next session sees it) |
| "consolidate this session" / "compile what we learned" (also runs on PreCompact; at session end only if `AI_MEMORY_CONSOLIDATE_ON_SESSION_END` is set) | `memory_consolidate` |
| "what did we learn from this session?" / "what memory should we add?" / explicit wrap-up learning review | `memory_auto_improve` (manual learning review for a completed session; omit `session_id` for latest completed session; the server also schedules background review for newly completed sessions in every project when configured) |
| "remember this permanently" / "save a note" / "add an annotation" / durable project knowledge | `memory_write_page` (write a wiki page; do **not** use handoff for permanent notes; put the title as a `# H1` on the first line of `body` and omit the `title` arg — ai-memory derives it from the H1) |
| "read the page about X" / "show me the full content of Y" / "open the page on Z" | `memory_read_page` (full body; pass a query to search or `path` for a direct lookup; pass `workspace` + `project` together only for a named sibling workspace/project) |
| "delete the page X" / "remove that note" | `memory_delete_page` (by exact `path`; idempotent; pass `workspace` + `project` together only for a named sibling workspace/project) |
| "audit the wiki" / "find contradictions" / "what rules should we add?" | `memory_lint` |
| "prune old pages" / "memory cleanup" | `memory_forget_sweep` |

`memory_explore` is the right default for the "I want to know what's
going on" use case — it returns a prose digest whose verbosity
scales automatically to how long it's been since the last activity
(< 1 h → one line; > 30 days → full catchup).

### When the current project comes up empty — broaden the search

`memory_query` searches only the **current** project by default. If a
search comes back empty or thin, the knowledge may live in a **sibling
project** — shared `infra`, `ops`, or a related app. Don't conclude
"we never recorded it" after a single project misses; broaden instead:

- **Know which projects to check?** Re-run with explicit `scopes`, e.g.
  `scopes: [{ "workspace": "default", "project": "infra" }]`.
- **Don't know where it lives?** Pass `global=true` to search every
  project in every workspace at once. Each hit is annotated with its
  workspace + project so you can tell where it came from. `global=true`
  cannot be combined with `scopes`/`project`/`workspace`.

`memory_query` returns **snippets, not full page bodies** — an empty or
short snippet does **not** mean the page is empty (a large page can
match outside the snippet window). To read the whole page, use
`memory_read_page` (by `path`, or pass a `query` to fetch the top hit's
full body; add `workspace` + `project` together only when the user names
a sibling workspace/project).

### Use Retrieved Memory As Operating Guidance

When `memory_query` or `memory_recent` returns `_rules/`, `gotchas/`,
`procedures/`, or `decisions/` pages that match the current task, treat
them as actionable context, not trivia:

- Read full pages with `memory_read_page` when the snippet looks relevant.
- Apply `_rules/` as constraints.
- Check `gotchas/` as preflight warnings before editing the same subsystem.
- Follow `procedures/` as checklists for releases, PR reviews, deploys,
  migrations, and other repeatable workflows.
- Use `decisions/` as prior architecture unless the user explicitly asks
  to revisit them.

Before non-trivial coding, debugging, deployment, release, auth, scope,
migration, PR-review, or data-preservation work, search memory for the
subsystem and task type first. If the first query is thin, broaden or
query specific error/subsystem terms before designing a fix.

### Learning Review

The server schedules background auto-improvement for newly completed sessions in
every project when an LLM provider is configured. `memory_auto_improve` is the manual version:
use it when the user asks what durable lessons this session suggests, or at
explicit wrap-up when reviewing proposed memory would be useful. Scheduled and
manual runs apply or stage validated edits through the auto-improvement approval
path. Admins can turn off scheduling with `[auto_improve.scheduler] enabled =
false`, or opt into manual proposal approval with `[auto_improve]
require_approval = true`, in which case scheduled and manual proposals stay in
pending-writes until approved.

### When you write a project rule, write it here

If you're about to write a durable project rule ("always X", "never
Y", "all PRs must …"), write it in the project's canonical agent
instruction file. Many projects use CLAUDE.md for Claude Code and
AGENTS.md for Codex / OpenCode / Cursor / Gemini CLI, but if the
project says one file is canonical, use that file. ai-memory's lint
pass surfaces the same hint automatically when a `kind: rule` page
lands in `_rules/`.

### Refreshing this snippet

This block is maintained by ai-memory. Two ways to refresh it with
the latest binary's recommended copy:

- **From the agent** (no terminal needed): ask "refresh the ai-memory
  routing in this project" — the agent calls
  `memory_install_self_routing`, picks the right filename for itself
  (Claude Code → `CLAUDE.md`; Codex / OpenCode / Cursor / Gemini →
  `AGENTS.md`), and uses its Write / Edit tool to land the block.
- **From the CLI**: `ai-memory install-instructions` (defaults to
  `CLAUDE.md`; pass `--target AGENTS.md` for non-Claude agents or
  projects that use `AGENTS.md` as the canonical instruction file).

Both are idempotent: re-runs replace the block bracketed by
`<!-- ai-memory:start -->` / `<!-- ai-memory:end -->` markers
without disturbing the rest of the file.
<!-- ai-memory:end -->
