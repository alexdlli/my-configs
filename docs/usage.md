# Usage

The harness has no workflow to learn.

Start Claude Code or OpenCode normally and work with the client's native agent.
Describe the outcome, inspect execution, correct early, and validate with the
project's tests and CI. Use parallel agents only when the work is genuinely
independent; the harness never forces delegation.

## Automatic behavior

Claude Code runs three small hooks:

- `auto-update.mjs` checks this checkout for updates with a throttle.
- `session-context.mjs` reports bounded host/account context.
- `guard-destructive.mjs` blocks the measured destructive command shapes
  documented in [`guard-destructive.md`](guard-destructive.md).

OpenCode loads the equivalent destructive-command plugin and permission rules.

ai-memory is installed separately and keeps project continuity outside either
client. See [`integrations/ai-memory.md`](integrations/ai-memory.md).

## Validation

The source code and tests decide whether work is done. Use concise requirements
when useful, but do not maintain a generated spec, task graph, or agent-to-agent
contract as a second source of truth.
