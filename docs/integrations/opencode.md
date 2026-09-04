# OpenCode integration

The OpenCode surface is intentionally small.

| Source | Installed at | Purpose |
|---|---|---|
| `.opencode/plugin/guard-destructive.js` | `~/.config/opencode/plugin/` | destructive-command guard |
| `.opencode/opencode.json` | merged into `~/.config/opencode/opencode.json` | owned permission rules |

The harness does not install OpenCode agents or a `default_agent`. User MCP
servers, plugins, themes, and unrelated permission rules are preserved.

Run `node scripts/install.mjs --dry-run` to inspect the merge, then restart
OpenCode after installation because its configuration is loaded once per session.
