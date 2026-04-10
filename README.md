# think

Local-first CLI for capturing notes, work logs, and ideas with P2P sync between machines.

## Setup

Requires **Node 20** (native SQLite extensions don't compile on Node 22+).

```bash
git clone git@github.com:MicroMediaSites/think-cli.git
cd think-cli
nvm use 20
npm install
npm run build
npm link
```

After `npm link`, the `think` command is available globally.

**Note:** The build pins the Node 20 binary path in the shebang, so `think` will always use Node 20 regardless of your active nvm version. If your Node 20 is at a different path than the machine that last ran `npm run build`, just rebuild:

```bash
nvm use 20 && npm run build
```

## Data

- **Database:** `~/.local/share/think/think.db`
- **Config:** `~/.config/think/config.json` (auto-generated on first run)

Data lives on disk, not in the repo. Use `think network sync` to replicate between machines.

## Usage

```bash
# Log entries
think log "idea for caching layer"
think log "standup — discussed deploy timeline" --category meeting
think sync "shipped the auth fix"              # shorthand for --category sync

# List entries
think list --week
think list --last-week --category sync
think list --tag architecture

# Weekly summary (uses Claude subscription via Agent SDK)
think summary                    # AI-powered summary of current week
think summary --last-week --raw  # raw entries, no AI

# P2P sync (both machines must be on the same LAN)
think network sync               # discover peers via mDNS and sync
think network sync --host 192.168.1.50  # sync with a specific machine
think network status             # show known peers and last sync times
```

## Categories

- `note` (default) — general notes and ideas
- `sync` — work log entries for 1:1 meetings
- `meeting` — meeting notes
- `decision` — decisions made
- `idea` — ideas to revisit

## Syncing between machines

Both machines need `think` installed. When on the same network:

1. Run `think network sync` on either machine
2. Peers discover each other automatically via mDNS/Bonjour
3. Entries replicate in both directions using CRDTs (no conflicts)

After syncing, `think summary --week` on either machine produces the same output.
