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
 * Implementation: two SQL statements wrapped in a single transaction —
 * (1) a CTE UPDATE that ranks all live rows by (ts ASC, id ASC) and assigns
 * their seq in one SQL pass (O(N log N) sort, no per-row round-trips), and
 * (2) a targeted NULL-out of tombstoned rows so deleted entries never hold
 * stale seq values. The transaction makes both updates atomic so a concurrent
 * soft-delete landing between the two statements cannot produce a split state.
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

  // Wrap both statements in a transaction so a concurrent soft-delete landing
  // between them cannot leave a deleted row with a stale non-null activity_seq.
  // node:sqlite uses BEGIN/COMMIT/ROLLBACK (no db.transaction() wrapper).
  db.exec('BEGIN');
  try {
    // CTE ranks all live rows by (ts ASC, id ASC).
    // ROW_NUMBER() OVER requires SQLite 3.25+; UPDATE ... FROM requires 3.35+.
    // Node 22 ships SQLite 3.46+, satisfying both floors.
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

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
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

/**
 * Checks whether any live rows in the given cortex have a NULL `activity_seq`
 * and, if so, calls `recomputeActivitySeq` to backfill them.
 *
 * This is the daemon boot-time check (AGT-292 AC #2). It is a named function
 * so tests can target it directly without spinning up a full daemon.
 *
 * The check is O(1): SQLite satisfies `COUNT(*) WHERE activity_seq IS NULL`
 * via a targeted partial scan; on a fully-stamped cortex the query returns
 * immediately without touching the recompute path.
 *
 * @param writeLine - optional logger (e.g. daemon's `writeLine`); when omitted
 *   no log is produced. The INFO message is intentionally brief — one line per
 *   cortex that actually needs backfilling.
 */
export function backfillActivitySeqIfNeeded(
  cortexName: string,
  writeLine?: (msg: string) => void,
): void {
  const db = getCortexDb(cortexName);
  const { nullCount } = db.prepare(
    'SELECT COUNT(*) AS nullCount FROM memories WHERE activity_seq IS NULL AND deleted_at IS NULL'
  ).get() as { nullCount: number };

  if (nullCount === 0) return;

  writeLine?.(`backfilling activity_seq for cortex ${cortexName} (${nullCount} rows without seq)`);
  recomputeActivitySeq(cortexName);
}
