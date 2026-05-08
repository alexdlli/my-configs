# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Purpose

Personal Claude Code harness: an orchestrator agent + specialists, installed globally to `~/.claude/` via symlinks. Centralizes the agent definitions, hooks, and settings I want available in every Claude Code session.

## What Goes Here

- **`.claude/settings.json`** — baseline tool permissions, default agent, and hooks (deep-merged into `~/.claude/settings.json` by the installer)
- **`.claude/agents/`** — orchestrator + specialist subagent definitions (symlinked into `~/.claude/agents/`)
- **`.claude/hooks/`** — Claude Code hook scripts (symlinked into `~/.claude/hooks/`)
- **`scripts/install.mjs`** — installer (symlinks + settings merge + uninstall)
- **`docs/`** — install guide and agent system reference

## Agent System

Every session starts in the `orchestrator` agent (set via `.claude/settings.json`). It decomposes tasks and delegates in parallel to specialists:

| Agent          | Role                                          |
|----------------|-----------------------------------------------|
| `orchestrator` | Decomposition, parallel delegation, synthesis |
| `explorer`     | Read-only research and discovery              |
| `planner`      | Implementation strategy (read-only)           |
| `implementer`  | Writes/edits code per a plan                  |
| `reviewer`     | Code review, quality, security                |
| `tester`       | Lint / typecheck / test / build               |
| `pr-author`    | Drafts PRs from the current branch            |
| `pr-reviewer`  | Reviews open GitHub PRs                       |

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
