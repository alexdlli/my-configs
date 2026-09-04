# Contributing

Keep this repository smaller than the clients it configures.

## Design rule

Add something only when it solves a concrete, repeated, measured problem that
Claude Code or OpenCode does not already solve. Do not add default agents,
specialist rosters, forced delegation, graphs, ticket/spec pipelines, or ceremony
whose main output is more harness state.

Native client behavior is preferred. Tests, review, CI, and clean code remain the
validation loop.

## Layout

```
.claude/settings.json
.claude/hooks/
.claude/hooks/lib/
.opencode/opencode.json
.opencode/plugin/
scripts/
docs/
```

## Hooks

Hooks are registered in `.claude/settings.json` and implemented as Node.js stdlib
`.mjs` files. Add one only for recurring behavior that cannot live in ordinary
project code. Test it directly with a fake stdin payload and add unit coverage for
shared logic under `.claude/hooks/lib/`.

## Installer

The installer must preserve unrelated user settings and retract every managed
artifact that is no longer declared. A missing declaration source is an error, not
an empty declaration. Links are retracted only when their current target matches
the recorded target; permission and hook entries use the metadata described in the
tests.

Keep `--dry-run`, `--uninstall`, and `--help`. New behavior needs installation,
reinstallation, retraction, and uninstall coverage where applicable.

## Documentation inventory

`scripts/docs-inventory.test.mjs` checks hook and integration indexes plus count
markers. When a document states an inventory count, place
`<!-- docs-count:<name> -->` immediately before the number.

## Tests

```bash
node --check scripts/install.mjs
node --test 'scripts/*.test.mjs'
node --test '.claude/hooks/lib/*.test.mjs'
```

Never pass a directory to `node --test`; use a glob or explicit file paths.
Run an installer dry-run against a throwaway `HOME` before committing.

## Commit rules

- Never add an AI tool as commit co-author.
- A bug fix carries a test observed failing against the pre-fix code.
- Claims about external-tool behavior include version, platform, date, and the
  command used to measure it.
- Preserve unrelated worktree changes.
- No dead code, unnecessary duplication, magic values, or speculative abstractions.
- Update documentation when behavior changes.
