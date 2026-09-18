> This is the design doc that drove the current architecture (originally built as a major redesign shipped in `@openthink/think@1.0.0-alpha.1`, then simplified further in `3.0.0` when the pre-daemon write tier was removed). Engineering details may have shifted slightly during and after the build — the canonical surface is the CLI itself; this captures intent and architecture. Historical file name: `docs/think-v3.md`.

---

# Architecture — resident daemon, vector recall, write-time compaction

## The reframe

think's design used to be "local-first memory, sync via folder." It is now **"agent memory anchored in current intent, retrieved by topic in <100ms."** Three properties, all still true today, drove that redesign:

1. **Vector recall** — `recall` becomes a semantic similarity search, not FTS. The agent gets the right entries even when the query and the stored text don't share vocabulary.
2. **Write-time compaction** — when a memory lands, the daemon folds its trajectory into a single self-contained line (an LLM call). Read time stays sub-100ms; the trajectory is already baked in.
3. **Resident daemon** — a long-lived process holds the embedding model in memory. CLI calls talk to it over a Unix socket. No cold-start per `recall`.

The point is not "search is faster." The point is that recall becomes **cheap enough to call implicitly on every agent turn**, which inverts the discipline: the agent no longer has to decide *when* to recall — the system recalls *always* and filters to relevance.

## Architecture (five layers)

```
┌─────────────────────────────────────────────────┐
│  L5: Agent integration                          │
│  Claude Code UserPromptSubmit hook + MCP server │
└─────────────────────────────────────────────────┘
                       ↕
┌─────────────────────────────────────────────────┐
│  L4: CLI (think command)                        │
│  Thin client. Spawns or finds daemon.           │
└─────────────────────────────────────────────────┘
                       ↕ (Unix socket / JSON-line)
┌─────────────────────────────────────────────────┐
│  L3: Daemon (resident process)                  │
│  Embedding model resident, vector search,       │
│  write-time compaction queue, sync loops        │
└─────────────────────────────────────────────────┘
                       ↕
┌─────────────────────────────────────────────────┐
│  L2: Local index (SQLite, per-cortex)           │
│  ~/.think/index/<cortex>.db                     │
│  Rows + embeddings + seq numbers + compaction   │
│  links. Fully derivable from L1.                │
└─────────────────────────────────────────────────┘
                       ↕
┌─────────────────────────────────────────────────┐
│  L1: Storage (git-backed JSONL, per-cortex)     │
│  ~/.think/repo/  (branch per cortex)            │
│  Canonical, append-only, syncs across peers.    │
└─────────────────────────────────────────────────┘
```

**Invariants:**

- **L1 is the only source of truth.** L2 is purely derived; deleting it rebuilds.
- **L1 is the only thing that syncs.** Vectors are recomputed locally per peer.
- **Per-cortex isolation** at both L1 (git branches) and L2 (separate SQLite files). Cross-cortex queries federate.
- **Older JSONL stays readable.** The current schema only adds optional fields to L1; a peer running older code ignores fields it doesn't recognize.

## The entry model

Single unified L1 entry shape across all kinds:

```jsonc
{
  "id": "01ab...",                  // uuidv7 or deterministic
  "ts": "2026-05-12T19:00:00Z",
  "author": "Matt",
  "origin_peer_id": "2220...",
  "kind": "memory",                 // memory | retro | event
  "content": "...",                 // for memory: compacted by daemon; for retro/event: preserved as-written
  "topics": ["..."],                // LLM-extracted at write time; user can override via --topic
  "supersedes": [],                 // ids this entry replaces; set by compaction (memory) or supersession check (retro)
  "compacted_from": null,           // for memory only: raw entry ids this compaction folds; null = raw entry
  "deleted_at": null                // tombstone
}
```

L1 entries migrated from the pre-daemon tool may carry `decisions` and `source_ids` fields; the current write path never writes them and treats them as opaque. See [Legacy compatibility](#legacy-compatibility).

### Kinds

| Kind | Semantics | Write-time compaction? | Supersession check? |
|---|---|---|---|
| `memory` | Freeform observation, the sync stream | **Yes** (LLM rewrites with trajectory) | Implicit via compaction |
| `retro` | Durable wisdom about a codebase | No (text preserved exactly) | Yes (LLM marks conflicts) |
| `event` | Notable thing happened — milestone, decision, incident | No | No (events accumulate, don't conflict) |

No sub-kinds. Topics carry orthogonal structure when needed.

### L2 schema additions

```
entries (
  -- mirror of L1 fields:
  id, ts, author, origin_peer_id, kind, content, topics_json,
  supersedes_json, compacted_from_json, deleted_at,

  -- L2-only (derived):
  embedding BLOB,             -- Float32Array, 384-dim
  embedding_model TEXT,       -- model version that produced it
  activity_seq INTEGER        -- stable position from ORDER BY ts ASC, id ASC
)

compaction_links (raw_id, compacted_id)   -- reverse index for `think expand`
sync_cursors (...)                         -- carried over from the pre-daemon tool
```

## CLI surface

```
# Writes
think sync "<content>" [--topic <t>]         # kind=memory
think retro "<content>" [--topic <t>]        # kind=retro
think event "<content>" [--topic <t>]        # kind=event

# Reads
think recall "<query>" [--scope active|accessible|all]
                       [--cortex <name>] [--kind k] [--topic <t>]
                       [--limit n] [--full] [--since <ISO-datetime>] [--json]
think expand <entry_id>                      # raw + compacted bundle
think status [<cortex>]                      # alias for `think daemon status`; cortex arg scopes to one cortex

# Daemon lifecycle
think daemon start|stop|status               # explicit control
think daemon install                         # drops a user-level launch agent (macOS) or systemd user service (Linux); no sudo required

# Maintenance
think reindex [<cortex>]                     # rebuild L2 from L1
```

**`--scope` values:**

- `accessible` (default) — all locally-cloned cortexes (any cortex whose L1 repo branch exists locally)
- `active` — cortexes with CLI activity in the last ~24h (heuristic: updated L1 timestamp within the window)
- `all` — same as `accessible`; reserved for future cross-peer remote federation (currently equivalent)

**`--topic`:** Multiple `--topic` flags are accepted; the entry is tagged with all supplied topics (e.g. `think sync "..." --topic cli --topic daemon`).

**`--since <ISO-datetime>`:** Accepts `2026-05-01` or `2026-05-01T00:00:00Z`; filters results to entries written after the given timestamp.

**Recall output:** Each result includes the entry ID, kind, cortex provenance (when cross-cortex), and a 200-char content headline. IDs are always printed so `think expand <entry_id>` is reachable directly from recall output.

**`think status` and `think daemon status`:** `think status [<cortex>]` is an alias for `think daemon status`; the optional cortex arg limits output to a single cortex. Both print daemon health, socket state, last-sync timestamps per cortex, and compaction queue depth.

**`think daemon install`** drops a **user-level** agent (macOS `~/Library/LaunchAgents/`, Linux `~/.config/systemd/user/`). No sudo required. The daemon runs as the current user on login/session start.

Default recall output: top-8 entries, **headlines-by-default** (200-char truncation unless `--full`), grouped by kind, cortex provenance shown when cross-cortex. `--json` for machine-readable. Default `--scope=accessible` (all locally-cloned cortexes).

**CLI success messages:** `think sync` prints the entry ID and a human-readable status line (e.g., `stored · compaction queued`). The raw internal status string from the daemon is not exposed directly.

## Write path (kind=memory)

**Synchronous (CLI waits, ~10-30ms):**

1. CLI sends sync request to daemon over socket
2. Daemon writes raw entry to L1 immediately (`compacted_from: null`)
3. Daemon embeds raw entry, inserts L2 row with embedding + activity_seq
4. Daemon returns: `{ entry_id, status: "stored_raw, compaction_queued" }`
5. CLI prints success to user

**Asynchronous (daemon, ~1-2s later):**

1. Compaction queue picks up the entry
2. Vector search L2 for top-K most similar entries (k=10, recency-weighted, threshold >= 0.6)
3. **Triage gate:** if no candidates above threshold, skip the LLM call entirely — raw entry IS the current state. Saves ~70% of LLM calls.
4. If candidates exist, LLM call (compaction prompt)
5. Daemon writes a NEW entry to L1: `kind=memory, compacted_from=[raw_id], supersedes=[ids], topics=[...]`, content is the compacted line
6. L2 updated; superseded entries marked

Default recall surfaces compacted entries; raw entries surface only when no compaction exists for them (in-flight window) or via `--full`.

## Write path (kind=retro and kind=event)

Synchronous: same as memory but `compacted_from: null` permanently. Text never gets rewritten.

For retros only, async supersession check:

1. Vector search L2 for top-K similar same-kind entries (threshold gate)
2. If candidates, LLM call (supersession prompt)
3. Apply: mark superseded entries; if `is_duplicate: true`, daemon may skip storing

Events skip the supersession check entirely — they accumulate.

## Read path

Recall is pure vector math + retrieval + structured rendering. **No LLM at read time.**

1. Daemon embeds the query (~30ms via resident model)
2. Federate across accessible cortexes (parallel SQL queries per cortex L2 file)
3. Per cortex: cosine similarity search ranked by `cosine x recency_weight`
4. Filter: prefer compacted over raw, drop superseded, drop deleted
5. Merge results across cortexes, re-rank, truncate to `--limit`
6. Render to CLI

Activity-based recency: `recency_weight = exp(-decay x (current_seq - entry_seq))`, where `seq` is the entry's stable position in `ORDER BY ts ASC, id ASC` within its cortex. Decay tunable; default chosen so the last ~20 entries on any topic always dominate regardless of wall-clock spread.

## Daemon

**Process model:**

- Single global daemon per user; one process serves all cortexes via cortex parameter on every API call
- Per-user socket at `~/.think/daemon.sock` (macOS/Linux) or localhost TCP on Windows
- Auto-start on first CLI call (CLI spawns detached + unrefs; no daemon-management package needed)
- Stays alive (restart cost = 1-2s model load + ~500MB resident memory)
- Optional `think daemon install` drops a launch-agent / systemd-user-service file

**API surface (JSON-line over socket):**

```
recall(cortex|scope, query, opts)    → entries[]
sync(cortex, content, kind, topics?) → { entry_id, status }
expand(cortex, entry_id)             → raw + compacted bundle
fetch(cortex)                        → pull from remote
status(cortex?)                      → health/state/last-sync
reindex(cortex)                      → rebuild L2 from L1
shutdown                             → graceful stop
```

**Background loops:**

- **Push**: on any L1 write, debounce 500ms, then `git commit && git push` per cortex
- **Pull (polling)**: per cortex; active mode every 5-10s (recent CLI traffic), idle mode every 60-120s
- **Pull (subscribe)**: WebSocket connection to think-serve proxy for near-realtime notifications; on notify, fetch immediately. Falls back to polling if disconnected.
- **Compaction**: pulls from in-memory queue, runs prompts, writes results to L1, indexes into L2

## Embeddings + vector search

- **Model**: `bge-small-en-v1.5` via `@huggingface/transformers` (33M params, 384-dim, MIT-licensed). Auto-downloaded + cached on first daemon start.
- **Index**: `sqlite-vec` extension loaded into `better-sqlite3`. Sub-10ms cosine search up to ~100K vectors. Brute-force cosine in SQL is the fallback (handles up to ~50K with acceptable latency).
- **Determinism**: same model + same text = same vector. Vectors never sync between peers (always recomputed locally). Different peers running the same model produce equivalent indexes.

## Agent integration

Two surfaces, both talk to the same daemon:

1. **Claude Code `UserPromptSubmit` hook** — fires on every prompt; reads cwd, maps to cortex(es), calls `think recall --scope accessible <prompt>`, injects via `hookSpecificOutput`. Provides session-start orientation and per-prompt grounding.

2. **MCP server** — exposes `think_recall`, `think_sync`, `think_expand` as tools. Agent calls reflexively mid-turn because tool latency is <100ms. Best for topic shifts within a session.

Both surfaces talk to the same daemon. The hook handles guaranteed orientation; the MCP server handles agent-initiated continuous recall.

## Storage paths

- `~/.think/index/<cortex>.db` — L2, the per-cortex vector index (previously the pre-daemon tool's vector-index directory under a different name; a one-time migration on first launch renames the directory if the new one doesn't already exist, leaving a timestamped backup of the old copy when both exist).
- `~/.think/repo/` — L1, the git-backed canonical store.
- `~/.think/daemon.sock` / `~/.think/daemon.pid` — daemon lifecycle files.
- `~/.config/think/config.json` (or `$XDG_CONFIG_HOME/think/config.json`) — user config. Under a custom `THINK_HOME`, config instead lives at `<THINK_HOME>/config/config.json`.

## Legacy compatibility

think's current write path is additive, not a hard break from what the pre-daemon tool wrote:

- L1 JSONL format is additive: new optional fields (`kind`, `compacted_from`, `topics`); older parsers ignore fields they don't recognize.
- On first launch against an existing L1 repo, entries with no `kind` field are treated as `kind: "memory", compacted_from: null` and indexed into L2.
- Those entries are NOT retroactively compacted — they remain as raw entries and surface in recall via vector search (FTS remains a secondary fallback).
- New writes go through the compaction pipeline and coexist with un-compacted legacy entries in the same cortex.
- **Recall behavior change (historical).** The pre-daemon tool's `recall` used full-text search (exact keyword match); the current `recall` is semantic vector search. Queries that relied on exact keyword matches (error codes, flag names, exact phrases) may return different result sets than they used to.
- L1 entries migrated from the pre-daemon tool may carry `decisions` and `source_ids` fields; the current write path never writes them and treats them as opaque.
- **The pre-daemon write tier itself was removed in `3.0.0`.** Every write command now produces a `memory`, an `event`, or a `retro`, through the daemon — there is no other write tier, and `insertEngram` and its callers are deleted from the codebase. Its underlying table is left in place, read-only, for exactly one major version, so the one-shot migration (`think migrate-engrams`, and automatically on first daemon start) can rescue any row a pre-3.0.0 install left stranded there; dropping the table itself is deferred to the major after `3.0.0`.

## Failure modes

| Failure | Behavior |
|---|---|
| Compaction LLM fails | Raw entry remains in L1 as current; queue retries with backoff. After N failures, mark compaction-skipped permanently, log loudly. |
| Supersession LLM fails | Entry stored; supersession queue retries. After N failures, accept no supersession was computed. |
| Daemon crashes mid-compaction | Raw is durable; on restart, daemon scans L1 for memory entries with no corresponding compaction — re-queues. |
| Daemon crashes mid-write (after L1, before L2) | L1 durable; daemon catches up L2 by walking entries past last-indexed activity_seq. |
| Stale socket from prior crash | Connect health-check; if dead, unlink and rebind. |
| Multiple simultaneous CLI processes | Second connects to existing daemon. No contention. |
| Embedding model corrupted/missing | Re-download on startup; fail loudly if unavailable. |
| Git push fails (network out) | Write succeeded locally; push deferred to next interval. Mild eventual-consistency. |

## Build sequence (high-level)

Phases below correspond to ticket groups. Tickets within a phase are mostly parallelizable; phases gate on prior phases for dependencies.

- **Phase 0**: L1/L2 schema extensions (kind, compacted_from, supersedes, topics, embedding column)
- **Phase 1**: Embedding pipeline (`@huggingface/transformers` wrapper, reindex command)
- **Phase 2**: Daemon scaffold (socket, protocol, lifecycle, basic API)
- **Phase 3**: Activity-based recency + recency-weighted retrieval
- **Phase 4**: New write commands (`think sync`/`retro`/`event` routed through daemon)
- **Phase 5**: Write-time compaction (queue, prompt, supersession links)
- **Phase 6**: Retro supersession check
- **Phase 7**: Cross-cortex federation
- **Phase 8**: Sync push debounce + proxy-subscribe client
- **Phase 9**: Hook + MCP integration
- **Phase 10**: Documentation + version bump

## Out of scope (deferred)

- **Dropping the legacy write-tier table / schema migration.** The write tier itself was removed in `3.0.0` — see [Legacy compatibility](#legacy-compatibility) above and the README's "Upgrading to 3.0" table for exactly what that included. That table stays, read-only, for one major so the one-shot rescue migration has somewhere to read stranded rows from; actually dropping it is a later change.
- Windows support hardening beyond basic compatibility
- Rust sidecar for embedding/vector ops (revisit if Node perf becomes a wall)
- Federated search across remote peers in real-time (current design retrieves from local L2s only)
- Topic canonicalization / clustering
- Multi-user daemon on a single machine
- A "lessons learned" UI for human-curated review of retros
