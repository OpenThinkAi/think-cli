/**
 * Unified vector search API (AGT-275).
 *
 * Two backends behind one interface:
 *
 *   "brute-force" — loads all embedding BLOBs from the memories table,
 *     runs cosine (AGT-274) per row, sorts, returns top-K. Suitable for
 *     <50K vectors. Default.
 *
 *   "sqlite-vec" — loads the sqlite-vec extension into the cortex DB,
 *     maintains a vec0 virtual table, uses its KNN operator for sub-10ms
 *     search up to ~100K vectors. Opt-in via `think config set search.engine
 *     sqlite-vec`. Falls back to brute-force if the extension load fails
 *     (Windows / unsupported Node binary / missing native module).
 */

import type { DatabaseSync } from 'node:sqlite';
import { getCortexDb } from '../db/engrams.js';
import { cosine } from './cosine.js';
import { getConfig } from './config.js';

export interface VectorSearchResult {
  id: string;
  similarity: number;
}

// ─── brute-force backend ──────────────────────────────────────────────────────

function searchBruteForce(
  db: DatabaseSync,
  queryVec: Float32Array,
  limit: number,
): VectorSearchResult[] {
  const rows = db.prepare(
    `SELECT id, embedding FROM memories WHERE embedding IS NOT NULL AND deleted_at IS NULL`,
  ).all() as { id: string; embedding: Uint8Array }[];

  const scored = rows.map((row) => {
    const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
    return { id: row.id, similarity: cosine(queryVec, vec) };
  });

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, limit);
}

// ─── sqlite-vec backend ───────────────────────────────────────────────────────

/** Per-db load result: true = loaded OK, false = load failed (use brute-force). */
const sqliteVecLoadCache = new Map<DatabaseSync, boolean>();

/**
 * Per-db backfill flag. Once the one-time backfill runs for a DB instance we
 * never re-scan the memories table. This avoids an O(n) full-table scan on
 * every subsequent query.
 */
const backfilledDbs = new Set<DatabaseSync>();

/**
 * Attempts to load sqlite-vec into `db`. Returns true on success, false on
 * failure (with a warning logged to stderr). Results are cached per db
 * instance so the load attempt only happens once per process per DB.
 */
function tryLoadSqliteVec(db: DatabaseSync): boolean {
  const cached = sqliteVecLoadCache.get(db);
  if (cached !== undefined) return cached;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqliteVec = require('sqlite-vec') as { load: (db: DatabaseSync) => void };
    sqliteVec.load(db);
    sqliteVecLoadCache.set(db, true);
    return true;
  } catch (err) {
    process.stderr.write(
      `think: sqlite-vec extension failed to load — falling back to brute-force search.\n` +
      `       ${err instanceof Error ? err.message : String(err)}\n`,
    );
    sqliteVecLoadCache.set(db, false);
    return false;
  }
}

/**
 * Ensures the vec0 virtual table exists and is backfilled from the memories
 * table. The backfill runs exactly once per DB instance per process — tracked
 * via `backfilledDbs` so subsequent calls are no-ops (no repeated O(n) scan).
 * Dimension is an integer derived from the query vector length.
 */
function ensureVecTable(db: DatabaseSync, dim: number): void {
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(embedding float[${Math.trunc(dim)}])`,
  );

  if (backfilledDbs.has(db)) return;

  // One-time backfill: catch any rows that existed before the virtual table
  // was created. The vec0 rowid corresponds to memories.rowid.
  db.exec(`
    INSERT OR IGNORE INTO memories_vec(rowid, embedding)
    SELECT rowid, embedding
    FROM memories
    WHERE embedding IS NOT NULL AND deleted_at IS NULL
  `);
  backfilledDbs.add(db);
}

function searchSqliteVec(
  db: DatabaseSync,
  queryVec: Float32Array,
  limit: number,
): VectorSearchResult[] {
  const loaded = tryLoadSqliteVec(db);
  if (!loaded) {
    return searchBruteForce(db, queryVec, limit);
  }

  ensureVecTable(db, queryVec.length);

  // Over-fetch by 2× to absorb soft-deleted rows that the KNN returns before
  // the JOIN filter. The `k` limit inside sqlite-vec is applied before the
  // `deleted_at IS NULL` condition, so without over-fetching the result set
  // can be smaller than `limit` when deleted rows dominate the top candidates.
  const fetchK = limit * 2;

  const rows = db.prepare(`
    SELECT m.id, mv.distance
    FROM memories_vec mv
    JOIN memories m ON m.rowid = mv.rowid
    WHERE mv.embedding MATCH ?
      AND k = ?
      AND m.deleted_at IS NULL
    ORDER BY mv.distance
  `).all(
    Buffer.from(queryVec.buffer, queryVec.byteOffset, queryVec.byteLength),
    fetchK,
  ) as { id: string; distance: number }[];

  return rows
    .slice(0, limit)
    .map((r) => ({ id: r.id, similarity: 1 - r.distance }));
}

// ─── public API ───────────────────────────────────────────────────────────────

/**
 * Search for the top-K most similar entries in `cortexName` to `queryVec`.
 *
 * The active backend is read from `config.search.engine` at call time, so
 * switching engines via `think config set search.engine <engine>` takes
 * effect on the next query with no daemon restart required.
 *
 * @param cortexName  Cortex whose L2 DB to search.
 * @param queryVec    L2-normalized query vector (same dimension as stored embeddings).
 * @param limit       Maximum number of results to return.
 */
export function searchVectors(
  cortexName: string,
  queryVec: Float32Array,
  limit: number,
): VectorSearchResult[] {
  const db = getCortexDb(cortexName);
  const engine = getConfig().search?.engine ?? 'brute-force';

  if (engine === 'sqlite-vec') {
    return searchSqliteVec(db, queryVec, limit);
  }
  return searchBruteForce(db, queryVec, limit);
}
