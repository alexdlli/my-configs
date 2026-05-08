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

## Commit Rules

- Never include Claude Code as co-author in commits.
- Scripts and hooks default to Node.js stdlib (`.mjs`, no deps) for portability.
- Test before committing: `node --check scripts/<name>.mjs`, then a dry run (`node scripts/install.mjs --dry-run` against a fake `$HOME`).
