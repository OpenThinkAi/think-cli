import type { DatabaseSync } from 'node:sqlite';
import { v7 as uuidv7 } from 'uuid';
import { getCortexDb } from './engrams.js';
import { getPeerId } from '../lib/config.js';
import { validateEngramContent } from '../lib/sanitize.js';

/**
 * Result shape for `insertMemoryIfNotExists`. AGT-059 moved
 * `validateEngramContent` from caller-side edges into the DB write so
 * `migrate-data` and other historically-bypassing paths get the same
 * length cap + prompt-injection-pattern warnings. The shape mirrors what
 * `GitSyncAdapter.processMemories` already does locally — `inserted` for
 * the existing idempotency signal, `warnings` for the centralized advisory
 * output.
 */
export interface InsertMemoryIfNotExistsResult {
  inserted: boolean;
  warnings: string[];
}

export interface MemoryRow {
  id: string;
  ts: string;
  author: string;
  content: string;
  source_ids: string;
  created_at: string;
  deleted_at: string | null;
  sync_version: number;
  episode_key: string | null;
  decisions: string | null;
  /**
   * Originating peer's id. Locally-written rows are always stamped via the
   * insert default. Externally-ingested rows preserve whatever the wire
   * format carried; legacy lines that lack the field land as `null` rather
   * than being mis-attributed to the puller.
   */
  origin_peer_id: string | null;
  /** Float32Array byte buffer (384-dim = 1536 bytes). Null until the embedding pipeline runs (AGT-278). node:sqlite returns BLOBs as Uint8Array. */
  embedding: Uint8Array | null;
  /** Model name that produced the embedding (e.g. "bge-small-en-v1.5"). Null until populated. */
  embedding_model: string | null;
  /**
   * Stable integer position within this cortex, computed by ORDER BY ts ASC, id ASC.
   * Null until the reindex backfill runs (AGT-292). Used by v3 recency-weighted recall
   * to rank cosine × recency_weight without relying on wall-clock time.
   */
  activity_seq: number | null;
  /**
   * Entry kind: "memory" | "retro" | "event" | null.
   * Null for pre-v3 rows that pre-date kind tagging. Added in migration 11.
   */
  kind: string | null;
}

export interface InsertMemoryParams {
  id?: string;
  ts: string;
  author: string;
  content: string;
  source_ids?: string[];
  deleted_at?: string | null;
  episode_key?: string;
  decisions?: string[];
  /**
   * Peer that originally produced this memory. Defaults to the local peer
   * when omitted; pass `null` to record honestly-unknown attribution
   * (e.g. legacy JSONL lines that pre-date the field).
   */
  origin_peer_id?: string | null;
}

export function insertMemory(cortexName: string, params: InsertMemoryParams): MemoryRow {
  const db = getCortexDb(cortexName);
  const id = params.id ?? uuidv7();
  const now = new Date().toISOString();
  const sourceIds = JSON.stringify(params.source_ids ?? []);

  const episodeKey = params.episode_key ?? null;
  const decisions = params.decisions?.length ? JSON.stringify(params.decisions) : null;
  // `=== undefined` (not `??`) so callers can opt into NULL via explicit
  // `origin_peer_id: null` — used for legacy JSONL lines with no signal.
  const originPeerId = params.origin_peer_id === undefined ? getPeerId() : params.origin_peer_id;

  // Atomic sync_version assignment via subquery — no race between read and write
  db.prepare(
    `INSERT INTO memories (id, ts, author, content, source_ids, created_at, deleted_at, sync_version, episode_key, decisions, origin_peer_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sync_version), 0) + 1 FROM memories), ?, ?, ?)`
  ).run(id, params.ts, params.author, params.content, sourceIds, now, params.deleted_at ?? null, episodeKey, decisions, originPeerId);

  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as unknown as MemoryRow;
  return row;
}

export function insertMemoryIfNotExists(cortexName: string, params: InsertMemoryParams & { id: string }): InsertMemoryIfNotExistsResult {
  const db = getCortexDb(cortexName);
  const existing = db.prepare('SELECT id FROM memories WHERE id = ?').get(params.id);
  if (existing) return { inserted: false, warnings: [] };

  // Centralized validation chokepoint (AGT-059). `migrate-data` historically
  // bypassed validation; routing through here closes that gap. Sync-adapter
  // callers already pre-validate, so the second pass is idempotent and
  // returns no new warnings — net behavior is unchanged for existing paths.
  const { content: sanitizedContent, warnings } = validateEngramContent(params.content);
  insertMemory(cortexName, { ...params, content: sanitizedContent });
  return { inserted: true, warnings };
}

export function getMemories(cortexName: string, params: {
  since?: string;
  until?: string;
  limit?: number;
} = {}): MemoryRow[] {
  const db = getCortexDb(cortexName);
  const conditions = ['deleted_at IS NULL'];
  const values: (string | number)[] = [];

  if (params.since) {
    conditions.push('ts >= ?');
    values.push(params.since);
  }

  if (params.until) {
    conditions.push('ts <= ?');
    values.push(params.until);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  if (params.limit) {
    values.push(params.limit);
    return db.prepare(
      `SELECT * FROM memories ${where} ORDER BY ts ASC LIMIT ?`
    ).all(...values) as unknown as MemoryRow[];
  }

  return db.prepare(
    `SELECT * FROM memories ${where} ORDER BY ts ASC`
  ).all(...values) as unknown as MemoryRow[];
}

export function getMemoriesBySyncVersion(
  cortexName: string,
  sinceVersion: number,
  limit?: number,
): MemoryRow[] {
  const db = getCortexDb(cortexName);
  if (limit != null) {
    return db.prepare(
      'SELECT * FROM memories WHERE sync_version > ? ORDER BY sync_version ASC LIMIT ?'
    ).all(sinceVersion, limit) as unknown as MemoryRow[];
  }
  return db.prepare(
    'SELECT * FROM memories WHERE sync_version > ? ORDER BY sync_version ASC'
  ).all(sinceVersion) as unknown as MemoryRow[];
}

export function searchMemories(cortexName: string, query: string, limit: number = 20): MemoryRow[] {
  const db = getCortexDb(cortexName);
  try {
    return db.prepare(
      `SELECT m.* FROM memories m JOIN memories_fts f ON m.rowid = f.rowid
       WHERE memories_fts MATCH ? AND m.deleted_at IS NULL
       ORDER BY rank LIMIT ?`
    ).all(query, limit) as unknown as MemoryRow[];
  } catch {
    const pattern = `%${query.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
    return db.prepare(
      `SELECT * FROM memories WHERE content LIKE ? ESCAPE '\\' AND deleted_at IS NULL ORDER BY ts DESC LIMIT ?`
    ).all(pattern, limit) as unknown as MemoryRow[];
  }
}

export function tombstoneMemory(cortexName: string, id: string): void {
  const db = getCortexDb(cortexName);
  // Only sets deleted_at + sync_version — ts, author, content are preserved
  // so deterministicId matches during sync (tombstone line keeps original content)
  db.prepare(
    `UPDATE memories SET deleted_at = ?, sync_version = (SELECT COALESCE(MAX(sync_version), 0) + 1 FROM memories)
     WHERE id = ? AND deleted_at IS NULL`
  ).run(new Date().toISOString(), id);
}

export interface PruneEmbeddingsResult {
  /** Number of rows whose embedding BLOB was cleared. */
  prunedRows: number;
  /** Total bytes of embedding BLOBs cleared (sum of length(embedding)). */
  bytesFreed: number;
  /**
   * True if the prune was skipped because clearing the stale set would have
   * removed the cortex's *last* embeddings — see the safety invariant below.
   */
  skippedToProtectLastEmbeddings: boolean;
}

/**
 * Reclaim space by clearing stale, locally-rebuildable embedding BLOBs.
 *
 * The `embedding` BLOB (384-dim float32 ≈ 1.5 KB) is the dominant on-disk and
 * per-query-RAM cost of a cortex L2: the brute-force search backend loads every
 * embedding into memory on each query (`search-vectors.ts`). Embeddings are NOT
 * part of the L1 JSONL source of truth — `think reindex` recomputes them — so
 * clearing one is a pure local-index operation. Content, FTS keyword recall, and
 * all metadata are preserved, and the row can be re-embedded later.
 *
 * Two tiers of "stale", neither of which targets a row recall still uses:
 *   - Tier 0: tombstoned rows (`deleted_at IS NOT NULL`). Recall already filters
 *     these out, so their vectors are pure dead weight.
 *   - Tier 1: rows superseded longer than `supersededGraceDays` ago. The grace
 *     window keeps a freshly-superseded row's vector around briefly in case it
 *     is still a useful recall bridge.
 *
 * `sync_version` is intentionally NOT bumped — embeddings are not synced, so a
 * prune must stay invisible to the sync pipeline.
 *
 * Safety invariant — never clear the cortex's last embeddings. If no
 * current-model embedding survives the prune, the daemon's `sampleEmbeddingModel`
 * check (`embed-model-check.ts`) would read `null` ("no embeddings yet") on the
 * next boot and trigger a full reindex from L1, re-embedding everything and
 * undoing the prune. Tier 0+1 never targets live rows, so in practice survivors
 * always remain; the guard makes the invariant explicit and abort-safe.
 *
 * Does NOT VACUUM. Clearing a BLOB returns its pages to SQLite's free-list but
 * does not shrink the file on disk; the caller (the prune loop) decides when to
 * VACUUM, since VACUUM rewrites the whole DB and is comparatively expensive.
 */
export function pruneStaleEmbeddings(
  cortexName: string,
  supersededGraceDays: number,
): PruneEmbeddingsResult {
  const db = getCortexDb(cortexName);
  const cutoff = new Date(Date.now() - supersededGraceDays * 24 * 60 * 60 * 1000).toISOString();

  // Rows eligible to have their embedding cleared, with byte cost and rowid
  // (rowid is needed to drop the matching sqlite-vec shadow row).
  const stale = db.prepare(
    `SELECT rowid, length(embedding) AS bytes
       FROM memories
      WHERE embedding IS NOT NULL
        AND (
          deleted_at IS NOT NULL
          OR (superseded_at IS NOT NULL AND superseded_at < ?)
        )`
  ).all(cutoff) as { rowid: number; bytes: number }[];

  if (stale.length === 0) {
    return { prunedRows: 0, bytesFreed: 0, skippedToProtectLastEmbeddings: false };
  }

  // Safety guard: refuse to clear the cortex's last embeddings (would force a
  // full reindex on the next daemon boot — see the invariant above).
  const totalEmbedded = (db.prepare(
    'SELECT COUNT(*) AS n FROM memories WHERE embedding IS NOT NULL'
  ).get() as { n: number }).n;
  if (totalEmbedded - stale.length <= 0) {
    return { prunedRows: 0, bytesFreed: 0, skippedToProtectLastEmbeddings: true };
  }

  const bytesFreed = stale.reduce((sum, r) => sum + r.bytes, 0);
  const rowids = stale.map((r) => r.rowid);

  // The sqlite-vec shadow table (`memories_vec`) never self-deletes; without
  // this cleanup a cleared row's vector would still be returned by the
  // sqlite-vec KNN backend (it JOINs back to a row that now has embedding=NULL
  // but deleted_at possibly NULL for the superseded case). The shadow table is
  // a vec0 virtual table, so it can only be touched once the sqlite-vec
  // extension is loaded into this connection. If the table is absent (engine
  // never used) or the extension can't load on this platform, the brute-force
  // backend — which filters `embedding IS NOT NULL` and ignores the shadow
  // table entirely — keeps results correct, so skipping the DELETE is safe.
  const memoriesVecExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE name = 'memories_vec'"
  ).get() !== undefined;
  let vecStmt: ReturnType<DatabaseSync['prepare']> | null = null;
  if (memoriesVecExists) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sqliteVec = require('sqlite-vec') as { load: (db: DatabaseSync) => void };
      sqliteVec.load(db);
      vecStmt = db.prepare('DELETE FROM memories_vec WHERE rowid = ?');
    } catch {
      vecStmt = null; // extension unavailable — brute-force fallback stays correct
    }
  }

  const clearStmt = db.prepare(
    'UPDATE memories SET embedding = NULL, embedding_model = NULL WHERE rowid = ?'
  );

  db.exec('BEGIN');
  try {
    for (const rowid of rowids) {
      clearStmt.run(rowid);
      vecStmt?.run(rowid);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { prunedRows: rowids.length, bytesFreed, skippedToProtectLastEmbeddings: false };
}

export function getSyncCursor(cortexName: string, backend: string, direction: string): string | null {
  const db = getCortexDb(cortexName);
  const row = db.prepare(
    'SELECT cursor_value FROM sync_cursors WHERE backend = ? AND direction = ?'
  ).get(backend, direction) as { cursor_value: string } | undefined;
  return row?.cursor_value ?? null;
}

export function setSyncCursor(cortexName: string, backend: string, direction: string, cursorValue: string): void {
  const db = getCortexDb(cortexName);
  db.prepare(
    `INSERT INTO sync_cursors (backend, direction, cursor_value, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(backend, direction) DO UPDATE SET cursor_value = excluded.cursor_value, updated_at = excluded.updated_at`
  ).run(backend, direction, cursorValue, new Date().toISOString());
}

export function getMemoryCount(cortexName: string): number {
  const db = getCortexDb(cortexName);
  const row = db.prepare('SELECT COUNT(*) as count FROM memories WHERE deleted_at IS NULL').get() as { count: number };
  return row.count;
}

export function getMemoryByEpisodeKey(cortexName: string, episodeKey: string): MemoryRow | null {
  const db = getCortexDb(cortexName);
  const row = db.prepare(
    'SELECT * FROM memories WHERE episode_key = ? AND deleted_at IS NULL LIMIT 1'
  ).get(episodeKey) as unknown as MemoryRow | undefined;
  return row ?? null;
}
