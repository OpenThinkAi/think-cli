# think

Local-first CLI that gives AI agents persistent, curated memory.

## Install

Requires **Node 22.5+** (uses `node:sqlite`).

```bash
npm install -g open-think
```

> **Note:** The curator and summary features use the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), which is distributed under Anthropic's commercial terms. You'll need a Claude subscription for these features to work. All other functionality (logging, recall, sync, export) works without it.

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

All reads and writes go to local SQLite. Engrams never leave the machine — only curated memories land in the folder. Point that folder at a sync tool you already use, and your brain's memory follows you across machines. No server. No relay. The folder is the propagation layer.

## Cortex — your brain's memory folder

A cortex is the workspace where your brain's memories live: a local SQLite database for engrams, plus a folder of JSONL files for the consolidated memories that persist.

```bash
# Set up (once) — point cortex at any folder, synced or otherwise
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

The folder works with anything that syncs files: iCloud Drive, Dropbox, Google Drive, Syncthing, a network share. Point two machines at the same folder and the same brain shows up in both.

> **One brain only.** think serves a single brain. Coordinating memory across many brains (a team, a swarm of agents) is out of scope — that belongs to HiveDB, a separate project.

### Offline-only and advanced/legacy backends

```bash
think cortex setup                              # offline-only — no folder, no remote
think cortex setup git@github.com:you/cortex.git   # advanced/legacy: git remote as backend
```

The synced-folder model (`--fs`) is the recommended way. The git-remote backend predates v2 and is preserved for users who already have one wired up; new setups should prefer `--fs`.

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

Override the data directory with `$THINK_HOME`.

## All commands

```
think sync <message>           Log a work event
think sync -e <key> <message>  Log an episode-tagged event
think log <message>            Log a note (with --category, --tags)
think list                     List entries (--week, --since, --category)
think summary                  AI summary (--raw for plain text)
think delete                   Soft-delete entries

think cortex setup [opts]      Configure backend (--fs <path>, [repo], or none)
think cortex create <name>     Create a cortex
think cortex list              Show all cortexes (local + remote)
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
think pull <cortex>            Read memories from another cortex you have
think pull <cortex>            Read another cortex's memories

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
- **`THINK_NO_UPDATE_CHECK`** disables the once-per-24-hours `npm view open-think` call that powers the update banner. Set to any of `1`, `true`, or `yes` (case-insensitive). Useful for air-gapped machines, privacy-sensitive environments, or CI where outbound network calls aren't desirable.
