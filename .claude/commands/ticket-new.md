---
description: Turn a discussion, spec, or scope into tickets that satisfy the ticket contract.
---

Spawn the `pm` agent to build the tickets. Scope: $ARGUMENTS (when empty, use the current conversation as the source material).

Tell it to load the `ticket-contract` skill first — the 12 fields, the project rules, the readiness checklist and the tracker adapter live there — and to detect the tracker with `node ~/.claude/hooks/session-context.mjs --json` before touching anything, falling back to `--verify-account` when that answers `null`. GitHub Issues is read/write via `gh`; Jira is read-only via the `atlassian` agent, which you spawn on `pm`'s behalf since it has no Agent tool.

`pm` must present the breakdown and get approval before publishing anything. If it reports a contract field it couldn't fill honestly, relay the question to me instead of letting it invent an answer.
