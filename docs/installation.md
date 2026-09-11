# Installation

## Quick start

```bash
git clone git@github.com:alexdlli/my-configs.git ~/Developer/my-configs
cd ~/Developer/my-configs
node scripts/install.mjs
```

macOS and Linux are supported by the installer; the surrounding personal setup is
tested on macOS.

## What it installs

Claude Code:

- `~/.claude/harness` and `~/.claude/hooks` symlink to this checkout.
- The permission allow/deny entries in `.claude/settings.json` are appended.
- Hook registrations are appended with absolute installed paths.

The harness ships <!-- docs-count:hooks -->three hooks: `auto-update`,
`session-context`, and `guard-destructive`.

OpenCode:

- Entries under `.opencode/plugin/` are linked individually.
- Owned `permission.bash` rules are merged into the user's config.

The installer links `appllama-app-design-skill` into `~/.claude/skills/` and
`~/.agents/skills/`. It provides mobile UI guidance for Expo / React Native and
works without the paid Appllama MCP. See [Appllama](integrations/appllama.md).

No agents, default-agent setting, or commands are installed.
A migration run retracts the retired links, hooks, permission entries, and default
agent when metadata proves this installer added them.

## Commands

```bash
node scripts/install.mjs
node scripts/install.mjs --dry-run
node scripts/install.mjs --uninstall
node scripts/install.mjs --help
```

Install and uninstall preserve unrelated user configuration. Before writes, the
installer creates timestamped settings backups.

## Updating

The session-start hook checks for updates with a throttle. A manual update is:

```bash
cd ~/Developer/my-configs
git pull
node scripts/install.mjs
```

## ai-memory

ai-memory is optional and independent:

```bash
node scripts/setup-ai-memory.mjs
node scripts/verify-ai-memory.mjs
```

See [`integrations/ai-memory.md`](integrations/ai-memory.md).

## Troubleshooting

If an install target already exists and is not managed by this repository, the
installer reports and preserves it. Use `--dry-run` to see the exact plan.

The destructive guard's measured guarantees and limits are documented in
[`guard-destructive.md`](guard-destructive.md).
