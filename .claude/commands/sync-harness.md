---
description: Force-update the claude-setup harness now (ignores the 6h throttle).
---

Run `node .claude/hooks/auto-update.mjs --force` in the current repo and report the output verbatim. The script enforces all the same safety checks as the SessionStart hook (must be on `main`, clean working tree, fast-forward only) — only the 6h throttle is bypassed.

If the script prints nothing, report "harness already in sync (no output)".
