# my-configs

Minimal personal tooling for Claude Code and OpenCode.

It deliberately does not install a default agent, specialist roster, orchestration
graph, ticket pipeline, or spec workflow. The native client and a strong model do
the work; this repository keeps only portable safety, session context, installation,
ai-memory integration, and a mobile design skill.

## What remains

- A destructive-command guard for Claude Code and OpenCode.
- Session-start context and a throttled self-update hook.
- An idempotent installer that preserves unrelated user configuration and retracts
  artifacts this repository no longer declares.
- ai-memory setup, verification, backup, and Claude compatibility utilities.
- The free `appllama-app-design-skill` for mobile UI work, with no MCP required.
- Tests and CI for all executable behavior.

This boundary follows the practical argument in
[“Harness, Loop Engineering, Graph Engineering Are Bullshit”](https://akitaonrails.com/en/2026/08/18/hot-take-harness-loop-engineering-graph-engineering-are-bullshit/):
tests, review, CI, clean code, and supervised iteration are ordinary software
engineering; orchestration is justified only for genuinely independent work.

## Install

```bash
git clone git@github.com:alexdlli/my-configs.git ~/Developer/my-configs
cd ~/Developer/my-configs
node scripts/install.mjs
```

The installer links `~/.claude/{harness,hooks}`, merges the small permission/hook
slice into Claude settings, and installs the OpenCode guard. Re-running it removes
the retired agent links and default-agent setting when they were installed by this
repository.

Use `node scripts/install.mjs --dry-run` to inspect the result and
`node scripts/install.mjs --uninstall` to remove managed artifacts.

## Layout

```
.claude/
  hooks/                 # auto-update, session-context, destructive guard
  skills/                # Appllama mobile design skill and references
  settings.json          # permissions and hook registrations
.opencode/
  plugin/guard-destructive.js
  opencode.json          # owned permission rules only
scripts/
  install.mjs
  setup-ai-memory.mjs
  verify-ai-memory.mjs
  backup-ai-memory.mjs
  claude-openai-shim.mjs
docs/
  installation.md
  usage.md
  contributing.md
  guard-destructive.md
  integrations/
```

The previous orchestration system remains available in git history.
