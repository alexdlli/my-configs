# ai-memory

[`akitaonrails/ai-memory`](https://github.com/akitaonrails/ai-memory) — long-term memory for AI coding agents. A git-versioned markdown wiki that survives the agent you happened to be using.

## TL;DR

Long sessions become long amnesia: you re-explain the architecture, the dead ends, and the gotchas every time you open a fresh session or switch agents. ai-memory captures every prompt, tool call, and session boundary, compiles them into small readable wiki pages, and prepends a "where you left off" handoff at the start of the next session. The wiki is plain markdown in a git repo — `grep`-able, openable in Obsidian, `rsync`-backable; SQLite is only a derived index.

Two ideas from the [article that prompted this](https://akitaonrails.com/en/2026/06/16/ai-memory-long-term-memory-karpathy-wiki-self-improvement-hermes-projects/): the **Karpathy LLM Wiki** (compile knowledge into stable queryable pages, don't retrieve over raw logs) and **Hermes-style auto-improve** (a background job reviews completed sessions, promotes durable lessons into the wiki with validation + an audit trail).

## How it's wired here — `claude-sub` (default)

The goal was to power ai-memory's LLM work (consolidation + auto-improve) with the **Claude subscription** rather than a paid API key, but through a *sanctioned* mechanism. ai-memory itself only ships two Claude options: `anthropic` (paid key) and `anthropic-oauth` (raw OAuth token spoofed against `/v1/messages` — unofficial, against ToS, fragile). Neither is what we want.

So this harness adds a small bridge:

```
[Claude Code session] --hooks/MCP--> [ai-memory server (Docker, loopback)]
                                          |  openai-compat provider
                                          v
                          http://host.docker.internal:8787/v1
                                          |
                              [claude-openai-shim.mjs]  (LaunchAgent, always running)
                                          |  shells out to
                                          v
                                  `claude -p` (your Claude subscription)
```

- **`scripts/claude-openai-shim.mjs`** — a zero-dependency OpenAI-compatible server (`/v1/chat/completions`, `/v1/models`, `/healthz`). It shells out to `claude -p --output-format json` and **strips `ANTHROPIC_API_KEY`** from the child env so the call uses your subscription, not pay-as-you-go billing. This is the same idea as the "claude CLI" backend in your `ghprai`, exposed as an HTTP endpoint ai-memory can talk to.
- **LaunchAgent** (`com.my-configs.claude-openai-shim`) keeps the shim running on login/boot, so memory works in *every* Claude Code session, not just the one where you ran setup.
- **ai-memory server** — Docker on loopback (`127.0.0.1:49374`), `openai-compat` provider pointed at the shim, model `claude-haiku-4-5` (its LLM work is summarisation/classification, so a Haiku-class model is plenty and easiest on subscription rate limits).
- **Claude Code wiring** — `install-mcp` (so the agent can call `memory_query` / `memory_recent` / `memory_handoff_accept`), `install-hooks` (lifecycle capture), `install-instructions --skills-scope global` (the routing block bracketed by `<!-- ai-memory:start -->` / `<!-- ai-memory:end -->` in `CLAUDE.md`/`AGENTS.md`, **plus** ai-memory's managed Agent Skills). The scope flag is deliberate: since 1.18.0 that command also installs skills, and its default (`project`) would write them into the repo's own `.claude/skills/` — the directory `install.mjs` links one entry at a time exactly so that no tool takes the shared namespace over. `global` sends them to `~/.claude/skills/` instead, where they sit beside the harness's own links as five `ai-memory-*` entries. ai-memory merges these idempotently and preserves unrelated config, and this harness's `install.mjs` is symmetric: it only appends the hook entries declared in the harness's own `.claude/settings.json` (today `SessionStart` → `auto-update.mjs`, `UserPromptSubmit` → `orchestrator-reminder.mjs`, `PreCompact` → `preserve-orchestrator.mjs`) and never rewrites or removes an entry it did not add. Both sides therefore register a `SessionStart` hook on the same event and both run.

### Why this path is the sanctioned one (and the caveat)

Anthropic's [Claude Code legal/compliance doc](https://code.claude.com/docs/en/legal-and-compliance) says the OAuth token is "intended exclusively... to support ordinary use of Claude Code and other native Anthropic applications," and that developers (incl. Agent SDK) building products for *their users* should use API keys. Hitting `/v1/messages` directly with a spoofed token (ai-memory's `anthropic-oauth`) is exactly the disfavoured pattern. Going through `claude -p` is different: Anthropic's [support article 15036540](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) states (Update June 15, 2026) that **"Claude Agent SDK, `claude -p`, and third-party app usage still draw from your subscription's usage limits."**

⚠️ **This is in flux.** That same article describes a (now *paused*) plan to move Agent SDK / `claude -p` usage *off* subscription limits onto a separate monthly credit (Pro $20 / Max 5x $100 / Max 20x $200). Anthropic said they'll announce before anything takes effect. If that lands, `claude-sub` would start drawing from the credit (or stop once exhausted) rather than your normal limits — at which point switch to `--provider anthropic` with a key. Treat `claude-sub` as "works today, watch the policy."

## Install

Prerequisites: Docker Desktop, Node.js 24+ (the harness installer requires it), and the `claude` CLI **logged into your subscription** (`claude` once interactively). Make sure `ANTHROPIC_API_KEY` is **not** exported in your shell, or Claude Code/the shim would bill the API instead of the subscription.

```bash
cd ~/Developer/my-configs
node scripts/setup-ai-memory.mjs --dry-run    # preview every command
node scripts/setup-ai-memory.mjs              # claude-sub (default)
```

Verify:

```bash
node scripts/verify-ai-memory.mjs    # the whole chain, end to end (see below)
```

Then open a new Claude Code session — the SessionStart hook fetches any pending handoff before your first prompt.

## Providers (`--provider`)

| Provider | What it uses | Notes |
|---|---|---|
| `claude-sub` *(default)* | Your Claude subscription via the local `claude -p` shim | Sanctioned CLI path; policy in flux (see above). Needs `claude` logged in, no `ANTHROPIC_API_KEY`. |
| `anthropic` | Paid Platform API key | `ANTHROPIC_API_KEY` in env. Fully supported, ~$0.01–0.05/session with Haiku. |
| `anthropic-oauth` | Raw OAuth token vs `/v1/messages` | **Unofficial / against ToS.** Fragile. Avoid unless you accept the ban risk. |
| `local` | Ollama / LM Studio | `openai-compat` → `host.docker.internal:11434/v1`. Free, local, zero ToS risk. Pull the model first. |
| `none` | Zero-LLM | FTS5 search + rule-based summaries + handoffs. No auto-improve. |

```bash
node scripts/setup-ai-memory.mjs --provider anthropic   # ANTHROPIC_API_KEY set
node scripts/setup-ai-memory.mjs --provider local --model qwen3:8b
node scripts/setup-ai-memory.mjs --provider none
```

## Day to day

Hooks capture sessions; SessionStart fetches the pending handoff. Useful prompts: "where did we leave off?", "have we discussed X?" / "search memory for Y", "catch me up", "save a permanent note that we standardised on X". Adopt a pre-existing repo:

```bash
cd <repo> && ai-memory bootstrap --dry-run   # see what would be sent
cd <repo> && ai-memory bootstrap
```

Per-project isolation is by construction (`<wiki>/<workspace>/<project>/…`, keyed off `basename($cwd)`). Drop a `.ai-memory.toml` marker to override workspace/project for monorepos, worktrees, or work/personal splits.

## Checking the install — `scripts/verify-ai-memory.mjs`

Read-only end-to-end check of the whole chain, for when memory "stops working" and you need to know *which* link broke. It never writes to the wiki and never touches Docker or LaunchAgent state (`ai-memory bootstrap` is run with `--dry-run`, i.e. collect-and-estimate only).

```bash
node scripts/verify-ai-memory.mjs           # human-readable checklist
node scripts/verify-ai-memory.mjs --json    # same results as JSON
```

What it checks:

| Check | Passes when |
|---|---|
| ai-memory container | the container exists and is running |
| LLM backend | the backend the **server is actually configured with** answers. The provider is read from the container's own `AI_MEMORY_LLM_*` env, so `claude-sub` is checked against the shim's `/healthz`, `local` against Ollama's `/v1/models`. `anthropic`/`anthropic-oauth` have no local endpoint and are skipped; a zero-LLM install has no backend to check |
| LLM model | the configured model is the one the backend serves (Ollama: actually pulled) |
| ai-memory version | the running container reports a version **and** still runs the image `akitaonrails/ai-memory:latest` points at. A mismatch warns, because `ai-memory upgrade` pulls the new image without recreating the container — see [Upgrade](#upgrade--uninstall) |
| `ai-memory status` | the server answers and reports the provider the container was started with |
| `bootstrap --dry-run` | the server can collect sources — proves it reaches the LLM backend |
| Wiki git history | `/data/wiki` has commits, i.e. capture is being committed |
| Staged hooks | `~/.claude/settings.json` still points at ai-memory lifecycle hooks and every script it names is on disk and executable. Nothing is captured without them, however healthy the server is |
| Managed skills | the `ai-memory-*` Agent Skills are installed **globally** (`~/.claude/skills/`). Finding them project-scoped in the repo's own `.claude/skills/` fails the check: that directory belongs to the harness installer |

The last two checks are client-side and run even when the container is down — a healthy server whose hooks got unstaged is exactly the silent failure this script exists to name.

Exit codes: `0` all applicable checks passed · `1` something failed · `2` nothing failed but a prerequisite was missing (no docker, no CLI, no container, no agent settings) so part of the setup was **not verified** — the summary line names exactly what went unchecked. An unverified setup never reports success.

Env overrides (only needed when the local container is not the source of truth, e.g. a remote or native deploy): `AI_MEMORY_CONTAINER`, `AI_MEMORY_REPO`, `AI_MEMORY_IMAGE`, `AI_MEMORY_LLM_PROVIDER`, `AI_MEMORY_LLM_BASE_URL`, `AI_MEMORY_LLM_MODEL`, `CLAUDE_CONFIG_DIR`.

## Backups — `scripts/backup-ai-memory.mjs`

The memory lives in the `ai-memory-data` Docker volume; `docker volume rm` or a dead disk takes all of it. This script dumps the volume (wiki + archive + index + config) to the host with rotation, and can install a LaunchAgent that repeats it at login/boot and once a day at 12:00.

```bash
node scripts/backup-ai-memory.mjs             # one backup now
node scripts/backup-ai-memory.mjs --dry-run   # print the plan, change nothing
node scripts/backup-ai-memory.mjs --install   # write + load the LaunchAgent
node scripts/backup-ai-memory.mjs --uninstall # unload + remove it
```

Each run waits for the container to report healthy (up to 10 min), runs `ai-memory backup` *inside* it, copies the archive out to `~/ai-memory-backups/ai-memory-<YYYYMMDD>-<HHMMSS>.tar.gz`, removes the temporary archive from the volume (even when the copy fails), and prunes all but the newest 14. Restore with `ai-memory restore --from <archive>`.

Env overrides: `AI_MEMORY_CONTAINER`, `AI_MEMORY_BACKUP_DIR`, `AI_MEMORY_BACKUP_KEEP`. The LaunchAgent (`com.my-configs.ai-memory-backup`) logs to `<backup dir>/backup.log`.

## Getting the learning onto another computer (and keeping it synced)

The "learning" is the ai-memory data dir: the markdown **wiki** (git-versioned source of truth), the raw session archive, and the SQLite index (rebuildable from the wiki). Three ways to share it:

### 1. One shared server — true live sync (recommended)

Run **a single** ai-memory server (homelab/NAS/always-on box) and make every computer a thin client — one brain, nothing to reconcile.

Server (LAN bind + token; for `claude-sub` the shim + `claude` login live on the server):

```bash
TOKEN=$(ai-memory generate-auth-token); echo "$TOKEN"   # save this
docker run -d --name ai-memory --restart unless-stopped \
  -p 0.0.0.0:49374:49374 -v ai-memory-data:/data \
  -e AI_MEMORY_AUTH_TOKEN="$TOKEN" \
  -e AI_MEMORY_ALLOWED_HOSTS="<server-ip>,localhost,127.0.0.1" \
  -e AI_MEMORY_LLM_PROVIDER=openai-compat \
  -e AI_MEMORY_LLM_BASE_URL=http://host.docker.internal:8787/v1 \
  -e AI_MEMORY_LLM_MODEL=claude-haiku-4-5 \
  akitaonrails/ai-memory:latest
```

Every other computer — no local server, no Docker, no shim:

```bash
export AI_MEMORY_SERVER_URL="http://<server-ip>:49374"
export AI_MEMORY_AUTH_TOKEN="<token>"      # add both to your shell rc
cd ~/Developer/my-configs
node scripts/setup-ai-memory.mjs --provider none --no-server
```

`--no-server` skips the container; `install-mcp`/`install-hooks` inherit those two env vars and wire Claude Code to the remote server. Reach it off-LAN via Tailscale/WireGuard or a TLS reverse proxy; any non-loopback bind **must** have a bearer token.

### 2. Backup / restore — one-time migration

```bash
ai-memory backup --to ~/ai-memory-backup.tar.gz     # old machine
ai-memory restore --from ~/ai-memory-backup.tar.gz  # new machine
```

### 3. Git-sync the wiki — DIY, eventual consistency

The wiki is a git repo inside the data volume; push to a private remote and pull elsewhere, re-indexing on each box. Fiddly (concurrent writers → conflicts, must re-index). Prefer option 1.

> Two layers sync separately: `git pull && node scripts/install.mjs` carries the harness (agents/hooks/config); the options above carry the captured memory. On each machine you run both.

## Upgrade / uninstall

```bash
ai-memory upgrade            # self-upgrade wrapper + pull image + re-stage hooks
cd <repo> && ai-memory install-instructions --skills-scope global   # refresh block + skills
ai-memory uninstall --apply  # remove only ai-memory-owned MCP/hooks/instructions
docker rm -f ai-memory       # stop + remove the server (data volume survives)

# remove the shim LaunchAgent (claude-sub):
launchctl unload ~/Library/LaunchAgents/com.my-configs.claude-openai-shim.plist
rm ~/Library/LaunchAgents/com.my-configs.claude-openai-shim.plist

node scripts/backup-ai-memory.mjs --uninstall   # remove the backup LaunchAgent

docker volume rm ai-memory-data   # destructive: erase all memory
```

`upgrade` refreshes the wrapper, the image and the staged hook scripts — it leaves the routing block and the managed skills at the version that wrote them. A release that changes either ships new text, so re-run `install-instructions --skills-scope global` (or `node scripts/setup-ai-memory.mjs`, which ends with exactly that) in each project whose block you want current. Never hand-edit between the markers: re-running replaces the marked region in place and would silently drop your edit.

## Troubleshooting

- **`ai-memory status` shows provider unhealthy / consolidation fails (claude-sub).** Check the shim: `curl -s localhost:8787/healthz` and `tail ~/.local/share/ai-memory/shim.err.log`. The shim needs `claude` in PATH and logged in.
- **It's billing my API instead of the subscription.** You have `ANTHROPIC_API_KEY` exported. Claude Code/the shim prefer the key over the subscription. Unset it (the shim strips it for its child, but your interactive `claude` login must also be subscription-auth).
- **Container can't reach the shim.** On Docker Desktop for Mac, `host.docker.internal` resolves to the host; the shim binds `127.0.0.1`. If a future Docker version blocks host-loopback access, re-run with the shim reachable on the bridge gateway, or run `local`/`anthropic` instead.
- **Shim didn't survive a reboot.** `launchctl list | grep claude-openai-shim`. Re-run the setup script to reinstall the LaunchAgent.

Full upstream docs: [`docs/install.md`](https://github.com/akitaonrails/ai-memory/blob/main/docs/install.md) · [`docs/usage.md`](https://github.com/akitaonrails/ai-memory/blob/main/docs/usage.md). Anthropic policy: [legal/compliance](https://code.claude.com/docs/en/legal-and-compliance) · [subscription + Agent SDK](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).
