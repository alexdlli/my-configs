# Installation

## Quick start

```bash
git clone git@github.com:alexdlli/my-configs.git ~/Developer/my-configs
cd ~/Developer/my-configs
node scripts/install.mjs
```

## What the installer does

When you run `node scripts/install.mjs`, it:

1. Creates symlinks:
   - `~/.claude/harness`  → `<repo>` (stable path to the checkout, so skills and hooks reach `scripts/**` without hardcoding a clone location)
   - `~/.claude/agents`   → `<repo>/.claude/agents`
   - `~/.claude/hooks`    → `<repo>/.claude/hooks`
   - `~/.claude/commands` → `<repo>/.claude/commands`
   - `~/.claude/skills/<name>` → one link **per entry**, never the directory itself (see below)
2. Deep-merges harness keys into `~/.claude/settings.json`:
   - `agent` (set to `"orchestrator"`)
   - `permissions.allow` (union with whatever's already there)
   - `permissions.deny` (union; blocks `gh pr merge`, `git push --force` and `git commit --no-verify` so merges and history rewrites stay a human decision — see the measured limits below)
   - every hook event declared in the harness `.claude/settings.json` (appended; hook commands rewritten to absolute paths so they fire regardless of session cwd). <!-- docs-count:hooks -->Five hooks ship today: `auto-update` and `session-context` on `SessionStart`, `orchestrator-reminder` on `UserPromptSubmit`, `preserve-orchestrator` on `PreCompact`, and `guard-destructive` on `PreToolUse`/`Bash` — the last one blocks the same three commands as the deny list, including the shell-wrapped form ([`guard-destructive.md`](guard-destructive.md))
3. Records what it added in `~/.claude/.my-configs-managed.json` so `--uninstall` can revert precisely.
4. Retracts what it added and the harness no longer declares — see below.

### Installing is not append-only

A skill removed from `.claude/skills/` (or from `EXTERNAL_SKILL_LINKS`) does not just stop being refreshed: on the next install its link is **removed** from `~/.claude/skills/`, and the metadata stops claiming it. The same already happened for `permissions.allow` / `permissions.deny` entries.

Without it, deleting a skill from the repo left a link behind that either dangled or — worse — kept resolving to a directory outside the checkout, so a `SKILL.md` for a tool the repo had just dropped went on routing work. Nothing warned about it.

The metadata is what makes this safe: only a link this installer is on record as having created is ever considered, and it is removed only when its current `readlink` still matches the recorded target. A name another toolkit took over in the meantime is reported and left where it is — including a recorded path that stopped being a symlink at all (another toolkit installed its own real directory over it): reported, never deleted. A link that was never ours is never even looked at.

`--dry-run` prints the removals as `→ would remove symlink …` and touches nothing.

**Declared is not the same as resolved.** Retraction keys on what the harness *declares*, never on what happened to resolve during that run. An `EXTERNAL_SKILL_LINKS` entry whose target is missing from disk is reported (`! external skill <name> not found at … — skipping (still declared, link left alone)`) and its existing link stays put; only removing the entry retracts it. Same reasoning one level up: an unreadable `<repo>/.claude/skills` **aborts** the install instead of being read as "the harness declares nothing", because that reading takes every skill link off the machine in a single run that exits 0.

**Retraction runs after the settings merge.** The merge can abort — see the `agent` conflict under [Conflicts](#conflicts) — and an install that exits non-zero must leave the machine as it found it: nothing removed from disk, no metadata written.

### Caveat: retraction is global to `$HOME`, decided by the checkout that runs

The metadata lives in `~/.claude/`, and every run compares it against whatever the *running* checkout declares. Two checkouts of this harness sharing one `$HOME` — a worktree, a second clone — therefore disagree about what is declared. Measured against a throwaway `$HOME`, with checkout A declaring `alpha` + `beta` and checkout B declaring only `alpha` (paths abbreviated):

```
$ node A/scripts/install.mjs
✓ symlinked ~/.claude/skills/alpha → A/.claude/skills/alpha
✓ symlinked ~/.claude/skills/beta  → A/.claude/skills/beta
$ node B/scripts/install.mjs
! ~/.claude/skills/alpha → A/.claude/skills/alpha (not ours) — skipping
✓ removed symlink ~/.claude/skills/beta
```

Installing from B retracted a skill A still declares, and left `alpha` pointing into A because that link is not B's to take over. Re-running the installer from A restores `beta` (measured), so this is recoverable, not destructive — but this repo runs worktrees by design, so **install from one checkout consistently**, and re-run it from that checkout after installing from another.

### What `permissions.deny` guarantees under `--dangerously-skip-permissions`

Measured on **Claude Code 2.1.220**, Node 24.15.0, macOS, **2026-07-27**, against a throwaway `$HOME` — never the real `~/.claude`.

**The deny list survives the bypass.** All four denied commands stayed blocked with `--dangerously-skip-permissions` on, across two settings layers and both ways of turning the bypass on. The promise above holds in the scenario it was written for: the autonomous agent with nobody watching the terminal.

**But `deny` is string matching, and the bypass removes the approval gate that used to be its backstop.** `Bash(gh pr merge *)` blocks `gh pr merge 3`; it never sees `bash -c "gh pr merge 3"`. Measured with a canary entry: under the bypass the wrapped form *ran*, while the same wrapped command without the bypass stopped at `This command requires approval`. The wrapper was being caught by the permission prompt, not by the deny list — so turning the prompt off is what exposes it.

**The `guard-destructive` hook closes that hole.** A `PreToolUse` hook on `Bash` returning `permissionDecision: "deny"` is still evaluated under the bypass (measured, not inferred), and this one blocks the literal *and* the wrapped form of all three commands. What it deliberately does not catch, and why, is in [`guard-destructive.md`](guard-destructive.md).

**Not measured:** subagent context, `deny` declared at user scope, and managed/policy settings. The first is the gap that matters — a session starts in `orchestrator` and delegates, so most of what an agent executes runs in a subagent.

Both layers live in the client, so both end at whoever controls the client. **Branch protection on GitHub remains the only guarantee that does not depend on this machine.**

### Why skills are linked one by one

`~/.claude/skills` is shared ground — plugins and other toolkits (argent, maestri, ...) install their skills there too. Symlinking the whole directory to the harness would hide every one of them, so the installer links each entry of `<repo>/.claude/skills` individually. The same mechanism exposes skills that live outside the harness, through `EXTERNAL_SKILL_LINKS` in `scripts/install.mjs` — empty today, but kept as the extension point; if the source of an entry is missing the installer says so and moves on, leaving any link it already installed alone.

A name that already exists in `~/.claude/skills` and is not one of our links is **reported and skipped** — never overwritten, never backed up.

Other keys in your `~/.claude/settings.json` (`theme`, `enabledPlugins`, `extraKnownMarketplaces`, anything custom) are left untouched.

## Flags

| Flag | Purpose |
|------|---------|
| (none) | Install or refresh (idempotent) |
| `--dry-run` | Print the plan without writing anything |
| `--uninstall` | Remove symlinks and revert merged keys |
| `--force-agent` | Override conflict if `~/.claude/settings.json` already has a different `agent` |
| `-h`, `--help` | Usage |

## Conflicts

**`~/.claude/agents`, `~/.claude/hooks`, `~/.claude/commands` or `~/.claude/harness` already exists as a real directory.**
The installer backs it up to `~/.claude/<name>.backup-<timestamp>` and proceeds. The message in the output points to the backup location. This does **not** apply to `~/.claude/skills` entries, which are only ever skipped.

**`~/.claude/settings.json` already has `agent` set to something other than `orchestrator`.**
The installer aborts with a clear message, before retracting anything. Re-run with `--force-agent` to overwrite, or remove the field manually.

**`<repo>/.claude/skills` is missing or unreadable.**
The installer aborts before touching the filesystem. Every checkout ships that directory, so an absent one is a damaged checkout — and reading it as "the harness declares no skills" would retract every skill link on the machine.

**Settings backups accumulate** (`~/.claude/settings.json.backup-<ts>`). Clean them with `rm ~/.claude/*.backup-*` once you're confident the install is stable.

## Update

```bash
cd ~/Developer/my-configs
git pull
node scripts/install.mjs
```

The installer is idempotent: running again refreshes the symlinks (no-op if already correct), re-runs the merge, retracts what the harness stopped declaring, and updates the metadata file.

### Automatic update on session start

`.claude/hooks/auto-update.mjs` runs as a `SessionStart` hook and keeps the checkout fresh for you. It is deliberately conservative:

- At most one check every 6 hours (cache file under `~/Library/Caches/claude-setup/last-check`, plus a PID lock next to it). A lock left behind by a killed session is detected via its PID and broken, so auto-update can't get stuck off.
- Only when the harness is on `main` with a clean working tree; it uses `git pull --ff-only`.
- Git runs non-interactively (`GIT_TERMINAL_PROMPT=0`, `ssh -oBatchMode=yes`), so a missing credential fails fast instead of hanging the session.
- Every failure path exits 0 — the hook never blocks a session.
- It never runs the installer. When the pulled diff touches `.claude/skills/` or `.claude/settings.json`, it prints a one-line reminder to run `node scripts/install.mjs` yourself.

Force a check now (bypasses only the 6h throttle): `/sync-harness`, or `node ~/.claude/hooks/auto-update.mjs --force`.

Opt out per-machine: `export CLAUDE_SETUP_SKIP_AUTOUPDATE=1`. It also self-skips when `CI` is set.

## Uninstall

```bash
node scripts/install.mjs --uninstall
```

Reads `~/.claude/.my-configs-managed.json` and reverts ONLY what the installer added — your `theme`, plugins, and unrelated permissions stay intact. Deletes the metadata file at the end.

Every link the installer created is recorded in the metadata as a `{path, target}` pair, and a link is removed only when its current `readlink` matches the recorded target exactly. A third-party entry that happens to share a name is left where it is. With no metadata file there is nothing to revert, and the uninstaller touches nothing.

Metadata written before this scheme (`version: 1`) has no link records; uninstalling one of those removes the only two links that version ever created (`agents` and `hooks`).

## Optional: ai-memory (long-term memory)

Separate from the agent harness, [ai-memory](https://github.com/akitaonrails/ai-memory) gives every coding agent a shared, git-versioned markdown wiki so context survives across sessions and across agents. The default `claude-sub` provider routes ai-memory's LLM work through a local `claude -p` shim so it uses your Claude subscription (sanctioned CLI path). Prerequisites: Docker Desktop, the `claude` CLI logged into your subscription, and no `ANTHROPIC_API_KEY` exported.

```bash
node scripts/setup-ai-memory.mjs --dry-run    # preview
node scripts/setup-ai-memory.mjs              # claude-sub (default)
# or: --provider anthropic | local | none
```

Full walkthrough, provider table, the in-flux subscription-policy caveat, and multi-machine sync: [`integrations/ai-memory.md`](integrations/ai-memory.md).

## Platform support

macOS only. Windows is not supported (`process.platform === 'win32'` exits with a friendly message). PRs welcome.

## Troubleshooting

**Hooks don't fire.** Check `cat ~/.claude/settings.json | jq '.hooks'`. The `command` strings should be absolute paths starting with `node /Users/<you>/.claude/hooks/`. If they're relative, re-run the installer.

**`/agents` doesn't show orchestrator.** Confirm `~/.claude/agents` is a symlink (`readlink ~/.claude/agents` should print the repo path) and that `~/.claude/settings.json` has `"agent": "orchestrator"`.

**Want a clean slate.** `--uninstall`, then delete any leftover `~/.claude/*.backup-*` files, then re-install.
