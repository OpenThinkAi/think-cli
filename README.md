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

## Local-first architecture

All reads and writes go to local SQLite. Sync is optional and eventual — your agents work fully offline.

```
  your machine                          remote (optional)
  ─────────────                         ────────────────
  entries → engrams → curator → memories  ⇄  git | pg*
                      (local AI)
```

Engrams (raw events) never leave your machine. Only curated memories sync to the backend you choose.

*Postgres adapter coming soon.*

## Cortex — shared team memory

Cortexes are memory workspaces. Each has its own engrams, memories, and sync state.

```bash
# Set up (once)
think cortex setup git@github.com:org/hivedb.git
think cortex create engineering

# Work normally — syncs log engrams locally
think sync "deployed auth service to staging"

# Curate — evaluate engrams, promote memories
think curate              # full run
think curate --dry-run    # preview without saving

# Read team memories
think recall "auth"       # search memories + local engrams
think memory              # show all memories

# Sync with remote
think cortex push         # push local memories to remote
think cortex pull         # pull remote memories to local
think cortex sync         # push + pull
think cortex status       # show sync state

# Monitor curation quality
think monitor             # what got promoted vs dropped

# Read another team's memories
think pull product
```

Cortexes work without a remote — `think cortex setup` with no repo URL creates an offline-only workspace.

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

think cortex setup [repo]      Configure sync backend (or offline-only)
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
