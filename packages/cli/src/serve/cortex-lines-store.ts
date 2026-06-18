/**
 * Cortex line store — AGT-571, cortex-sync hub.
 *
 * The SQLite-backed store that holds cortex memory *lines* keyed by cortex
 * with a monotonic **per-cortex** `server_seq`. This is the backbone of
 * cursor-based pull: a client persists the max `server_seq` it has consumed
 * and asks for everything past it. This module is the STORE only — the HTTP
 * push/pull routes that call these functions are AGT-572.
 *
 * It backs the AGT-570 wire contract verbatim (`sync/hub-protocol.ts`,
 * `docs/cortex-sync-protocol.md`): {@link appendCortexLine} accepts a
 * {@link WireMemoryLine} (the exact shape git/fs adapters serialize) and
 * {@link readCortexLines} returns {@link StoredLine}s (the wire line plus the
 * server-assigned `server_seq` and the resolved content-derived `id`).
 *
 * ---------------------------------------------------------------------------
 * Per-cortex `server_seq`: mechanism and why it's collision-safe
 * ---------------------------------------------------------------------------
 *
 * The wire contract demands a sequence that is strictly monotonic and
 * **independent per cortex** ("sequences are not comparable across cortexes").
 * `events.server_seq` uses `INTEGER PRIMARY KEY AUTOINCREMENT`, but that is a
 * single *global* rowid counter — wrong granularity here. So this store
 * allocates the next seq itself, inside one write transaction:
 *
 *     BEGIN IMMEDIATE
 *     next = COALESCE(MAX(server_seq), 0) + 1  WHERE cortex = ?
 *     INSERT OR IGNORE … (cortex, id, server_seq=next, …)
 *     -- on a replay (UNIQUE (cortex,id) collision) the INSERT is ignored;
 *     -- read back the row's existing server_seq and return THAT, never `next`.
 *     COMMIT
 *
 * This is collision-safe for the **same** reason `events` AUTOINCREMENT is
 * safe: `think serve` is single-process / single-writer (the v2 single-tenant
 * decision in `db/schema.ts`). With one writer, the read-MAX-then-insert pair
 * cannot interleave with another append, so two lines in the same cortex can
 * never be handed the same `next`. The transaction makes the MAX→INSERT atomic
 * against itself and gives all-or-nothing rollback. `BEGIN IMMEDIATE` takes the
 * write lock up front so the allocation is serialized even if a future caller
 * shares the handle across async tasks.
 *
 * What would break this (deliberately out of scope for v1): a multi-writer hub
 * (multiple processes / connections appending concurrently) could have two
 * writers each read the same MAX and assign the same `next`. That topology
 * would need a dedicated per-cortex sequence table (`cortex_seq(cortex PK,
 * next_seq)`) bumped under a row lock, or a DB that supports a real per-key
 * sequence. We do NOT rely on `server_seq` being dense — the wire contract
 * explicitly permits gaps (a rolled-back transaction may burn a value), and
 * the cursor logic is always "everything with `server_seq > cursor`", never
 * arithmetic on the value.
 *
 * ---------------------------------------------------------------------------
 * Idempotent replay
 * ---------------------------------------------------------------------------
 *
 * Memory ids are content-derived (`deterministicId(ts, author, content)`), so
 * re-pushing a line that was already stored MUST be a no-op: it must not
 * duplicate the row and must not reassign its `server_seq`. The
 * `cortex_lines_cortex_id_unique` index + `INSERT OR IGNORE` gives that — a
 * replayed line is ignored, and {@link appendCortexLine} returns the row's
 * ORIGINAL `server_seq` with `inserted: false`. This mirrors how the events
 * scheduler tolerates connector id replays via `events_sub_id_unique`.
 */

import type { Database } from './db.js';
import { deterministicId } from '../lib/deterministic-id.js';
import {
  type WireMemoryLine,
  type StoredLine,
  PULL_DEFAULT_LIMIT,
} from '../sync/hub-protocol.js';

/**
 * Outcome of {@link appendCortexLine}.
 * - `server_seq` is the authoritative per-cortex sequence for the line (the
 *   newly assigned value when stored, or the pre-existing value on a replay).
 * - `id` is the resolved content-derived id.
 * - `inserted` is `true` iff this call was the one that stored the line
 *   (`false` on an idempotent replay). Maps to the wire `status`
 *   (`accepted`/`duplicate`) the AGT-572 route reports.
 */
export interface AppendResult {
  server_seq: number;
  id: string;
  inserted: boolean;
}

/** The raw row shape as it comes back from SQLite. */
interface CortexLineRow {
  id: string;
  server_seq: number;
  ts: string;
  author: string;
  content: string;
  source_ids: string;
  episode_key: string | null;
  decisions: string | null;
  origin_peer_id: string | null;
}

/**
 * Append one memory line to `cortex`, assigning the next per-cortex
 * `server_seq`. Idempotent on the content-derived id: re-appending an
 * already-stored line returns its original `server_seq` with `inserted:
 * false` and writes nothing.
 *
 * The id is always recomputed from `(ts, author, content)` — the wire line
 * never carries one (see `WireMemoryLine`), and the server never trusts a
 * client-supplied id for memories.
 *
 * Runs in a single `BEGIN IMMEDIATE` transaction so the MAX→INSERT allocation
 * is atomic and rolls back cleanly on error. See the module header for why the
 * per-cortex allocation is collision-safe under the single-writer invariant.
 */
export function appendCortexLine(
  db: Database,
  cortex: string,
  line: WireMemoryLine,
  now: () => string = () => new Date().toISOString(),
): AppendResult {
  const id = deterministicId(line.ts, line.author, line.content);
  const createdAt = now();

  db.exec('BEGIN IMMEDIATE');
  try {
    const maxRow = db
      .prepare(
        'SELECT COALESCE(MAX(server_seq), 0) AS max_seq FROM cortex_lines WHERE cortex = ?',
      )
      .get(cortex) as { max_seq: number };
    const nextSeq = maxRow.max_seq + 1;

    // INSERT OR IGNORE: a replayed (cortex, id) collides on the UNIQUE index
    // and is silently dropped, so `changes` tells us whether we stored it.
    const info = db
      .prepare(
        `INSERT OR IGNORE INTO cortex_lines
           (cortex, id, server_seq, ts, author, content, source_ids,
            episode_key, decisions, origin_peer_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        cortex,
        id,
        nextSeq,
        line.ts,
        line.author,
        line.content,
        JSON.stringify(line.source_ids),
        line.episode_key ?? null,
        line.decisions === undefined ? null : JSON.stringify(line.decisions),
        line.origin_peer_id ?? null,
        createdAt,
      );

    const inserted = Number(info.changes) > 0;
    let serverSeq = nextSeq;
    if (!inserted) {
      // Replay: the row already exists. Read back its ORIGINAL seq — never the
      // `nextSeq` we computed and didn't use — so a replayed line keeps its
      // first-assigned sequence (AC: idempotent re-append).
      const existing = db
        .prepare('SELECT server_seq FROM cortex_lines WHERE cortex = ? AND id = ?')
        .get(cortex, id) as { server_seq: number };
      serverSeq = existing.server_seq;
    }

    db.exec('COMMIT');
    return { server_seq: serverSeq, id, inserted };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* best effort — the original error is the one that matters */
    }
    throw err;
  }
}

/**
 * Range-read: return the stored lines for `cortex` whose `server_seq` is
 * strictly greater than `cursor`, ordered by `server_seq` ascending, capped at
 * `limit` rows. `cursor` defaults to 0 ("from the beginning"); `limit` defaults
 * to {@link PULL_DEFAULT_LIMIT}.
 *
 * Returns {@link StoredLine}s shaped to satisfy the wire pull contract: the
 * optional wire fields are only present when stored (mirroring the adapters'
 * conditional spread), and JSON-encoded columns (`source_ids`, `decisions`)
 * are parsed back to arrays.
 */
export function readCortexLines(
  db: Database,
  cortex: string,
  cursor = 0,
  limit: number = PULL_DEFAULT_LIMIT,
): StoredLine[] {
  const rows = db
    .prepare(
      `SELECT id, server_seq, ts, author, content, source_ids,
              episode_key, decisions, origin_peer_id
         FROM cortex_lines
        WHERE cortex = ? AND server_seq > ?
        ORDER BY server_seq ASC
        LIMIT ?`,
    )
    .all(cortex, cursor, limit) as unknown as CortexLineRow[];

  return rows.map((r) => {
    const line: StoredLine = {
      id: r.id,
      server_seq: r.server_seq,
      ts: r.ts,
      author: r.author,
      content: r.content,
      source_ids: JSON.parse(r.source_ids) as string[],
      kind: 'memory',
      // Spread optional fields only when present so the returned object mirrors
      // the wire line shape (no explicit `undefined`/`null` keys serialized).
      ...(r.episode_key !== null ? { episode_key: r.episode_key } : {}),
      ...(r.decisions !== null
        ? { decisions: JSON.parse(r.decisions) as string[] }
        : {}),
      ...(r.origin_peer_id !== null
        ? { origin_peer_id: r.origin_peer_id }
        : {}),
    };
    return line;
  });
}

/**
 * The cortex's current high-water mark: the max `server_seq` stored for it, or
 * `0` when the cortex has no lines. Used by AGT-572's push route to report
 * `maxServerSeq` (observability only — clients never advance their pull cursor
 * from it). Exposed here so the route doesn't reach into the table directly.
 */
export function maxCortexSeq(db: Database, cortex: string): number {
  const row = db
    .prepare(
      'SELECT COALESCE(MAX(server_seq), 0) AS max_seq FROM cortex_lines WHERE cortex = ?',
    )
    .get(cortex) as { max_seq: number };
  return row.max_seq;
}
