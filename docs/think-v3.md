> This is the design doc that drove the v3 implementation. Engineering details may have shifted slightly during build — the canonical surface is the CLI itself; this captures intent and architecture.

---

# think-v3 — resident daemon, vector recall, write-time compaction

Major redesign of the think CLI, shipped as `@openthink/think@1.0.0-alpha.1` in the same repo. v0.6.x stays on the `main` branch for bug fixes only; v3 work happens on `release/v1.0.0-alpha` and merges to main once feature-complete. v2 commands are not removed in this scope — cleanup is a follow-up project.

## The reframe

v2 was "local-first memory, sync via folder." v3 is **"agent memory anchored in current intent, retrieved by topic in <100ms."** Three properties earn the version bump:

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
- **v2 JSONL stays readable.** v3 only adds optional fields to L1; v2 peers ignore them.

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

L1 entries migrated from v2 may carry `decisions` and `source_ids` fields; v3 never writes them and treats them as opaque. See [v2 -> v3 compatibility](#v2---v3-compatibility).

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
sync_cursors (...)                         -- v2 carry-over
```

## CLI surface (v3)

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

Both ship with v3. The hook handles guaranteed orientation; the MCP server handles agent-initiated continuous recall.

## Storage paths (renamed in v3)

- `~/.think/index/<cortex>.db` (was `~/.think/engrams/`)
- `~/.think/repo/` (unchanged — L1)
- `~/.think/daemon.sock` (new)
- `~/.think/daemon.pid` (new)
- `~/.think/config/config.json` (unchanged)

v3 on first launch reads `~/.think/engrams/` if present, migrates to `~/.think/index/`, leaves the old dir as backup until next major version.

## v2 -> v3 compatibility

- L1 JSONL format additive: new optional fields (`kind`, `compacted_from`, `topics`); v2 parsers ignore unknown fields
- v3 first launch reads existing L1 entries, treats them as `kind: "memory", compacted_from: null`, builds L2 index
- Existing entries are NOT retroactively compacted — they remain as raw entries, surface in recall via vector + FTS
- New v3 writes go through the compaction pipeline; coexist with legacy raw entries in the same cortex
- **Recall behavior change:** v2 `recall` used full-text search (exact keyword match). v3 `recall` is semantic vector search. Queries that relied on exact keyword matches (error codes, flag names, exact phrases) may return different result sets. FTS is not removed as a secondary fallback for migrated entries, but the primary ranking is now vector similarity.
- L1 entries migrated from v2 may carry `decisions` and `source_ids` fields; v3 never writes them and treats them as opaque.

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

- Removing v2 commands (curate, migrate-data, engram concepts, long-term backfill)
- Windows support hardening beyond basic compatibility
- Rust sidecar for embedding/vector ops (revisit if Node perf becomes a wall)
- Federated search across remote peers in real-time (current design retrieves from local L2s only)
- Topic canonicalization / clustering
- Multi-user daemon on a single machine
- A "lessons learned" UI for human-curated review of retros
