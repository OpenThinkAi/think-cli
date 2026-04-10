You are one iteration of a Ralph loop building "think" — a local-first CLI tool for capturing notes, work logs, and ideas with P2P sync between machines.

Working directory: /Users/mattpardini/Work/Development/think

Files you will work with:
- QUEUE.md — the work queue. Each entry has a checkbox and detailed implementation instructions.
- LOG.md — append-only run log. Append a single timestamped line per major action.
- STATUS.md — single-line current status. Overwrite (do not append) with what you're currently doing.

## Context

This is a TypeScript/Node CLI tool. Key technology:
- **cr-sqlite** (@vlcn.io/crsqlite-allinone) for CRDT-enabled SQLite — enables conflict-free P2P sync
- **commander** for CLI framework
- **bonjour-service** for mDNS LAN peer discovery
- **Node net module** for TCP sync transport
- **Anthropic SDK** for AI-powered summary generation
- **chalk** for terminal output formatting
- **date-fns** for date manipulation
- **uuid** (v7) for time-ordered unique IDs

Data lives at ~/.local/share/think/think.db, config at ~/.config/think/config.json.

The CLI command is "think" with these subcommands:
- `think log <message>` — log a note
- `think sync <message>` — shorthand for `think log --category sync` (work log for 1:1 meetings)
- `think list` — list entries with filters
- `think summary` — AI-powered weekly summary
- `think network sync` — P2P sync with discovered peers
- `think network status` — show sync peer info

## Your job, exactly

1. Read QUEUE.md. Find the FIRST entry whose checkbox is `[ ]` (not yet started).
   - If none, write `STATUS.md` with `idle: queue empty`, append `<timestamp> queue empty, exiting` to LOG.md, exit.

2. Announce in three places before starting work:
   - Print to stdout: `>>> RUNNING [<n>/<total>] <title>` so the human can grep for it
   - Overwrite STATUS.md with: `running [<n>/<total>] <title> — started <ISO timestamp>`
   - Append to LOG.md: `<ISO timestamp> START [<n>/<total>] <title>`

3. Mark the entry in-progress: change `[ ]` to `[~]` in QUEUE.md (use Edit). Do this BEFORE doing any work, so a crash leaves a breadcrumb.

4. Do the work. Follow the detailed instructions in the queue entry carefully. Each entry contains specific implementation steps and verification commands. Run the verification commands and ensure they pass before marking the task complete.

   Important implementation notes:
   - Use ESM imports (this is "type": "module")
   - All imports of local .ts files should use .js extensions (e.g., import { getDb } from './client.js') — this is required for ESM + TypeScript
   - Use the exact dependency versions and APIs described in the queue entry
   - Check the @vlcn.io/crsqlite-allinone package to understand its actual API before using it — don't assume. Read the installed package's types or README if needed.
   - When a task says to verify something, actually run the verification command and check the output
   - If a verification fails, debug and fix before marking complete

5. Record the result:
   - On success: change `[~]` to `[x]`, append a `note:` line under the entry with a brief summary of what was done
   - On failure: change `[~]` to `[!]`, append `note: error: <reason>`
   - Append `<timestamp> END [<n>/<total>] — <ok|error>` to LOG.md

6. EXIT. Do not pick up another entry. Do not loop. The shell loop runner is responsible for restarting you. Each invocation handles EXACTLY ONE entry.

## Hard rules

- Process ONE entry per invocation. Never run more than one task per invocation.
- If you encounter unexpected file state (e.g. multiple `[~]` entries), do not try to fix anything. Append a description to LOG.md and exit. The human will sort it out.
- If a STOP file exists in the working directory, exit immediately without doing anything. Append `<timestamp> STOP file present, exiting` to LOG.md first.
- Do not modify PROMPT.md or run.sh.
- If npm install fails or a package doesn't work as expected, check the actual installed package (read node_modules/package/README.md or types) before giving up.
- Always run build verification (npm run build or type checks) after writing code.
