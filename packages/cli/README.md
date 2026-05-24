# think

Local-first CLI that gives AI agents persistent, curated memory.

## Install

Requires **Node 22.5+** (uses `node:sqlite`).

```bash
npm install -g @openthink/think
```

> **Note:** The curator and summary features use the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), which is distributed under Anthropic's commercial terms. You'll need a Claude subscription for these features to work. All other functionality (logging, recall, sync, export) works without it.

> **Note (semantic features — opt-in):** Semantic recall (downstream in v3) uses `Xenova/bge-small-en-v1.5` via `@huggingface/transformers` (~150 MB model + a large transitive native-binary tree). The dep is **optional** — default `npm install` does not pull it. Install explicitly to enable: `npm install @huggingface/transformers@4.2.0`. When activated by downstream tickets, the model auto-downloads from HuggingFace on first use, cached in `~/.cache/huggingface/` (override with `$HF_HOME`), with a 300-second timeout. Without the dep installed, `think recall` continues to use keyword (FTS) ranking unchanged.

## Quick start

```bash
# Log work events
think sync "shipped the auth fix"
think sync "EEP prototype demoed to product team"

# List recent entries
think list --week

# AI-powered summary
think summary
think summary --last-week --raw   # raw entries, no AI
```

## A nervous system for your AI brain

think turns your work into sensory input for your AI brain. Engrams are the raw signals — every `think sync` is a sensory trace. The curator is consolidation: it weighs engrams, promotes what matters into memories, and drops the rest. Memories live in a folder you control.

```
  one machine                                  another machine you own
  ───────────                                  ───────────────────────
  engrams → curator → memories ⇢ ~/your/folder ⇠ memories ← curator ← engrams
            (local AI)            (synced via                          (local AI)
                                   iCloud / Dropbox /
                                   Syncthing / …)
```

All reads and writes go to local SQLite. Engrams never leave the machine — only curated memories land in the folder. Point that folder at a sync tool you already use, and your AI's memory follows you across machines. No server. No relay. The folder is the propagation layer.

## Cortex — your AI's memory folder

A cortex is the workspace where your AI's memories live: a local SQLite database for engrams, plus a folder of JSONL files for the consolidated memories that persist.

```bash
# Set up (once) — point cortex at any folder; created if it doesn't exist
think cortex setup --fs ~/Dropbox/think-cortex
think cortex create personal

# Work normally — every sync writes a sensory trace
think sync "deployed auth service to staging"

# Curate — evaluate engrams, promote memories
think curate              # full run
think curate --dry-run    # preview without saving

# Recall what you (or another machine of yours) have stored
think recall "auth"       # search memories + local engrams
think memory              # show all memories

# Sync with the cortex folder
think cortex push         # write local memories out to the folder
think cortex pull         # ingest memories from the folder
think cortex sync         # push + pull
think cortex status       # show sync state

# Monitor curation quality
think monitor             # what got promoted vs dropped
```

The folder works with anything that syncs files: iCloud Drive, Dropbox, Google Drive, Syncthing, a network share. Point two machines at the same folder and the same memories show up on both.

> **One brain only.** think serves a single brain. Coordinating memory across many brains (a team, a swarm of agents) is out of scope — that belongs to HiveDB, a separate project.

### Offline-only and legacy backends

```bash
think cortex setup                              # offline-only — no folder, no remote
think cortex setup git@github.com:you/cortex.git   # git-remote backend (existing setups; --fs preferred for new ones)
```

The synced-folder model (`--fs`) is the recommended way for any new setup. The git-remote backend predates v2 and is preserved for users who already have one wired up — existing `think cortex setup <git-remote>` configurations continue to work unchanged.

> **A note on terminology.** Some CLI output (e.g. `Created cortex: foo (local + remote)`, `think cortex list`) still uses "remote" as a generic label for whichever backend you've configured. With `--fs`, the "remote" is your cortex folder; with a git URL, it's the git remote. The user-facing framing in this README treats the folder as a propagation layer rather than a remote — the CLI's umbrella term is an implementation detail.

## Episodes — narrative memory for task agents

Episodes let task-oriented agents (review bots, bug fixers, deploy agents) accumulate work across multiple rounds and synthesize it into a single narrative memory.

```bash
# Tag engrams with an episode key
think sync -e "org/repo#42" "found SQL injection in auth middleware"
think sync -e "org/repo#42" "author fixed queries but missed token rotation"
think sync -e "org/repo#42" "all paths encrypted, approved"

# Synthesize into a narrative memory
think curate --episode "org/repo#42"
```

Episode curation produces stories, not logs:

> *"A code review was opened against the auth middleware rewrite. The initial review identified plaintext session token storage — a direct violation of the encryption-at-rest requirement from the engineering standards doc. The author addressed this but missed the token rotation endpoint. After a third round, all session paths were encrypted and rotation was confirmed working."*

Re-curating after new rounds updates the existing narrative rather than creating a duplicate.

### Privacy

```bash
think pause    # suppress engram creation (silent no-op)
think resume   # re-enable
```

## Long-term backfill — what gets sent to Anthropic

`think long-term backfill` is a one-time pass that uses Claude to extract durable long-term events (adoptions, migrations, pivots, decisions, milestones, incidents) from your historical memories. By default, **it ships memory content to Anthropic** — one Claude SDK call per month of memories, with each call carrying that month's memories plus a summary hint and prior-batch context for supersession.

Three modes:

| Flag | Anthropic calls | Local writes | Use when |
|---|---|---|---|
| `--dry-run` | **zero** | none | You want to know how much data a real run would ship without sending anything. Prints memory count, monthly breakdown, and an envelope description. |
| `--preview-prompt` | one per month | none | You want to see the actual LLM-generated proposals before deciding whether to apply them. Same data envelope as a real run. |
| (no flags) | one per month | yes | Real run — proposals get inserted into the long-term events table. |

Opt out by **not running the command**, or by running with `--dry-run` to see scope first. There is no "redact-and-run" mode — if you have memory content you don't want shipped, delete it locally before running backfill (`think delete <id>` for individual entries) or pause before adding it (`think pause`).

The system prompt and per-batch user-message structure are in `src/commands/long-term.ts` (`BACKFILL_SYSTEM_PROMPT` and `runBackfillBatch`). `--dry-run` prints a summary of that envelope; read the source for the exact wording.

### Curator guidance

Each contributor can guide their curator with a personal prompt:

```bash
think curator edit    # opens ~/.think/curator.md in $EDITOR
think curator show    # print current guidance
```

## Data

- **Cortex DB:** `~/.think/engrams/<cortex>.db` (engrams, memories, sync state — all in one SQLite file)
- **Config:** `~/.config/think/config.json`
- **Curator guidance:** `~/.think/curator.md`
- **Entries (no cortex):** `~/.local/share/think/think.db`
- **Embedding model cache:** `~/.cache/huggingface/` — only present when `@huggingface/transformers` is installed (see semantic features note above). Stores `Xenova/bge-small-en-v1.5` (~150 MB); override location with `$HF_HOME`. Cached ONNX files are loaded directly without re-verification, so in shared environments (CI workers, multi-user machines) set `$HF_HOME` to a per-user, non-world-writable directory.

Override the data directory with `$THINK_HOME`.

## Retros — permanent codebase observations

Retros are structured observations any agent can emit about a codebase or tool — conventions worth respecting, invariants that weren't obvious, prior decisions that should not be re-litigated. Unlike engrams, retros have **no TTL** and are **never purged by the curator**: every emission is preserved permanently. The curator may relegate a retro (mark it as low-signal for default recall) but the row stays in storage. Tombstoning is explicit user action only.

```bash
think retro "fx-tracker strategy engine type contracts are not documented" --cortex fx-tracker
think retro "always run migrations in a transaction" --cortex my-repo --kind convention
think retro "AGT-169: mirrored the memories table pattern for the retros table" --cortex think-cli --kind prior_decision
```

`--cortex` is required (no fallback to active cortex — retros are always about a specific codebase or tool). The cortex is auto-created on first emission (a `✓ created cortex` line appears so you can catch typos immediately); no `think cortex create` step is needed. Optional `--kind` accepts `convention | invariant | prior_decision | gotcha`.

Read stored retros with `think retro recall --cortex <name>` (retros-only, scoped) or get a full task-start brief with `think brief --cortex <name>` (personal memories + repo retros). Retros are currently local-only — cross-machine sync is not yet wired up.

## All commands

```
think sync <message>           Log a work event
think sync -e <key> <message>  Log an episode-tagged event
think log <message>            Log a note (with --category, --tags)
think list                     List entries (--week, --since, --category)
think summary                  AI summary (--raw for plain text)
think delete                   Soft-delete entries

think cortex setup [--fs <path> | <repo>]   Configure backend (or no args for offline)
think cortex create <name>     Create a cortex
think cortex list              Show all cortexes
think cortex switch <name>     Set active cortex
think cortex current           Show active cortex
think cortex push              Push local memories to remote
think cortex pull              Pull remote memories to local
think cortex sync              Push + pull
think cortex status            Show sync state

think curate                   Run curation (--dry-run to preview)
think curate --episode <key>   Curate an episode into a narrative memory
think curate --consolidate     Compress older memories into long-term summary
think monitor                  Show promoted vs dropped engrams
think recall <query>           Search memories + engrams
think memory                   Show memories (--history for timeline)
think pull <cortex>            Read memories from another cortex
think retro <message>          Emit a permanent codebase observation (--cortex required, no TTL)
think retro add <message>      Explicit emit form (same as above)
think retro recall [<query>]   Read stored retros (--cortex required; default: promoted only)
think brief [<query>]          Task-start brief: personal memories + repo retros (--cortex required)

think curator edit             Edit personal curator guidance
think curator show             Show current guidance
think pause                    Suppress engram creation
think resume                   Re-enable engram creation

think migrate-data             Import existing git memories into local SQLite
think init                     Set up CLAUDE.md for auto-logging
think export                   Export entries as sync bundle
think import <file>            Import sync bundle
think audit                    Show sync audit log
think config show              Print configuration
think config set <key> <val>   Update a config value
think update                   Update to latest version
```

## Security model

See [SECURITY.md](./SECURITY.md) for the full threat model and vulnerability disclosure process. A few points worth surfacing up-front:

- **Pulled engrams from peers are untrusted content.** When you pull a cortex from another peer, the memories that land in your local DB were written by them. We escape `<data>` delimiters when feeding those memories to your Claude agent, and pattern-match a short list of common injection phrasings, but this is opportunistic warning, not a security boundary. A malicious peer can trivially bypass with paraphrase, translation, or novel phrasing. **Treat a cortex peer with the same trust level you'd give any other source of data your AI agent will read — do not add a cortex peer you don't trust.**
- **`cortex.repo` is security-sensitive configuration.** `think cortex setup` validates the URL shape on input, but if you edit `~/.config/think/config.json` by hand (or follow a tutorial that tells you to), a malformed URL can give an attacker code execution the next time you run a cortex-syncing command. Accepted prefixes: `https://` (preferred), `ssh://`, `git://`, `<user>@<host>:<path>` (ssh shortcut — any username and hostname, e.g. `git@github.com:org/repo.git` or `gitlab@self-hosted.example:group/repo.git`), and `http://` (permitted but not recommended — traffic is unencrypted).
- **Upgrade compatibility note.** Prior versions did not validate `cortex.repo` on read. If you configured a `file://` URL or a bare filesystem path for local testing, you'll see a clear error on the next cortex operation after upgrading — those forms are no longer accepted. Re-run `think cortex setup` with one of the supported transports, or edit `config.json` to remove the `repo` field for offline-only mode.
- **`THINK_NO_UPDATE_CHECK`** disables the once-per-24-hours `npm view @openthink/think` call that powers the update banner. Set to any of `1`, `true`, or `yes` (case-insensitive). Useful for air-gapped machines, privacy-sensitive environments, or CI where outbound network calls aren't desirable.

## API curation backend (`think serve` / proxy)

`think serve` runs a proxy that ingests events from connected sources and curates them into memories. By default it uses the Claude Agent SDK — the same subscription-billed path your local `think` uses — so no API key is required. An opt-in raw Messages API backend is available for proxy deployments that have their own API billing (it is ~4–5× faster for curation because it skips the agent runtime overhead).

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `THINK_ANTHROPIC_KEY` | **Preferred** when `THINK_CURATION_BACKEND=api` is set | Anthropic API key used exclusively by think. **Recommended over `ANTHROPIC_API_KEY`** because it is scoped to think only: other Anthropic SDK tools in the same shell (e.g. Claude Code) read `ANTHROPIC_API_KEY`, and exporting that variable to satisfy think would silently re-route them from subscription billing to API billing. With `THINK_ANTHROPIC_KEY` set, `ANTHROPIC_API_KEY` is absent from the environment, so Claude Code and other tools keep their subscription path. |
| `THINK_CURATION_BACKEND` | No | Set to `api` to enable the raw Messages API curation backend. Requires `THINK_ANTHROPIC_KEY` (or the deprecated `ANTHROPIC_API_KEY`). Default: Agent SDK. |
| `ANTHROPIC_API_KEY` | **Deprecated fallback** | Accepted for backward compatibility when `THINK_ANTHROPIC_KEY` is absent. Emits a one-time warning to stderr and will stop being supported in a future release. Set `THINK_ANTHROPIC_KEY` instead. |

> **Daemon restart required.** The daemon inherits env at spawn time. If you add or change `THINK_ANTHROPIC_KEY` in your shell rc, restart the daemon for it to take effect.

> **Billing isolation.** A machine with only `THINK_ANTHROPIC_KEY` set and no `ANTHROPIC_API_KEY` can run Claude Code in the same shell session: Claude Code reads `ANTHROPIC_API_KEY` (not `THINK_ANTHROPIC_KEY`) and continues to use its subscription billing path. The two tools do not share a key.
