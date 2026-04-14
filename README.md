# think

Local-first CLI that gives AI agents persistent, curated memory.

## Install

Requires **Node 22.5+** (uses `node:sqlite`).

```bash
npm install -g open-think
```

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

## Cortex — shared team memory

Cortexes connect agents across a team via a shared git repo. Engrams (raw events) stay local. A curator agent evaluates them and appends curated memories to the repo.

```bash
# Set up (once)
think cortex setup git@github.com:org/hivedb.git
think cortex create engineering

# Work normally — think sync logs engrams locally
think sync "deployed auth service to staging"

# Curate — evaluate engrams, append memories to the branch
think curate              # full run
think curate --dry-run    # preview without pushing

# Read team memories
think recall "auth"       # search memories + local engrams
think memory              # show all memories from branch

# Monitor curation quality
think monitor             # what got promoted vs dropped

# Pull another team's memories
think pull product
```

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

- **Engrams:** `~/.local/share/think/think.db` (no cortex) or `~/.think/engrams/<cortex>.db`
- **Config:** `~/.config/think/config.json`
- **Curator guidance:** `~/.think/curator.md`
- **Memories:** `memories.jsonl` on cortex git branches (append-only JSONL)

## All commands

```
think sync <message>           Log a work event
think log <message>            Log a note (with --category, --tags)
think list                     List entries (--week, --since, --category)
think summary                  AI summary (--raw for plain text)
think delete                   Soft-delete entries

think cortex setup <repo>      Configure git repo for shared memory
think cortex create <name>     Create a cortex branch
think cortex list              Show cortex branches
think cortex switch <name>     Set active cortex
think cortex current           Show active cortex

think curate                   Run curation (--dry-run to preview)
think monitor                  Show promoted vs dropped engrams
think recall <query>           Search memories + engrams
think memory                   Show memories (--history for git log)
think pull <cortex>            Pull another cortex's memories

think curator edit             Edit personal curator guidance
think curator show             Show current guidance
think pause                    Suppress engram creation
think resume                   Re-enable engram creation

think init                     Set up CLAUDE.md for auto-logging
think export                   Export entries as sync bundle
think import <file>            Import sync bundle
think audit                    Show sync audit log
```
