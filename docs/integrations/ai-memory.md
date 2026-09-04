# ai-memory

[`akitaonrails/ai-memory`](https://github.com/akitaonrails/ai-memory) — long-term memory for AI coding agents. A git-versioned markdown wiki that survives the agent you happened to be using.

## TL;DR

Long sessions become long amnesia: you re-explain the architecture, the dead ends, and the gotchas every time you open a fresh session or switch agents. ai-memory captures every prompt, tool call, and session boundary, compiles them into small readable wiki pages, and prepends a "where you left off" handoff at the start of the next session. The wiki is plain markdown in a git repo — `grep`-able, openable in Obsidian, `rsync`-backable; SQLite is only a derived index.

Two ideas from the [article that prompted this](https://akitaonrails.com/en/2026/06/16/ai-memory-long-term-memory-karpathy-wiki-self-improvement-hermes-projects/): the **Karpathy LLM Wiki** (compile knowledge into stable queryable pages, don't retrieve over raw logs) and **Hermes-style auto-improve** (a background job reviews completed sessions, promotes durable lessons into the wiki with validation + an audit trail).

## How it's wired here — subscription providers

The default is `codex-sub`: ai-memory's native `openai-oauth` provider uses the logged-in ChatGPT/Codex subscription directly. The Claude shim below remains available as an explicit fallback via `--provider claude-sub`; it is no longer started by a default install.

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

- **`scripts/claude-openai-shim.mjs`** — a zero-dependency OpenAI-compatible server (`/v1/chat/completions`, `/v1/models`, `/healthz`) used only by `claude-sub`. It shells out to `claude -p` and strips `ANTHROPIC_API_KEY` so the CLI uses the logged-in subscription instead of pay-as-you-go API billing.
- **LaunchAgent** (`com.my-configs.claude-openai-shim`) keeps the shim running on login/boot, so memory works in *every* Claude Code session, not just the one where you ran setup.
- **ai-memory server** — Docker on loopback (`127.0.0.1:49374`), `openai-compat` provider pointed at the shim, model `claude-haiku-4-5` (its LLM work is summarisation/classification, so a Haiku-class model is plenty and easiest on subscription rate limits).
- **Claude Code wiring** — `install-mcp` (so the agent can call `memory_query` / `memory_recent` / `memory_handoff_accept`), `install-hooks` (lifecycle capture), and `install-instructions --skills-scope global` (the managed routing block plus ai-memory's skills). The global scope keeps those skills outside this repository. Both installers merge their own entries idempotently and preserve unrelated configuration.

### Why this path is the sanctioned one (and the caveat)

Anthropic's [Claude Code legal/compliance doc](https://code.claude.com/docs/en/legal-and-compliance) says the OAuth token is "intended exclusively... to support ordinary use of Claude Code and other native Anthropic applications," and that developers (incl. Agent SDK) building products for *their users* should use API keys. Hitting `/v1/messages` directly with a spoofed token (ai-memory's `anthropic-oauth`) is exactly the disfavoured pattern. Going through `claude -p` is different: Anthropic's [support article 15036540](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) states (Update June 15, 2026) that **"Claude Agent SDK, `claude -p`, and third-party app usage still draw from your subscription's usage limits."**

⚠️ **This is in flux.** That same article describes a (now *paused*) plan to move Agent SDK / `claude -p` usage *off* subscription limits onto a separate monthly credit (Pro $20 / Max 5x $100 / Max 20x $200). Anthropic said they'll announce before anything takes effect. If that lands, `claude-sub` would start drawing from the credit (or stop once exhausted) rather than your normal limits — at which point switch to `--provider anthropic` with a key. Treat `claude-sub` as "works today, watch the policy."

## Install

Prerequisites for the default path: Docker Desktop, Node.js 24+ (the harness installer requires it), and an OpenAI OAuth login created once with `ai-memory auth login openai-oauth`. The Claude CLI is needed only for the explicit `claude-sub` fallback.

```bash
cd ~/Developer/my-configs
node scripts/setup-ai-memory.mjs --dry-run    # preview every command
node scripts/setup-ai-memory.mjs              # codex-sub (default)
```

Verify:

```bash
node scripts/verify-ai-memory.mjs    # the whole chain, end to end (see below)
```

Then open a new Claude Code session — the SessionStart hook fetches any pending handoff before your first prompt.

## Providers (`--provider`)

| Provider | What it uses | Notes |
|---|---|---|
| `codex-sub` *(default)* | Native ai-memory `openai-oauth` provider using your ChatGPT/Codex subscription | Run `ai-memory auth login openai-oauth` once. No `OPENAI_API_KEY`; uses ai-memory's supported default `gpt-5.5`. |
| `claude-sub` | Your Claude subscription via the local `claude -p` shim | Sanctioned CLI path; policy in flux (see above). Needs `claude` logged in, no `ANTHROPIC_API_KEY`. |
| `anthropic` | Paid Platform API key | `ANTHROPIC_API_KEY` in env. Fully supported, ~$0.01–0.05/session with Haiku. |
| `anthropic-oauth` | Raw OAuth token vs `/v1/messages` | **Unofficial / against ToS.** Fragile. Avoid unless you accept the ban risk. |
| `local` | Ollama / LM Studio | `openai-compat` → `host.docker.internal:11434/v1`. Free, local, zero ToS risk. Pull the model first. |
| `none` | Zero-LLM | FTS5 search + rule-based summaries + handoffs. No auto-improve. |

```bash
node scripts/setup-ai-memory.mjs                         # ChatGPT/Codex subscription
node scripts/setup-ai-memory.mjs --provider claude-sub  # Claude subscription fallback
node scripts/setup-ai-memory.mjs --provider anthropic   # ANTHROPIC_API_KEY set
node scripts/setup-ai-memory.mjs --provider local --model qwen3:8b
node scripts/setup-ai-memory.mjs --provider none
```

## Day to day

The container is capped at 2 CPUs and 3 GB RAM by default so it cannot crowd out Metro, Android Studio, Xcode, or other repositories (3 GB rather than 2 since 2.0, because the default local embedder runs in-process — see below). Override only when needed with `AI_MEMORY_DOCKER_CPUS` and `AI_MEMORY_DOCKER_MEMORY` (Docker memory syntax such as `4g`). Docker automatically selects the native ARM64 image on Apple Silicon; no hard-coded platform flag is needed.

Since 2.0, local embeddings are on by default: the server downloads `all-MiniLM-L6-v2` (~87 MB, sha-pinned, stored in `/data/models`) on first start, backfills existing pages in the background, and hybrid FTS+vector search activates on the next restart. No API key, no GPU. Opt out with `embedding_provider = "none"` if a machine cannot afford the model.

Hooks capture sessions; SessionStart fetches the pending handoff. Useful prompts: "where did we leave off?", "have we discussed X?" / "search memory for Y", "catch me up", "save a permanent note that we standardised on X". Adopt a pre-existing repo:

```bash
cd <repo> && ai-memory bootstrap --dry-run   # see what would be sent
cd <repo> && ai-memory bootstrap
```

Per-project isolation is by construction (`<wiki>/<workspace>/<project>/…`, keyed off `basename($cwd)`). Drop a `.ai-memory.toml` marker to override workspace/project for monorepos, worktrees, or work/personal splits.

Reads default to the current project, and every default-scoped read also returns hits from **`_global`** — a reserved scope for standing preferences that hold everywhere ("always use pnpm", "never force-push"). Write one with `memory_write_page` and `scope: "global"`; it will surface in every project as `global_scope_hits`, so a preference is stated once instead of copied into each project's wiki.

## Managed runs and workstreams — `ai-memory run`

Hooks capture whatever session you happen to open. `ai-memory run` launches the agent itself, so the session is born inside a named **workstream** and gets the complete visible-event ledger that the plain hook path — sanitized, bounded observations — cannot produce.

```bash
ai-memory run claude                              # continue the newest managed session here
ai-memory run claude --new refactor-hooks         # create and select a fresh workstream
ai-memory run claude --workstream refactor-hooks  # rejoin an existing one
ai-memory run claude --fresh                      # new native session inside the selected workstream
```

Harnesses: `claude`, `codex`, `opencode`, `pi`, `crush`, `omp`, `kimi`, `grok`, `antigravity`. Only the wrapper's own flags are consumed (`--new`, `--workstream`, `--fresh`, `--yolo`, `--workspace`, `--project`, `--executable`); every other argument is forwarded to the harness byte-for-byte and in order.

A workstream runs one agent at a time, enforced by a lease the launcher renews while the process is alive. A run whose lease lapses is marked `expired`, so an agent that dies without cleaning up does not park the workstream forever.

Inside a managed run, the ledger is searchable:

```bash
ai-memory workstream-search "install retraction" --limit 50 --json
```

`--workstream-id` defaults to `AI_MEMORY_WORKSTREAM_ID`, which managed child processes already carry, so you never pass it by hand from inside a run.

### `run` is a different binary from the rest

`run` is the one command the Docker wrapper cannot serve from a container — native harnesses and their transcript stores are host resources. The wrapper intercepts `run` before any Docker work and `exec`s a native client out of `~/.cache/ai-memory/native-runner/` (macOS/Linux, x86_64/arm64). Three consequences:

- **The version depends on the path.** Measured 2026-09-04 (both 2.0.2 after the migration; before it, the container answered 1.25.0 while the runner had self-updated to 1.38.0). `verify-ai-memory.mjs` now compares the two: a mixed major fails the check — upstream does not support it, and a pre-2.0 binary refuses a migrated data dir — while same-major drift warns. Ask them by hand with `ai-memory --version` vs `~/.cache/ai-memory/native-runner/ai-memory --version`.
- **The download is unconditional and unprompted.** `curl` from `https://github.com/akitaonrails/ai-memory/releases/latest/download/` (sha256 verified) whenever the binary or the tarball is missing, plus once a day when the published sha256 differs from the cached one — 11 MB compressed, 24 MB installed. The binary is resolved before the arguments are read, so even `ai-memory run --help` can trigger it. `AI_MEMORY_NATIVE_BIN` points at a binary you supply and skips the download entirely — it is the **only** real pin: `AI_MEMORY_NO_VERSION_CHECK` silences the outdated-version warning but does not stop this download (measured 2026-09-04 against the 2.0.2 wrapper).
- **The environment crosses over whole.** A plain `exec`, no `env -i` and no filtering: it adds `AI_MEMORY_WORKSTREAM_ID`, `AI_MEMORY_HOOK_URL` and `AI_MEMORY_RUN_ID` and removes nothing. So inside a managed run `session-context.mjs` still reports `host: "maestri"`. The env allowlist in the wrapper belongs to the Docker path, which `run` never reaches.
- **Host-writing subcommands have their own version, too.** The wrapper serves `install-mcp` / `install-hooks` / `install-instructions` from an ephemeral client container chosen by `AI_MEMORY_IMAGE` (default `:latest`), not from the running server. `setup-ai-memory.mjs` pins that variable to the same release it installs, so the wiring can never come from a stale cached `:latest` (measured 2026-09-04: a 1.25 cache wired a 2.0 server until the pin).

## Parallel sessions (Maestri)

2.0 keeps concurrent agents on the same project apart natively: the current-project pointer is **per actor** (resolved from each session's own directory), concurrent writes to one page stack as a version chain instead of overwriting, and a handoff has a single owner — a second `accept` cannot steal it. So a team of agents recruited on the Maestri canvas needs no scoping arguments at all; what it needs is each agent to be born as its own actor:

- Launch each recruited agent through the managed launcher, one workstream per agent, never shared (the lease admits one live run per workstream):

  ```bash
  ai-memory run claude --new <ticket-or-task-name>
  ```

- Each Maestri floor is a git clone in its own directory, so directory-based resolution gives every agent the right per-actor context for free. Floors share the repo's basename, which means they all resolve to the **same project** — that is the point (shared project memory); drop a `.ai-memory.toml` in a clone only if some floor must not share.
- The static-MCP session-id caveat in the managed routing block is about clients *not* launched this way; `run` sidesteps it, so don't wire anything extra for it.

## Per-project behaviour — `.ai-memory.toml`

Beyond pinning workspace/project, the marker tunes what gets captured and injected:

| Key | Effect |
|---|---|
| `[briefing] inject_on_session_start` | inject the project brief into the agent's context at SessionStart, alongside the pending handoff |
| `[briefing] max_chars` | cap that injection; the block says so in place when it truncates |
| `[capture] ignore_paths` | glob patterns, resolved against the directory holding the marker, whose files never reach capture — the place to keep secrets, fixtures and vendored trees out of the wiki |
| `default_global` | make plain reads search every project by default instead of only the current one |

`[capture]` is parsed as a real TOML table, and `ignore_paths` must be its first key or the whole marker is rejected as invalid. The briefing and recall keys are matched by name anywhere in the file, so their section headers are documentation for the reader rather than parser input.

## Managed Agent Skills — `install-skills`

Since 1.18.0, ai-memory ships its own routing as five Agent Skills (`ai-memory-retrieval`, `ai-memory-handoff`, `ai-memory-durable-pages`, `ai-memory-learning-maintenance`, `ai-memory-routing-install`) instead of one long block of instructions. `install-instructions` installs them as a side effect; `install-skills` is the same job on its own:

```bash
ai-memory install-skills --print --scope global   # preview the paths and bodies
ai-memory install-skills --scope global           # ~/.claude/skills/ai-memory-*
```

`--scope project` writes into the repo's own `.claude/skills/` — **not** what this harness wants, because `install.mjs` owns that directory. Without `--force`, a same-named skill that lacks ai-memory's managed marker is preserved and the command exits with an error rather than overwriting it; `--agent` selects the directory family (`claude-code`, `agents`, `devin`, `grok`, `both`).

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
| ai-memory version | the running container reports a version **and** still runs the image the pinned tag points at. A mismatch warns, because `ai-memory upgrade` pulls the new image without recreating the container — see [Upgrade](#upgrade--uninstall) |
| Native runner version | the client behind `ai-memory run` matches the container. A different major fails (unsupported upstream — the runner self-updates daily and can jump a major on its own); same-major drift warns — see [`run` is a different binary](#run-is-a-different-binary-from-the-rest) |
| `ai-memory status` | the server answers and reports the provider the container was started with |
| Provider health | judged from the structured provider block in `status --json` (a recorded error message or an unhealthy status; `unknown` just means no call yet). The old text-grep heuristic remains only as a fallback for unparseable output |
| `bootstrap --dry-run` | the server can collect sources — proves it reaches the LLM backend |
| Wiki git history | `/data/wiki/.git` exists and carries no freeze signature (zero-size loose objects or libgit2 parse errors in the container log — the silent failure measured 2026-08). The container has no git CLI, so history itself cannot be read from outside |
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

Env overrides: `AI_MEMORY_CONTAINER`, `AI_MEMORY_BACKUP_DIR`, `AI_MEMORY_BACKUP_KEEP`. The installer persists the resolved backup directory and retention in the LaunchAgent, so scheduled runs use the same values even though they do not inherit your interactive shell environment. The LaunchAgent (`com.my-configs.ai-memory-backup`) logs to `<backup dir>/backup.log`.

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
  akitaonrails/ai-memory:2.0.2   # keep in lockstep with AI_MEMORY_VERSION in setup-ai-memory.mjs
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

Image and wrapper are pinned to one release (`AI_MEMORY_VERSION` in `setup-ai-memory.mjs`, mirrored in `verify-ai-memory.mjs`) — upstream enforces SemVer since 2.0 and mixed versions are unsupported, so an upgrade is a deliberate bump of that constant, then:

```bash
docker rm -f ai-memory && rm ~/.local/bin/ai-memory   # setup recreates neither on its own
node scripts/setup-ai-memory.mjs                      # new container + wrapper + rewiring
node scripts/verify-ai-memory.mjs                     # incl. the container/runner skew check
```

A **major** bump additionally runs a one-way, backup-gated data migration on first start (2.0: OKF v0.2). Take an extra `node scripts/backup-ai-memory.mjs` first and copy it outside the rotation; the server also writes its own gated archive to `/data/backups/` before touching anything, and rollback is always restore-from-archive plus the old pinned release — a pre-migration binary refuses a migrated data dir, so there is no in-place downgrade. Pin the native runner with `AI_MEMORY_NATIVE_BIN` for the duration of the window so its daily self-update cannot jump the major before the server does.

```bash
ai-memory uninstall --apply  # remove only ai-memory-owned MCP/hooks/instructions
docker rm -f ai-memory       # stop + remove the server (data volume survives)

# remove the shim LaunchAgent (claude-sub):
launchctl unload ~/Library/LaunchAgents/com.my-configs.claude-openai-shim.plist
rm ~/Library/LaunchAgents/com.my-configs.claude-openai-shim.plist

node scripts/backup-ai-memory.mjs --uninstall   # remove the backup LaunchAgent

docker volume rm ai-memory-data   # destructive: erase all memory
```

Avoid `ai-memory upgrade` here: it pulls whatever is newest, which defeats the pin. The upgrade sequence above covers everything it did — `setup-ai-memory.mjs` rewires MCP, hooks and the managed instructions/skills at the pinned version, and `startServer()` leaves an existing container alone on purpose (*"already exists — leaving it"*), which is exactly why the sequence starts with `docker rm -f`. Never hand-edit between the routing-block markers: a re-run replaces the marked region in place and would silently drop your edit.

## Troubleshooting

- **`ai-memory status` shows provider unhealthy / consolidation fails (claude-sub).** Check the shim: `curl -s localhost:8787/healthz` and `tail ~/.local/share/ai-memory/shim.err.log`. The shim needs `claude` in PATH and logged in.
- **It's billing my API instead of the subscription.** You have `ANTHROPIC_API_KEY` exported. Claude Code/the shim prefer the key over the subscription. Unset it (the shim strips it for its child, but your interactive `claude` login must also be subscription-auth).
- **Container can't reach the shim.** On Docker Desktop for Mac, `host.docker.internal` resolves to the host; the shim binds `127.0.0.1`. If a future Docker version blocks host-loopback access, re-run with the shim reachable on the bridge gateway, or run `local`/`anthropic` instead.
- **Shim didn't survive a reboot.** `launchctl list | grep claude-openai-shim`. Re-run the setup script to reinstall the LaunchAgent.

Full upstream docs: [`docs/install.md`](https://github.com/akitaonrails/ai-memory/blob/main/docs/install.md) · [`docs/usage.md`](https://github.com/akitaonrails/ai-memory/blob/main/docs/usage.md). Anthropic policy: [legal/compliance](https://code.claude.com/docs/en/legal-and-compliance) · [subscription + Agent SDK](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).
