# EcoTokens

[`hansipie/ecotokens`](https://github.com/hansipie/ecotokens) — token optimizer for Claude Code, Gemini CLI, Qwen Code, and Pi.

## TL;DR

EcoTokens is a Rust binary that filters the output of shell commands and the results of native file tools (`Read`/`Grep`/`Glob`) before they reach the model, trimming what gets billed against your context window.

## Mecanismo

- External Rust binary. Not a Claude Code agent, plugin, or skill.
- Installs two hooks in `~/.claude/settings.json`:
  - `PreToolUse` — wraps `Bash` calls, runs the command, and applies a family-specific filter (git, cargo, python, jest, …) before returning output to the model.
  - `PostToolUse` — intercepts native `Read`/`Grep`/`Glob` results and applies outline-based compression for source files, grep trimming, and glob path denoising. This is the area RTK explicitly does **not** cover.
- Errors, failures, and stack traces are preserved; secrets are redacted before filtering (per upstream).
- Optional AI summarization via a local Ollama model (`ecotokens install --ai-summary`); off by default.
- Also registers an MCP server entry (`ecotokens mcp-server`) exposing search/outline/symbol/trace tools backed by a local BM25 + vector index.

See [upstream README](https://github.com/hansipie/ecotokens) for the full feature list. Numbers depend on workload.

## Versus RTK

EcoTokens covers `Read`/`Grep`/`Glob` natives that RTK explicitly leaves alone, and supports multiple agents (Claude Code, Gemini CLI, Qwen Code, Pi). Community is much smaller (~11 stars at time of writing vs RTK ~45k) and the project is younger. RTK has [issue #582](https://github.com/rtk-ai/rtk/issues/582) reporting net cost regression from re-reading truncated outputs; I have not seen an equivalent complaint on EcoTokens, but the sample is much smaller too — adopt with measurement, not faith.

## Install

```bash
# Requires Rust toolchain (1.75+). If missing: rustup default stable
cargo install --git https://github.com/hansipie/ecotokens

# Install hooks + MCP server entry into ~/.claude/settings.json
ecotokens install

# Sanity check
ecotokens --version
ecotokens gain --history
```

For exact tiktoken-based counting (instead of the default char heuristic):

```bash
cargo install --git https://github.com/hansipie/ecotokens --features exact-tokens
```

## Coexistence with this harness

- `scripts/install.mjs` only manages `UserPromptSubmit` and `PreCompact` hooks. EcoTokens lives under `PreToolUse` / `PostToolUse` — different slots, no overlap.
- EcoTokens hook entries are written by `ecotokens install` directly into `~/.claude/settings.json`. They have their own command names, so they will not collide with `orchestrator-reminder.mjs` or `preserve-orchestrator.mjs`.
- `node scripts/install.mjs --uninstall` does **not** touch EcoTokens. Use `ecotokens uninstall` for that.
- Reinstalling this harness after EcoTokens is safe: the merge in `install.mjs` is whitelisted to specific keys/hook slots, so the `PreToolUse` / `PostToolUse` entries EcoTokens wrote are preserved.
- EcoTokens also adds an `mcpServers.ecotokens` entry to `~/.claude/settings.json`. This harness's installer does not manage `mcpServers`, so it will not be removed on `--uninstall`.

## Dependencies and caveats

- Rust toolchain (1.75+). `cargo install` builds from source; no Homebrew bottle today.
- The code-intelligence index (Candle, BM25 + embeddings) downloads a model on first run. Confirm you have disk headroom if your `$HOME` is constrained.
- Ollama is **opt-in**. Only needed if you pass `--ai-summary` at install time. Adds local memory + latency cost.
- Configuration lives at `~/.config/ecotokens/config.json`.

## Limits

- Small community (~11 stars at the time this doc was written); maturity is below RTK.
- No prebuilt binary — `cargo install` is the only documented path. RTK has a Homebrew formula for the same audience.
- If something breaks on upgrade, the fallback is `ecotokens uninstall` and measure raw cost again before debugging.

## Combinations

- EcoTokens + cavecrew agents — orthogonal. Cavecrew tunes the input/persona side (cheap models, terse prompts); EcoTokens tunes the tool-output side. They stack.
- EcoTokens + RTK — redundant on the `Bash` path. Both filter shell output via `PreToolUse`. Pick one.
- EcoTokens + the compact-flag conventions in [`CLAUDE.md`](../../CLAUDE.md#token-saving-conventions) — synergic. Compact flags reduce output before the filter even sees it; less work for EcoTokens, fewer corner cases.

## Useful commands

```bash
ecotokens gain                  # interactive TUI: savings by family / project
ecotokens gain --history        # 24h / 7d / 30d table
ecotokens gain --json           # machine-readable
ecotokens filter -- <cmd>       # run a command directly through the filter (testing)
ecotokens config --debug true   # toggle debug logging
```

## Uninstall

```bash
ecotokens uninstall
cargo uninstall ecotokens   # optional: drop the binary
```
