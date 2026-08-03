# AGENTS.md

**The canonical instructions for this repo are in [`CLAUDE.md`](CLAUDE.md). Read that file, in full, before writing or modifying anything here.**

This file exists only because some agents (Codex, OpenCode, Cursor, Gemini CLI) look for `AGENTS.md` and never open `CLAUDE.md`. It deliberately holds no copy of the instructions: it used to be a byte-for-byte duplicate of `CLAUDE.md`, and a duplicate is how two instruction files come apart in silence — the copy is correct right up to the moment someone edits one side, and nothing fails when the two disagree. A pointer cannot drift.

The one thing this file owns is generated: `ai-memory install-instructions` writes its routing block into whichever of `CLAUDE.md` / `AGENTS.md` exists, into both when both do, bracketed by `<!-- ai-memory:start -->` / `<!-- ai-memory:end -->`. Never edit that block by hand — re-run the command instead.
