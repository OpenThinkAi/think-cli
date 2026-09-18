# think

Local-first CLI that gives AI agents persistent, searchable memory.

`@openthink/think` — **vector recall**, **write-time compaction**, **resident daemon**. The core reframe: recall is cheap enough to call implicitly on every agent turn. Vectors come from a resident `bge-small-en-v1.5` embedding model, so the right entry comes back even when the vocabulary doesn't overlap. Compaction folds each new memory into a single self-contained line via an LLM call, so read time stays sub-100ms. The daemon holds the model in memory and serves CLI calls over a Unix socket — no cold start per recall. A Claude Code `UserPromptSubmit` hook and an MCP server both talk to that same daemon, giving you automatic per-prompt orientation and agent-initiated mid-turn recall. Full design: [docs/architecture.md](docs/architecture.md).

## Install

Requires **Node 22.5+** (uses `node:sqlite`).

```bash
npm install -g @openthink/think
```

**Coming from 0.6.x?** Your existing store is read as-is — the first daemon launch reindexes it into the vector index (one-time, typically under a minute on a real-size corpus). See [Upgrading to 3.0](#upgrading-to-30) for what this release removed and what it repairs for you.

> **Claude subscription.** think's LLM work — compaction, summaries, the dashboard, retro curation — defaults to Anthropic through the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), distributed under Anthropic's commercial terms, so a subscription is needed out of the box. Point those operations at your own model instead and nothing calls Anthropic — see [Choosing which model runs what](#choosing-which-model-runs-what). Recording and recall never call an LLM at all.

## The contract

> **Every write is a memory, an event, or a retro, and every one of them goes through the resident daemon.** There is no other write tier.

Three kinds, three write commands. Reads go through the same daemon, so a write is recallable as soon as it is indexed.

```bash
# Writes
think sync "shipped the auth fix"                     # memory — something you did
think event "Decided to drop the Redis cache"         # event — a decision, deploy, incident, milestone
think retro "hub tests need TEST_DATABASE_URL set"    # retro — a durable lesson, tagged with this repo

# Reads
think recall "auth token rotation"                    # semantic search across memories, events and retros
think brief --context think-cli                       # task-start brief: your context + retros for this repo

# The daemon, and the two surfaces that talk to it
think daemon status                                   # running state, pid, socket path, version
think hook install                                    # Claude Code UserPromptSubmit hook → recall on every prompt
think mcp install                                     # MCP server → agent-initiated recall mid-turn

# Health
think doctor                                          # what's broken on this machine, and what --fix can repair
```

The daemon starts itself on the first CLI call and stays resident. `think daemon start|stop|status` is there when you want to drive it by hand.

### When the daemon is down

`think sync`, `think event` and `think retro` never fail silently and never write somewhere nothing reads. The entry goes to the cortex's L1 outbox; the daemon drains and indexes it on its next start. You get one line on stderr, even under `--silent`:

```
  note: daemon unavailable — wrote to L1; it will be indexed on next daemon start
```

If even that write is impossible, the command exits non-zero rather than reporting a write that didn't happen.

## Cortex — where your AI's memory lives

A cortex is one memory workspace: a local SQLite index holding memories, events, retros and sync state, plus a backend that propagates entries to the other machines reading the same cortex.

```bash
# A synced folder
think cortex setup --fs ~/Dropbox/think-cortex

# A git remote
think cortex setup git@github.com:you/cortex.git

# Neither — offline only, nothing ever leaves the machine
think cortex setup

think cortex create personal
think cortex switch personal
```

The two backends are peers. Pick on how you want entries to travel, not on which is newer:

|  | `--fs <path>` | `<git-remote>` |
| --- | --- | --- |
| Entries travel via | whatever already syncs the folder — iCloud Drive, Dropbox, Google Drive, Syncthing, a network share | the daemon's push-debounce and pull loops (`git push` / `git fetch`) |
| You need | a folder that syncs | a git remote you can push to |
| Suits | machines you own, no account, no server | machines you own **and** a cortex shared with other people |
| Setup | `think cortex setup --fs ~/Dropbox/think-cortex` | `think cortex setup git@github.com:you/cortex.git` |

Either way, all reads and writes hit local SQLite first; the backend is the propagation layer, never a lookup path. No server, no relay.

```bash
think cortex push      # write local entries out to the backend
think cortex pull      # ingest entries from the backend
think cortex sync      # pull + push
think cortex status    # show sync state
```

Day to day you don't run these — the daemon pushes on a 500ms debounce after each write and pulls on its own poll loop.

### Sharing a cortex with a team

Supported, over the git backend — it's what the daemon's push-debouncer, pull loop and plumbing writer were built for, and what think's own maintainers run on every machine. Everyone points `think cortex setup <the same git remote>` at one repo and switches to the same cortex name. Each cortex is one orphan branch in that repo; every machine's daemon pushes its own entries onto the branch and pulls everyone else's. Entry ids are content-derived and the branch carries a union-merge attribute, so two people writing at the same moment converge with nothing to resolve by hand.

`think pull <cortex>` prints what another cortex has already synced into your local store, without switching to it.

> **A note on terminology.** Some CLI output (`Created cortex: foo (local + remote)`, `think cortex list`) uses "remote" as a generic label for whichever backend you configured. With `--fs` the "remote" is your folder; with a git URL it's the git remote.

### Privacy

```bash
think pause    # think sync and think event silently skip until resumed
think resume
```

## Instruction blocks for your agents

`think init` writes a managed block into `CLAUDE.md` (and `AGENTS.md` if present) that teaches agents to log outcomes with `think sync` and decisions with `think event`, and to read and write retros.

```bash
think init                                 # work-log block in ~/CLAUDE.md
think init --minimal                       # conservative variant: explicit shipped outcomes only
think init --retro --cortex think-cli      # second block with the cortex baked in, at the repo root
think init --list                          # every file that currently has a managed block
```

There is one template. think records every file it wrote a block into, so `think update` can refresh all of them and `think doctor` can enumerate them.

## Choosing which model runs what

think's LLM work is provider-agnostic. Each operation can be pointed at Anthropic,
at an on-device model, or at any API speaking the OpenAI `/chat/completions`
shape (OpenAI, DeepSeek, OpenRouter, vLLM, LM Studio, oMLX/Qwen).

With no configuration, everything runs on Anthropic.

```jsonc
// ~/.config/think/config.json  →  "cortex": { ... }
"llm": {
  "providers": {
    "qwen":     { "kind": "openai", "endpoint": "http://127.0.0.1:8000/v1",
                  "model": "Qwen3.8-27B-MLX-4bit", "disableThinking": true },
    "deepseek": { "kind": "openai", "endpoint": "https://api.deepseek.com/v1",
                  "model": "deepseek-chat", "apiKeyEnv": "DEEPSEEK_API_KEY" },
    "claude":   { "kind": "anthropic", "model": "claude-sonnet-4-6" }
  },
  "default": "claude",
  "operations": { "compaction": "qwen", "retro-dedupe": "qwen", "summary": "deepseek" },
  "fallback": "claude"
}
```

Operations you can assign: `compaction`, `supersession`, `terminal-event`,
`retro-dedupe`, `summary`, `dashboard`, `long-term`. Anything unassigned uses
`default`. The names `curation`, `event-detection` and `episode` are still
accepted so an older config doesn't error, but they route nothing — the work
behind them was removed in 3.0.

**Moving everything to one model** is just `default` — you don't have to
enumerate operations at all:

```jsonc
"llm": {
  "providers": {
    "qwen": { "kind": "openai", "endpoint": "http://127.0.0.1:8000/v1",
              "model": "<the id your server was started with>",
              "ctxBudget": 40000, "timeoutMs": 1800000,
              "disableThinking": true }
  },
  "default": "qwen"
}
```

With no `fallback` and a loopback endpoint, think stops contacting Anthropic
entirely (bar the dashboard's `ask`) and needs no LLM consent, because nothing
leaves the machine. Read the structured-output note below before doing this —
two operations are pickier than the rest.

The `model` must match the id your server was launched with. `mlx_lm.server`
loads whatever id a request names, so a mismatch silently unloads the running
model and loads another — killing any generation in flight.

`dashboard` here means the **status digest** — the panel summaries `think
dashboard` renders. The dashboard's interactive **`ask`** is a different thing
and is *not* assignable: it is agentic, running a multi-turn loop over MCP
tools, so it stays on the Claude Agent SDK. There is no operation name for it,
and adding one has no effect.

**A `cortex.local` block routes nothing now.** `cortex.local` and
`cortex.llmProvider` (and `THINK_LOCAL_*`) only ever routed the operations 3.0
removed, so an install carrying them runs everything on `default`. To put your
own model back in the path, name the operations you want under `cortex.llm`;
nothing is routed implicitly.

**Consent follows the data, not the vendor.** A provider that sends cortex
content off this machine requires `THINK_LLM_CONSENT=1` — Anthropic, OpenAI and
DeepSeek alike. A provider on loopback does not, because nothing leaves. Egress
is inferred from the endpoint (`localhost`/`127.0.0.1`/`::1` are on-machine,
everything else is not, an unparseable endpoint fails closed); declare
`"offMachine": false` to trust a host on your own network.

**Sizing a local model.** `ctxBudget` (default 28,000 tokens) is the prompt
ceiling — over it, think uses `fallback`, or skips if none is set. `timeoutMs`
(default 900,000) is the request deadline: a large model doing a 30k-token
prefill plus generation can run for minutes, and the failure is reported as a
timeout naming the setting, not as an unreachable server.

Prompt size is estimated at ~3.5 characters per token, deliberately erring high
— this gate decides what is allowed to run, so under-counting is the dangerous
direction. If you sized a `ctxBudget` against the older, looser 4.0 estimate
(pre-2.6.0), the same prompt now measures larger and may start using `fallback`
or being skipped; raise `ctxBudget` to your model's real context window. When
the fallback cannot take the task either, the work is left pending rather than
retried elsewhere.

**Structured output — check this before routing everything.** Operations fall
into three tiers:

| Tier | Operations | Behaviour |
| --- | --- | --- |
| Strict | `compaction`, `supersession` | Demand server-side enforcement. Forced `tool_use` on Anthropic, `response_format: json_schema` elsewhere. |
| Schema-assisted | `terminal-event`, `retro-dedupe` | Advisory on Anthropic (prompts are tuned to emit JSON unaided), enforced elsewhere. |
| Prose | `summary`, `dashboard`, `long-term` | No schema; output is prose or parsed leniently. |

Not every OpenAI-compatible server implements `response_format`. Notably
`mlx_lm.server` **accepts the field and ignores it** — no error, it simply
returns whatever the model felt like. LM Studio and vLLM do honour it.

On a server that ignores it, only the prompt holds the shape. For the prose tier
that is fine. For the strict tier it is not: `compaction` marks entries
`compaction-skipped` and `supersession` retries once then fails. Those failures
are loud and skip-safe — they leave work pending rather than writing corrupted
memories — but the operations will not do useful work. Either keep those two on
a provider that enforces schemas, or verify yours does:

```bash
curl -s $ENDPOINT/chat/completions -H 'content-type: application/json' -d '{
  "model":"<your-model>","max_tokens":100,
  "messages":[{"role":"user","content":"Return the topics for: fixed a bug."}],
  "response_format":{"type":"json_schema","json_schema":{"name":"t","strict":true,
    "schema":{"type":"object","properties":{"topics":{"type":"array",
    "items":{"type":"string"}}},"required":["topics"],
    "additionalProperties":false}}}}'
```

JSON back means the strict tier is safe there. Prose back means it isn't.

## Data

- **Cortex index:** `~/.think/index/<cortex>.db` — memories, events, retros, long-term events and sync state, plus the vector index, in one SQLite file per cortex.
- **Canonical store:** `~/.think/repo/` — the git-backed log the index is rebuilt from (`think reindex`).
- **Daemon:** `~/.think/daemon.sock`, `~/.think/daemon.pid`.
- **Config:** `~/.config/think/config.json` (under a custom `THINK_HOME`, `<THINK_HOME>/config/config.json`).
- **Entries with no cortex configured:** `~/.local/share/think/think.db`.

Override the data directory with `$THINK_HOME`.

## Upgrading to 3.0

`think update` installs `@openthink/think@latest` and crosses majors, so a machine on 2.x reaches 3.0 with no extra step.

### Removed, and what to use instead

Each removed flag exits non-zero with a one-line pointer rather than being quietly ignored.

| Removed | Use instead |
| --- | --- |
| `think sync -d` / `--decision` | `think event "Decided …"` |
| `think sync --context` | `think event` |
| `think sync -e` / `--episode` | `think event` |
| `think log` | `think sync` |
| `think curate` (incl. `--episode`, `--consolidate`) | nothing — the tier it curated is gone. `think curate-retros` is a different command and stays. |
| `think monitor` | `think recall` / `think memory` |
| `think curator edit` / `show` | nothing — there is no curator prompt to guide. |
| `think migrate-data` | `think doctor` reports anything still to migrate; `--fix` migrates it. |
| `think cortex auto-curate` / `auto-sync` | nothing — the daemon syncs on its own. |
| `think recall`'s legacy-table flag | `think recall` (it searches everything) |
| `think subscribe poll`'s legacy-table flag | `think pull <team-cortex>` |
| `think init --block-version` | `think init` — there is one template now. |

Nine `cortex.*` config keys that only the removed write tier read are now inert. think prints one advisory line naming the ones it finds and leaves your config file alone.

### What self-heal does on first start

No prompt, no flag. On the first 3.0 daemon start think:

- **Reaps the retired LaunchAgents** — unloads and deletes every `ai.openthink.curate.*` and `ai.openthink.sync.*` job, matched by label across every `THINK_HOME` on the machine, not just the current one.
- **Migrates stranded rows** — entries the pre-daemon write path left in a table nothing reads are re-submitted through the normal write path, as events if they carried a decision and memories otherwise, with their original timestamps preserved. On a shared cortex, expect a one-time burst of backdated entries on the branch when each teammate upgrades.
- **Refreshes managed blocks** — `think update` rewrites every `CLAUDE.md` / `AGENTS.md` block think has a record of, so agents stop being taught commands that no longer exist.

The next interactive `think` command prints a one-time summary of what was healed.

### `think doctor` for everything else

```bash
think doctor           # report
think doctor --fix     # apply the safe repairs, then re-run the checks
think doctor --json    # one JSON document on stdout, each check with a stable id
```

Checks: stale LaunchAgents · managed blocks out of date · rows still waiting to be migrated · `~/.think/repo` index stale against HEAD · daemon running a different build than the one installed · configured LLM providers reachable · Claude Code hook and MCP server registered and pointing at the installed build · more than one `THINK_HOME` present · a cortex branch carrying a bad salvage commit · retired vocabulary in instruction files think does not manage.

Every repair `--fix` applies is a function self-heal already calls, and none of them edits outside a managed marker pair. The vocabulary check never edits anything — it reports file:line and leaves the wording to you. Exit code is 0 when nothing failed; a warning does not fail the exit code, so a setup script can gate on it.

## All commands

<!-- commands:begin (generated by npm run gen:commands — do not edit) -->
| Command | Args | Description |
| --- | --- | --- |
| `think sync` | `<message>` | Record a memory entry to the active cortex (or local think.db) |
| `think list` |  | List entries with optional filters |
| `think summary` |  | Generate a summary of entries (AI-powered or raw) |
| `think delete` |  | Soft-delete entries from the active cortex (tombstoned, propagated to peers) |
| `think supersession` |  | Inspect and revert supersession links (hidden entries can be restored) |
| `think supersession list` |  | List superseded (hidden) entries in the active cortex, most recent first |
| `think supersession show` | `<id>` | Show the supersession state of an entry: what hid it, and what it hid |
| `think supersession revert` | `<id>` | Clear a supersession link, restoring the entry to active recall on this machine |
| `think export` |  | Export entries as a sync bundle (file-based sync) |
| `think import` | `<file>` | Import a sync bundle from another device |
| `think init` |  | Set up CLAUDE.md (and AGENTS.md) for auto-logging and retros |
| `think audit` |  | Show sync audit log — what data was sent or received |
| `think audit prune` |  | Drop audit entries older than the given date (--before <iso-date>) |
| `think cortex` |  | Manage cortexes (team memory workspaces) |
| `think cortex setup` | `[repo]` | Configure a sync backend for cortex storage (git or local-fs) |
| `think cortex create` | `<name>` | Create a new cortex |
| `think cortex list` |  | Show all cortexes |
| `think cortex switch` | `<name>` | Set the active cortex |
| `think cortex current` |  | Show the active cortex |
| `think cortex push` |  | Push local memories to remote |
| `think cortex pull` |  | Pull remote memories to local |
| `think cortex sync` |  | Sync memories with remote (pull + push) |
| `think cortex status` |  | Show sync status for the active cortex |
| `think cortex migrate` |  | Migrate cortex storage from git to a local folder |
| `think cortex migrate-layout` | `[cortex]` | One-time: nest cortex files under <branch>/ for every branch |
| `think recall` | `<query>` | Search memories, events and retros |
| `think memory` |  | Show current memories from local store |
| `think memory add` | `<message>` | Add a memory directly, bypassing curation |
| `think pull` | `<cortex>` | Read another cortex's memories from local store |
| `think pause` |  | Pause event creation — think sync will silently skip until resumed |
| `think resume` |  | Resume event creation after a pause |
| `think config` |  | View or update think configuration |
| `think config show` |  | Print current configuration |
| `think config set` | `<key> <value>` | Set a configuration value |
| `think update` |  | Update think to the latest version (restarts the daemon if needed) |
| `think migrate-engrams` |  | Re-submit entries stranded in the legacy pre-daemon table |
| `think long-term` |  | Manage long-term memory events (durable decisions, transitions, milestones) |
| `think long-term backfill` |  | One-time extraction of long-term events from historical memories |
| `think long-term list` |  | List long-term events chronologically |
| `think long-term record` |  | Manually record a long-term event (interactive) |
| `think serve` |  | Boot the open-think proxy server (env-driven; see `docs/serve.md`) |
| `think serve status` |  | Print the persisted proxy state without starting the server |
| `think serve subscribe` | `<kind> <pattern>` | Add a connector subscription to the running proxy |
| `think serve unsubscribe` | `<kind> <pattern>` | Remove a subscription from the running proxy |
| `think serve creds` |  | Manage encrypted source credentials stored in the proxy vault. |
| `think serve creds add` | `<kind> <pattern>` | Store or replace a credential for a proxy subscription |
| `think subscribe` |  | Subscribe to external event sources via the open-think proxy |
| `think subscribe configure` |  | Set the proxy URL and bearer token used by other subscribe commands |
| `think subscribe add` | `<kind> <pattern>` | Create a subscription on the proxy (e.g. `think subscribe add mock 3`) |
| `think subscribe list` |  | List subscriptions registered on the proxy |
| `think subscribe remove` | `<id>` | Delete a subscription on the proxy (cascades to events/credential) |
| `think subscribe set-credential` | `<id>` | Store an encrypted credential for a subscription (stdin preferred) |
| `think subscribe poll` |  | [DEPRECATED] No-op — use `think pull <team-cortex>` instead |
| `think subscribe install-agent` |  | Install a LaunchAgent that polls on session load + on a timer |
| `think subscribe disable` |  | Remove the auto-subscribe LaunchAgent for this workspace |
| `think subscribe status` |  | Show auto-subscribe scheduler status |
| `think subscribe show` |  | Show the configured proxy URL (token is redacted) |
| `think subscribe redact-set` | `<id> [paths...]` | Set per-subscription JSONPath-subset redact selectors (e.g. `$.user.email`) |
| `think retro` | `<content>` | Record a durable lesson onto your home cortex, tagged by repo context |
| `think retro-migrate` |  | Fold legacy per-repo cortices into your home cortex (dry-run by default) |
| `think event` | `<message>` | Record a notable event (milestone, deploy, decision, incident) |
| `think curate-retros` |  | Run retro curator: dedupe, promote, and relegate retros (no deletion) |
| `think brief` | `[query]` | Task-start brief: home-cortex context + retros scoped to this repo |
| `think daemon` |  | Manage the think resident daemon process |
| `think daemon start` |  | Start the think daemon in the background (no-op if already running) |
| `think daemon stop` |  | Send the shutdown RPC to the daemon and wait up to 5s for it to exit. |
| `think daemon status` |  | Print the daemon's running state, pid, socket path, and version |
| `think reindex` | `[cortex]` | Rebuild the search index for one or all cortexes from the raw log |
| `think hook` |  | Manage Claude Code hook integration for think. |
| `think hook install` |  | Register the think UserPromptSubmit hook in Claude Code settings. |
| `think hook uninstall` |  | Remove the think UserPromptSubmit hook from Claude Code settings. |
| `think mcp` |  | Manage the think MCP server (start in stdio mode, or install/uninstall). |
| `think mcp install` |  | Register the think MCP server in Claude Code MCP config. |
| `think mcp uninstall` |  | Remove the think MCP server from Claude Code MCP config. |
| `think retro-usage` |  | Open a report of how your retros surface in recall/brief |
| `think dashboard` |  | Open a status dashboard (today's work) with an AI prompt box |
| `think doctor` |  | Report this machine's think install health, and repair what is safe |
<!-- commands:end -->

## `think serve` — proxy for external event sources

`think serve` boots an HTTP backend that connects to GitHub, Linear, etc. and
fans their events into per-subscription queues. It is entirely optional — local
writing and recall work without it, and team memory now flows over a shared
cortex (see [Sharing a cortex with a team](#sharing-a-cortex-with-a-team))
rather than through the proxy. `think subscribe poll` is a deprecated no-op;
pull the team cortex instead.

```sh
# On the host (Railway, your homelab, wherever)
THINK_TOKEN=$(openssl rand -hex 32) \
THINK_VAULT_KEY=$(openssl rand -base64 32) \
NODE_ENV=production \
PORT=4823 \
  npx @openthink/think serve

# On your laptop — token is read from stdin, never the command line
echo "$THINK_TOKEN" | think subscribe configure --proxy https://my-proxy.example.com
think subscribe add mock 3        # only `mock` is registered today; github/linear land in follow-ups
```

Full endpoint reference, threat model, and operator runbook live at
[`packages/cli/docs/serve.md`](packages/cli/docs/serve.md) and
[`packages/cli/SECURITY-serve.md`](packages/cli/SECURITY-serve.md).

### Operator runbook — push-debouncer recovery

The proxy daemon runs a push-debouncer that periodically commits curated memory
and pushes it to the shared cortex branch on origin. If the proxy's local cortex
clone falls significantly behind origin (e.g. after a slow restart while another
writer advanced origin), the daemon will automatically self-heal: it detects the
`behind` count, fetches origin, hard-resets the local branch to the fresh remote
tip, re-appends any pending outbox entries, and pushes. This should require no
operator intervention for any gap size.

**Observing push health.** The `/v1/health` endpoint and each tick's report include
a `push_debouncer` block:

```json
{
  "status": "ok",
  "push_debouncer": {
    "failures_nff": 0,
    "successes": 42,
    "last_failure_at": null
  }
}
```

A rising `failures_nff` counter means the proxy is curating but curated entries
are not reaching origin. Check `daemon.log` for `[push-debouncer]` lines and
inspect `git status -sb` in the proxy's cortex clone directory.

**Last-resort escape hatch.** If the proxy cannot self-heal (e.g. due to a
network partition or corrupted ref), you can restore propagation immediately with:

```sh
git -C <cortex-clone-path> reset --hard origin/<branch>
```

This discards any local-only commits. Curated entries that were pending in the
outbox (not yet pushed) will be re-appended on the next write cycle — no data is
permanently lost because the outbox rows are only deleted after a successful push.

**Configuring the large-behind threshold.** The daemon short-circuits to the
force-reset path when `behind >= cortex.largeBehindThreshold` (default 10).
To tune this add to your config:

```json
{ "cortex": { "largeBehindThreshold": 5 } }
```

> **Migrating from `open-think-server`?** The package was deprecated in
> v0.5.0 and the proxy now ships inside `@openthink/think`.
> - Replace `npx open-think-server` with `npx @openthink/think serve`.
> - All env vars carry over verbatim.
> - Default port changed from `3000` to `4823` (set `PORT=3000` to keep the old binding).
> - Dockerfile moved from `packages/server/Dockerfile` to the repo root.
>   Update any `dockerfile: packages/server/Dockerfile` line in your
>   compose file to `dockerfile: Dockerfile` (or drop it — that's the default).

> **Migrating from `open-think`?** The package was renamed to `@openthink/think`
> in v0.6.0. Same `think` binary, same data path, same flags — only the npm
> coordinate changed.
> - `npm uninstall -g open-think && npm install -g @openthink/think`.
> - The `THINK_DB_PATH` default is still `./open-think.sqlite`; existing serve
>   installs keep working without re-pointing.
> - The legacy `open-think` package on npm will be deprecated with a redirect
>   message in a follow-up release; until then, run the uninstall step above to
>   avoid two `think` binaries fighting on PATH.

## Security model

See [SECURITY.md](SECURITY.md) for the full threat model and vulnerability disclosure process. A few points worth surfacing up-front:

- **Pulled entries from peers are untrusted content.** When you pull a cortex from another peer, the memories, retros and long-term events that land in your local DB were written by them. We escape `<data>` delimiters when feeding them to your Claude agent, and pattern-match a short list of common injection phrasings, but this is opportunistic warning, not a security boundary. A malicious peer can trivially bypass it with paraphrase, translation, or novel phrasing. **Treat a cortex peer with the same trust level you'd give any other source of data your AI agent will read — do not add a cortex peer you don't trust.**
- **`cortex.repo` is security-sensitive configuration.** `think cortex setup` validates the URL shape on input, but if you edit `~/.config/think/config.json` by hand (or follow a tutorial that tells you to), a malformed URL can give an attacker code execution the next time you run a cortex-syncing command. Accepted prefixes: `https://` (preferred), `ssh://`, `git://`, `<user>@<host>:<path>` (ssh shortcut — any username and hostname, e.g. `git@github.com:org/repo.git` or `gitlab@self-hosted.example:group/repo.git`), and `http://` (permitted but not recommended — traffic is unencrypted).
- **Upgrade compatibility note.** Prior versions did not validate `cortex.repo` on read. If you configured a `file://` URL or a bare filesystem path for local testing, you'll see a clear error on the next cortex operation after upgrading — those forms are no longer accepted. Re-run `think cortex setup` with one of the supported transports, or edit `config.json` to remove the `repo` field for offline-only mode.
- **`THINK_NO_UPDATE_CHECK`** disables the once-per-24-hours `npm view @openthink/think` call that powers the update banner. Set to any of `1`, `true`, or `yes` (case-insensitive). Useful for air-gapped machines, privacy-sensitive environments, or CI where outbound network calls aren't desirable.

## Further reading

- [docs/architecture.md](docs/architecture.md) — the five layers, the entry model, write and read paths, daemon internals.
- [docs/retro-locality.md](docs/retro-locality.md) — where retros live and how they are scoped at recall.
- [docs/cortex-sync-protocol.md](docs/cortex-sync-protocol.md) — the authenticated push/pull wire format for a cortex hub.
- [docs/byo-hub-dogfood.md](docs/byo-hub-dogfood.md) — running two peers against one self-hosted hub.
- [docs/history/iterative-learning-v2.md](docs/history/iterative-learning-v2.md) — the earlier retro design, kept for context; superseded on locality.
- [CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md) · [CHANGELOG.md](CHANGELOG.md)

---

Built by [Saltline Digital](https://saltline.digital) — custom software and AI automation for small businesses.
