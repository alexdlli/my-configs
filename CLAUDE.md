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
- **`.claude/commands/`** — slash commands, symlinked as a whole directory into `~/.claude/commands/`: `/sync-harness`, `/ticket-new`, `/wave-plan`, `/wave-status`, `/pr-babysit`. A new command file goes live on pull, with no re-install.
- **`.claude/skills/`** — `ticket-contract` (the 12 fields that make a ticket a self-sufficient agent prompt), `wave-orchestration` (wave plan from the dependency graph), `pr-babysitting` (CI and feedback as two independent states), `maestri-orchestration` (what changes when the session runs inside a Maestri terminal: `"$MAESTRI_CLI"`, the shared-note protocol, the floor as the wave's isolation primitive and the portal as the proof instrument). Linked **one entry at a time** into `~/.claude/skills/` — that directory is shared with 30+ third-party skills, so the installer never symlinks it wholesale, and a name it doesn't own is reported and skipped rather than overwritten. The same mechanism exposes skills living outside the harness through `EXTERNAL_SKILL_LINKS`, empty today and kept as the extension point.
- **`scripts/install.mjs`** — installer (symlinks + settings merge + uninstall)
- **`scripts/waves/`** — read-only wave pipeline: `tickets-github.mjs` (GitHub Issues into normalized tickets, via `gh`), `graph.mjs` (`planWaves()`), `gh.mjs` (the shared `gh` access plus the exit-code table both PR readers honour), `pr-state.mjs` (CI state), `fetch-pr-threads.mjs` (PR feedback). See [`docs/waves.md`](docs/waves.md).
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

**The ticket and wave pipeline is opt-in.** `pm` → `ticket-contract` → dependency graph → `wave-orchestration` still exists and still works, but it is not the default path: it runs when I ask for it by name (or through `/ticket-new`, `/wave-plan`, `/wave-status`). Delegating several fronts in parallel is ordinary orchestration, not a wave — turning a plain request into tickets costs two rounds before the first line is written.

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

**Default to the current project - always.** Every ai-memory tool
auto-scopes to the project resolved from your session's working
directory. **Do NOT pass `project`, `workspace`, or `cwd` arguments unless
the user explicitly references a *different* project by name** (e.g. "what
did we decide in the `other-app` project?"). Phrases like "this project",
"here", "we", "our work", and "where did we leave off" all mean the
*current* project, so call tools with no scoping args.

This default assumes the MCP client can identify the current agent
session. Static MCP clients in parallel sessions for the same user cannot
forward the real agent session id automatically; pass explicit
`workspace` + `project` / `scopes`, or use a session-aware bridge that
forwards the lifecycle-hook session id on MCP calls.

**Lifecycle hooks already capture sanitized, bounded prompt and tool-lifecycle
observations automatically.** They are not complete native transcripts;
managed `ai-memory run` launches add the portable visible-event ledger. Do not
manually write routine notes. Only write durable memory when the user explicitly asks
to remember or annotate something permanently.

### Use the installed ai-memory Agent Skills

Detailed tool-routing guidance lives in the installed ai-memory Agent
Skills. When a task matches an installed ai-memory Agent Skill, load and
follow that skill before calling ai-memory tools. The skills cover memory
retrieval, handoffs, durable pages, learning maintenance, and routing
install or refresh work.

### When you write a project rule, write it here

If you're about to write a durable project rule ("always X", "never
Y", "all PRs must ..."), write it in the project's canonical agent instruction file.
Many projects use CLAUDE.md for Claude Code and
AGENTS.md for Codex / OpenCode / Cursor / Gemini CLI / Grok Build CLI / Kimi Code,
but if the project says one file is canonical, use that file.

If the rule is a standing *user/team* preference that should apply to
every project (tech choices, code style, personal conventions), save it
to ai-memory's reserved global scope instead — the durable-pages skill
covers how. Default memory reads surface global-scope pages in every
project automatically.

### Refreshing this snippet

This block is maintained by ai-memory. Two ways to refresh it with the
latest binary's recommended copy:

- **From the agent** (no terminal needed): ask "refresh the ai-memory
  routing in this project". The agent calls `memory_install_self_routing`,
  picks the right filename for itself (Claude Code -> `CLAUDE.md`; Codex /
  OpenCode / Cursor / Gemini / Grok -> `AGENTS.md`; Kimi Code -> `AGENTS.md`),
  uses its Write / Edit tool to replace or append the returned
  `markered_block` while preserving
  non-ai-memory user content, then writes or updates each returned
  `managed_skills` item under the selected skill root from `target_hints`
  using its `relative_path`.
- **From the CLI**: `ai-memory install-instructions` (defaults to
  `CLAUDE.md`; pass `--target AGENTS.md` for non-Claude agents or projects
  that use `AGENTS.md` as the canonical instruction file).

Both are idempotent: re-runs replace the block delimited by the ai-memory
start/end HTML-comment markers, without disturbing the rest of the file.
<!-- ai-memory:end -->
