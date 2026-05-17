import { getCortexDb } from './engrams.js';

/**
 * Recomputes `activity_seq` for every memory row in the given cortex.
 *
 * The sequence is the stable integer position of each entry within its cortex
 * when ordered by `(ts ASC, id ASC)`. Because `ts` and `id` come from L1
 * (not local arrival time), two peers that have synced the same content will
 * always compute identical `activity_seq` values — the assignment is
 * deterministic and peer-agnostic.
 *
 * seq=1 is the oldest entry; the maximum seq is the most recent. Recency
 * decay (AGT-291) uses `current_max_seq - entry_seq` as its anchor, so
 * recently-written entries always dominate regardless of wall-clock spread.
 *
 * Implementation: a single SQL UPDATE with an inline ranking subquery so the
 * entire pass is one round-trip to SQLite (O(N log N) sort, O(1) per-row
 * write). On-disk update volume is bounded by the index size — no row-by-row
 * loop, no per-row prepared-statement round-trips.
 *
 * Idempotent: calling this function twice on an unchanged cortex produces the
 * same values both times.
 *
 * Called by:
 *  - `reindex` (AGT-276) at the end of each cortex pass
 *  - daemon first-startup migration when any `activity_seq IS NULL` (AGT-292)
 */
export function recomputeActivitySeq(cortexName: string): void {
  const db = getCortexDb(cortexName);

  // Single-pass UPDATE using a CTE to rank all rows by (ts ASC, id ASC).
  // ROW_NUMBER() is available in SQLite 3.25+ (Node 22 ships SQLite 3.46+).
  db.exec(`
    WITH ranked AS (
      SELECT
        id,
        ROW_NUMBER() OVER (ORDER BY ts ASC, id ASC) AS seq
      FROM memories
      WHERE deleted_at IS NULL
    )
    UPDATE memories
    SET activity_seq = ranked.seq
    FROM ranked
    WHERE memories.id = ranked.id
  `);

  // Null-out deleted rows so they don't hold stale seq values.
  db.exec(`UPDATE memories SET activity_seq = NULL WHERE deleted_at IS NOT NULL`);
}

/**
 * Returns the next available `activity_seq` value for a new entry in the
 * given cortex (i.e. MAX(activity_seq) + 1).
 *
 * O(1) with the `idx_entries_activity_seq` index added in AGT-270 —
 * SQLite uses the index to satisfy `MAX(activity_seq)` without a full scan.
 *
 * Returns 1 when the cortex is empty or all rows have NULL activity_seq
 * (e.g. before the first recompute).
 *
 * Used by the daemon to stamp new writes with the next seq without re-running
 * a full recompute (AGT-286).
 */
export function assignNextSeq(cortexName: string): number {
  const db = getCortexDb(cortexName);
  const row = db.prepare(
    'SELECT COALESCE(MAX(activity_seq), 0) + 1 AS next_seq FROM memories WHERE deleted_at IS NULL'
  ).get() as { next_seq: number };
  return row.next_seq;
}
