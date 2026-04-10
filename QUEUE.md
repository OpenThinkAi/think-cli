# think — Build Queue

- [x] **Project scaffold**
  - Initialize npm project in ~/Work/Development/think
  - Create package.json with: name "think", type "module", bin entry pointing to ./dist/index.js
  - Dependencies: @anthropic-ai/sdk, better-sqlite3, @vlcn.io/crsqlite-allinone, bonjour-service, chalk, commander, date-fns, uuid
  - Dev dependencies: @types/better-sqlite3, @types/node, @types/uuid, tsup, tsx, typescript
  - Create tsconfig.json targeting ES2022, NodeNext module resolution, strict mode, outDir ./dist
  - Create tsup.config.ts: entry src/index.ts, ESM format, target node20, external better-sqlite3 and @vlcn.io/crsqlite, banner with #!/usr/bin/env node, clean true
  - Create .gitignore (node_modules, dist, data, *.db)
  - Create directory structure: src/db/, src/sync/, src/commands/, src/lib/
  - Run npm install and verify it succeeds
  - Run npx tsc --noEmit to verify TypeScript config works (empty project is fine, just no config errors)
  - note: Do NOT create any .ts source files yet — just the scaffold and config files
  - note: Done. Used @vlcn.io/crsqlite-allinone@0.15.2 (latest available). Required Node 20 (pinned via .nvmrc) due to import assert syntax in @vlcn.io/crsqlite install script being removed in Node 22+.

- [x] **Database layer — client.ts**
  - Create src/db/client.ts
  - Implement getDb() singleton that: creates ~/.local/share/think/ directory if needed, opens better-sqlite3 database at ~/.local/share/think/think.db, loads cr-sqlite extension via @vlcn.io/crsqlite-allinone, sets WAL journal mode and NORMAL synchronous, calls ensureSchema() from schema module, returns the db instance
  - Implement closeDb() that closes the db and resets the singleton
  - Implement getDataDir() that returns ~/.local/share/think/ (respects XDG_DATA_HOME env var if set)
  - Export all functions
  - Verify it compiles: npx tsx src/db/client.ts should run without errors (it will create the db file)
  - note: Done. Used better-sqlite3 directly with @vlcn.io/crsqlite extensionPath for loading. closeDb() calls crsql_finalize() before closing. Created minimal schema.ts stub for the import (next task will implement it). Requires Node 20 (nvm use 20) due to native module compatibility.

- [x] **Database layer — schema.ts**
  - Create src/db/schema.ts
  - Implement ensureSchema(db) that creates tables if they don't exist:
    - entries table: id TEXT PRIMARY KEY NOT NULL, timestamp TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'manual', category TEXT NOT NULL DEFAULT 'note', content TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]' — use STRICT mode
    - sync_peers table: peer_id TEXT PRIMARY KEY, last_synced_db_version INTEGER NOT NULL DEFAULT 0, hostname TEXT, last_seen TEXT
    - After creating entries table, call: SELECT crsql_as_crr('entries') — this makes it CRDT-aware
  - Export ensureSchema
  - NOTE: crsql_as_crr() must be called AFTER table creation but before any inserts. It only needs to be called once (it's idempotent if table already registered). Wrap in try/catch in case already registered.
  - Verify by importing from client.ts and running: npx tsx -e "import { getDb } from './src/db/client.js'; const db = getDb(); console.log('ok')"
  - note: Done. entries table created with STRICT mode, crsql_as_crr('entries') called with try/catch, sync_peers table created. Verified: both tables present with correct schemas, cr-sqlite internal tables confirm CRR registration.

- [x] **Database layer — queries.ts**
  - Create src/db/queries.ts
  - Import getDb from client.ts, uuid v7 from uuid package
  - Implement insertEntry({ content, source?, category?, tags? }): generates UUID v7 id, ISO 8601 timestamp, inserts into entries, returns the full entry object
  - Implement getEntries({ since?: Date, until?: Date, category?: string, tag?: string, limit?: number }): flexible query with optional filters, ordered by timestamp DESC, tag filter uses JSON contains on tags column (use LIKE '%"tagname"%' for simplicity)
  - Implement getEntriesByWeek(weeksAgo?: number): convenience wrapper, returns entries from Monday 00:00 to Sunday 23:59 of the specified week (0 = current week)
  - Implement getDbVersion(): returns result of SELECT crsql_db_version()
  - Implement getChangeset(sinceVersion: number): returns rows from SELECT * FROM crsql_changes WHERE db_version > ?
  - Implement applyChangeset(changes: any[]): inserts rows into crsql_changes table
  - Implement getPeerInfo(peerId: string) and updatePeerInfo(peerId, dbVersion, hostname)
  - Export all functions
  - Write a quick smoke test: npx tsx -e "import { insertEntry, getEntries } from './src/db/queries.js'; insertEntry({ content: 'test entry' }); console.log(getEntries({}))"
  - note: Done. All functions implemented with typed interfaces (Entry, InsertEntryParams, GetEntriesParams, PeerInfo). Smoke test verified: insert, query with filters, tag filter, week query, db version, peer info CRUD all working.

- [x] **Config module**
  - Create src/lib/config.ts
  - Implement getConfigDir(): returns ~/.config/think/ (respects XDG_CONFIG_HOME)
  - Implement getConfig() / saveConfig(): reads/writes ~/.config/think/config.json
  - Config shape: { peerId: string, syncPort: number, anthropicApiKey?: string }
  - On first getConfig() call, if no config exists, generate a new UUID v4 peerId, set syncPort to 47821, save and return
  - Export all functions
  - note: Done. Config module with typed Config interface, XDG_CONFIG_HOME support, auto-generation of UUID v4 peerId and default syncPort 47821. All functions verified working.

- [x] **CLI entrypoint and log command**
  - Create src/index.ts as the main CLI entrypoint using commander
  - Register the program as "think" with a description and version
  - Create src/commands/log.ts implementing the "log" command:
    - Usage: think log <message> [options]
    - Options: --source <source> (default: "manual"), --category <category> (default: "note"), --tags <tags> (comma-separated), --silent (suppress output)
    - Action: calls insertEntry() with the provided data, prints confirmation unless --silent
    - Categories should include at minimum: note, sync (for work log / 1:1 sync entries), meeting, decision, idea
  - Also add a convenience subcommand: think sync <message> — shorthand for think log <message> --category sync
  - Register log and sync commands in index.ts
  - Build with npm run build
  - Test: npx tsx src/index.ts log "test message" --category sync --tags "test,first"
  - Test: npx tsx src/index.ts sync "test sync message"
  - Verify both entries appear: npx tsx -e "import { getEntries } from './src/db/queries.js'; console.log(JSON.stringify(getEntries({}), null, 2))"
  - note: Done. Created src/index.ts (commander entrypoint) and src/commands/log.ts (log + sync commands). Both commands verified working: log with --category/--tags, sync shorthand. Build succeeds. Entries confirmed in database.

- [x] **List command**
  - Create src/commands/list.ts implementing the "list" command:
    - Usage: think list [options]
    - Options: --since <date>, --until <date>, --category <category>, --tag <tag>, --limit <n> (default 20), --week (shorthand for current week), --last-week
    - Action: calls getEntries() or getEntriesByWeek() with filters, formats and prints a table
    - Output format: each entry on one line with timestamp, category badge, and content. Use chalk for coloring categories.
    - Example output:
      ```
      2026-04-09 14:30  [sync]     shipped the auth fix
      2026-04-09 11:15  [note]     idea for caching layer
      2026-04-08 16:00  [meeting]  standup — discussed deploy timeline
      ```
  - Register in src/index.ts
  - Build and test: npx tsx src/index.ts list --week
  - note: Done. Created src/commands/list.ts with color-coded category badges (chalk), --week/--last-week/--since/--until/--category/--tag/--limit filters. Registered in index.ts. Build and all tests pass.

- [x] **Summary command**
  - Create src/lib/claude.ts:
    - Import Anthropic SDK
    - Implement generateSummary(entries: Entry[]): takes array of entries, sends to Claude API with a system prompt asking for a well-organized weekly summary suitable for a 1:1 meeting, returns the formatted text
    - System prompt should instruct Claude to: group by theme not by day, highlight accomplishments, note key decisions, mention meetings, use a professional tone, output markdown
    - Use ANTHROPIC_API_KEY from env var or from config
    - Model: claude-sonnet-4-6 (fast and cheap for summarization)
  - Create src/commands/summary.ts implementing the "summary" command:
    - Usage: think summary [options]
    - Options: --week (current week, default), --last-week, --since <date>, --until <date>, --category <category>, --tag <tag>, --raw (skip AI formatting, just dump entries)
    - Action: fetches entries for the range, if --raw prints them as a formatted list, otherwise calls generateSummary() and prints the result
    - If no entries found, print a helpful message
  - Register in src/index.ts
  - Build and test with --raw flag first: npx tsx src/index.ts summary --week --raw
  - note: Testing with actual Claude API requires ANTHROPIC_API_KEY to be set. The --raw path should work without it.
  - note: Done. Created src/lib/claude.ts (Anthropic SDK wrapper with system prompt for themed summaries) and src/commands/summary.ts (--week/--last-week/--since/--until/--category/--tag/--raw options). Falls back to raw output on API error. Build, type check, and --raw tests all pass.

- [x] **Sync protocol and types**
  - Create src/sync/protocol.ts defining:
    - Message type union: Hello, RequestChanges, Changes, Ack, Done
    - Hello: { type: 'hello', peerId: string, dbVersion: number }
    - RequestChanges: { type: 'request_changes', sinceVersion: number }
    - Changes: { type: 'changes', changes: any[], fromVersion: number, toVersion: number }
    - Ack: { type: 'ack', version: number }
    - Done: { type: 'done' }
    - Implement encodeMessage(msg: Message): string — JSON.stringify + newline
    - Implement createMessageParser(): returns a transform that takes chunks and emits parsed Message objects (split on newlines, JSON.parse each line)
    - Export all types and functions
  - note: Done. All 5 message types defined as TypeScript interfaces with a Message union type. encodeMessage() serializes to JSON + newline. createMessageParser() is a stateful push-based parser that handles chunked TCP delivery and partial lines correctly. Includes flush() for draining remaining buffer. Type checks, build, and smoke tests all pass.

- [x] **Sync TCP server**
  - Create src/sync/server.ts:
    - Implement startSyncServer(port: number): creates a net.Server, listens on 0.0.0.0:port
    - On connection: run the sync handshake as the server side
    - Handshake (server perspective):
      1. Receive Hello from client
      2. Send Hello back with own peerId and dbVersion
      3. Receive RequestChanges with sinceVersion
      4. Query getChangeset(sinceVersion), send Changes message
      5. Send own RequestChanges for changes since last known version of this peer
      6. Receive Changes from client, apply with applyChangeset()
      7. Send Ack, receive Ack
      8. Exchange Done messages, close connection
    - Update sync_peers table after successful sync
    - Handle errors gracefully — log and close connection, don't crash the server
  - Export startSyncServer and stopSyncServer
  - note: Done. State-machine based connection handler with 6 states (wait_hello → wait_request_changes → wait_changes → wait_ack → wait_done → done). Uses createMessageParser for TCP chunk handling. Server starts/stops cleanly on port 47821. Type check and build pass.

- [x] **Sync TCP client**
  - Create src/sync/client.ts:
    - Implement syncWithPeer(host: string, port: number): connects via net.createConnection
    - Runs the sync handshake as the client side (mirror of server):
      1. Send Hello
      2. Receive Hello
      3. Send RequestChanges (using last known version for this peer from sync_peers)
      4. Receive Changes, apply with applyChangeset()
      5. Receive RequestChanges from server
      6. Query getChangeset(), send Changes
      7. Exchange Ack and Done
    - Update sync_peers table after successful sync
    - Returns a result object: { peerHostname, changesSent, changesReceived }
  - Export syncWithPeer
  - note: Done. State-machine client with 5 states (wait_hello → wait_changes → wait_request_changes → wait_ack → wait_done → done). Promise-based API returning SyncResult. Integration test verified: full handshake completes between server and client on loopback. Type check and build pass.

- [x] **mDNS discovery**
  - Create src/sync/discovery.ts:
    - Import Bonjour from bonjour-service
    - SERVICE_TYPE = 'think-sync'
    - Implement advertise(peerId: string, port: number): publishes mDNS service with txt record containing peerId
    - Implement discoverPeers(timeoutMs?: number): returns Promise<PeerInfo[]> — browses for SERVICE_TYPE, collects peers for timeoutMs (default 3000), filters out own peerId, returns list
    - PeerInfo: { host: string, port: number, peerId: string, name: string }
    - Implement stopDiscovery(): cleans up bonjour instance
  - Export all functions
  - note: Done. Exported DiscoveredPeer interface, advertise(), discoverPeers(), and stopDiscovery(). Singleton Bonjour instance pattern. Advertise publishes with txt record containing peerId. Discovery browses for 'think-sync' type, prefers IPv4 addresses, filters out own peerId and deduplicates. Integration test verified: advertise + discover with self-filtering works correctly. Type check and build pass.

- [x] **Sync commands**
  - Create src/commands/sync-run.ts implementing "network sync" (to avoid collision with the "sync" log shorthand):
    - Usage: think network sync [options]
    - Options: --host <host> (connect to specific peer instead of discovering), --port <port>, --timeout <ms>
    - Action: if --host provided, sync directly with that peer. Otherwise, discover peers via mDNS, sync with each discovered peer, print results.
    - Output: show discovered peers, sync progress, and summary of changes exchanged
  - Create src/commands/sync-status.ts implementing "network status":
    - Usage: think network status
    - Action: reads sync_peers table, shows each peer's hostname, last sync time, and version info
    - No network I/O — just a local DB read
  - Register both under a "network" command group in src/index.ts so the CLI structure is:
    - think log <message> — log an entry
    - think sync <message> — shorthand for log --category sync
    - think list — list entries
    - think summary — generate summary
    - think network sync — run network sync with peers
    - think network status — show sync peer status
  - Build and test: npx tsx src/index.ts network status
  - note: Done. Created sync-run.ts (mDNS discovery + direct host sync with progress output) and sync-status.ts (local DB peer listing). Added getAllPeers() to queries.ts. Registered under "network" command group in index.ts. Type check, build, and network status test all pass.

- [x] **npm link and final integration test**
  - Run npm run build to compile everything
  - Run npm link to make "think" available globally
  - Run a full integration test sequence:
    1. think log "test note" — should create an entry
    2. think sync "test sync entry" — should create a sync-category entry
    3. think log "test with tags" --tags "test,integration" — should work with tags
    4. think list --week — should show all entries
    5. think summary --week --raw — should show raw summary
    6. think network status — should show empty peer list (no syncs yet)
  - If any step fails, fix the issue before marking complete
  - Ensure the "think" binary is on PATH and works from any directory
  - note: Done. Fixed @vlcn.io/crsqlite needing to be marked external in tsup.config.ts (extensionPath uses import.meta.url which breaks when bundled). All 6 integration tests pass. think binary works globally from any directory via npm link.

- [x] **Git init and initial commit**
  - cd ~/Work/Development/think
  - git init
  - Verify .gitignore excludes: node_modules, dist, *.db, data/
  - git add all project files
  - git commit with message: "Initial commit: think CLI — local-first note and work log tool"
  - Do NOT push to any remote
  - note: Done. Initialized git repo, staged 21 project files (excluded build queue infrastructure: QUEUE.md, LOG.md, STATUS.md, PROMPT.md, run.sh, LOG.raw.jsonl). Commit e5c8cb4. No remote push.
