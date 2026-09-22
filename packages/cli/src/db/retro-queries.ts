import crypto from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { getCortexDb } from './engrams.js';
import { getPeerId } from '../lib/config.js';

export const VALID_KINDS = ['convention', 'invariant', 'prior_decision', 'gotcha'] as const;
export type RetroKind = typeof VALID_KINDS[number];

export interface RetroRow {
  id: string;
  content: string;
  kind: RetroKind | null;
  cortex_name: string;
  created_at: string;
  occurrences: number;
  tombstoned_at: string | null;
  tombstone_reason: string | null;
  sync_version: number;
  promoted: number;
  last_recalled_at: string | null;
  recalled_count: number;
  /**
   * Originating peer's id. Locally-written rows are stamped via the insert
   * default. Externally-ingested rows preserve whatever the wire format
   * carried; legacy lines that lack the field land as `null` rather than
   * being mis-attributed to the puller.
   */
  origin_peer_id: string | null;
}

export interface InsertRetroParams {
  id?: string;
  content: string;
  kind?: RetroKind | null;
  /**
   * Peer that originally produced this retro. Defaults to the local peer
   * when omitted; pass `null` to record honestly-unknown attribution
   * (e.g. legacy JSONL lines that pre-date the field).
   */
  origin_peer_id?: string | null;
  /** Wire-format created_at; defaults to now when omitted (local insert). */
  created_at?: string;
  /** Set when ingesting a wire-format row that arrived already-tombstoned. */
  tombstoned_at?: string | null;
  tombstone_reason?: string | null;
  /**
   * Initial promoted state. Defaults to 0 (curator decides via dedupe-merge
   * frequency). Direct user emits pass `1` — a `think retro add` is itself
   * the user attesting that the observation matters, so it should surface
   * in default recall without waiting for a duplicate to arrive.
   */
  promoted?: 0 | 1;
}

export function insertRetro(cortexName: string, params: InsertRetroParams): RetroRow {
  const db = getCortexDb(cortexName);
  const id = params.id ?? uuidv7();
  const now = params.created_at ?? new Date().toISOString();
  const kind = params.kind ?? null;
  // `=== undefined` (not `??`) so callers can opt into NULL via explicit
  // `origin_peer_id: null` — used for legacy JSONL lines with no signal.
  const originPeerId = params.origin_peer_id === undefined ? getPeerId() : params.origin_peer_id;
  const tombstonedAt = params.tombstoned_at ?? null;
  const tombstoneReason = params.tombstone_reason ?? null;
  const promoted = params.promoted ?? 0;

  db.prepare(
    `INSERT INTO retros (id, content, kind, cortex_name, created_at, occurrences, sync_version, origin_peer_id, tombstoned_at, tombstone_reason, promoted)
     VALUES (?, ?, ?, ?, ?, 1, (SELECT COALESCE(MAX(sync_version), 0) + 1 FROM retros), ?, ?, ?, ?)`
  ).run(id, params.content, kind, cortexName, now, originPeerId, tombstonedAt, tombstoneReason, promoted);

  return db.prepare('SELECT * FROM retros WHERE id = ?').get(id) as unknown as RetroRow;
}

/** Total non-tombstoned retros for a cortex. */
export function getRetroCount(cortexName: string): number {
  const db = getCortexDb(cortexName);
  const row = db.prepare(
    'SELECT COUNT(*) AS n FROM retros WHERE cortex_name = ? AND tombstoned_at IS NULL'
  ).get(cortexName) as { n: number };
  return row.n;
}

export function insertRetroIfNotExists(
  cortexName: string,
  params: InsertRetroParams & { id: string },
): boolean {
  const db = getCortexDb(cortexName);
  const existing = db.prepare('SELECT id FROM retros WHERE id = ?').get(params.id);
  if (existing) return false;

  insertRetro(cortexName, params);
  return true;
}

/**
 * Returns all retros (including tombstoned) whose sync_version is strictly
 * greater than `sinceVersion`, ordered ascending. Drives the push side of
 * both sync adapters — tombstones must propagate so dedupe-merge state
 * converges across peers.
 */
export function getRetrosBySyncVersion(cortexName: string, sinceVersion: number): RetroRow[] {
  const db = getCortexDb(cortexName);
  return db.prepare(
    'SELECT * FROM retros WHERE cortex_name = ? AND sync_version > ? ORDER BY sync_version ASC'
  ).all(cortexName, sinceVersion) as unknown as RetroRow[];
}

/**
 * Idempotent tombstone application for the cross-peer case. Called when a
 * pull sees a tombstoned wire row and a local row already exists: applies
 * the tombstone fields without re-inserting. No-ops if the row is already
 * tombstoned (guarantees idempotency on repeated pulls).
 */
export function applyRetroTombstone(
  cortexName: string,
  id: string,
  tombstonedAt: string,
  reason: string | null,
): void {
  const db = getCortexDb(cortexName);
  db.prepare(
    `UPDATE retros
     SET tombstoned_at = ?, tombstone_reason = ?,
         sync_version = (SELECT COALESCE(MAX(sync_version), 0) + 1 FROM retros)
     WHERE id = ? AND cortex_name = ? AND tombstoned_at IS NULL`
  ).run(tombstonedAt, reason, id, cortexName);
}

/** Returns all non-tombstoned retros for a cortex, ordered by created_at ascending. */
export function getPendingRetros(cortexName: string): RetroRow[] {
  const db = getCortexDb(cortexName);
  return db.prepare(
    `SELECT * FROM retros
     WHERE cortex_name = ? AND tombstoned_at IS NULL
     ORDER BY created_at ASC`
  ).all(cortexName) as unknown as RetroRow[];
}

/** Returns promoted retros that have been recalled at least once (last_recalled_at IS NOT NULL),
 *  eligible for relegation if they haven't been recalled recently. */
export function getPromotedRetrosForRelegation(cortexName: string): RetroRow[] {
  const db = getCortexDb(cortexName);
  return db.prepare(
    `SELECT * FROM retros
     WHERE cortex_name = ? AND tombstoned_at IS NULL AND promoted = 1 AND last_recalled_at IS NOT NULL
     ORDER BY last_recalled_at ASC`
  ).all(cortexName) as unknown as RetroRow[];
}

/** Merges mergedId into canonicalId: increments occurrences on canonical, tombstones merged.
 *  Both updates are wrapped in a transaction so partial-write on process kill cannot
 *  increment occurrences without also tombstoning the duplicate. */
export function mergeRetro(cortexName: string, canonicalId: string, mergedId: string): void {
  const db = getCortexDb(cortexName);
  const now = new Date().toISOString();

  db.exec('BEGIN');
  try {
    db.prepare(
      `UPDATE retros
       SET occurrences = occurrences + 1,
           sync_version = (SELECT COALESCE(MAX(sync_version), 0) + 1 FROM retros)
       WHERE id = ? AND cortex_name = ?`
    ).run(canonicalId, cortexName);

    db.prepare(
      `UPDATE retros
       SET tombstoned_at = ?,
           tombstone_reason = ?,
           sync_version = (SELECT COALESCE(MAX(sync_version), 0) + 1 FROM retros)
       WHERE id = ? AND cortex_name = ?`
    ).run(now, `merged_into:${canonicalId}`, mergedId, cortexName);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Sets the promoted flag on a list of retro ids. */
export function setRetroPromoted(cortexName: string, ids: string[], promoted: 0 | 1): void {
  if (ids.length === 0) return;
  const db = getCortexDb(cortexName);
  const placeholders = ids.map(() => '?').join(', ');
  db.prepare(
    `UPDATE retros SET promoted = ? WHERE id IN (${placeholders}) AND cortex_name = ?`
  ).run(promoted, ...ids, cortexName);
}

/** Records a curator run timestamp. */
export function recordCuratorRun(cortexName: string): void {
  const db = getCortexDb(cortexName);
  const now = new Date().toISOString();
  // Use INSERT OR IGNORE in case two runs fire at the exact same millisecond
  db.prepare('INSERT OR IGNORE INTO retro_curator_runs (run_at) VALUES (?)').run(now);
}

/** Returns the number of curator runs that occurred strictly after the given ISO timestamp. */
export function runsSince(cortexName: string, since: string): number {
  const db = getCortexDb(cortexName);
  const result = db.prepare(
    'SELECT COUNT(*) as count FROM retro_curator_runs WHERE run_at > ?'
  ).get(since) as { count: number };
  return result.count;
}

/**
 * Content identity of a retro for dedupe-judgment bookkeeping (#97): the
 * sha256 of its content. A stored judgment only stands while both sides still
 * hash to what was judged.
 */
export function retroContentHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** A persisted dedupe verdict for one retro pair (migration v20, #97). */
export interface RetroDedupeJudgmentRecord {
  aId: string;
  aContent: string;
  bId: string;
  bContent: string;
  equivalent: boolean;
}

/** Canonical key for an unordered retro pair: the two ids, sorted, joined by '|'. */
export function retroPairKey(idA: string, idB: string): string {
  return idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
}

/**
 * Returns the stored dedupe judgments as pairKey → the content hash each
 * retro id carried when the pair was judged. Callers compare against current
 * content to decide whether the verdict still stands.
 */
export function getDedupeJudgmentHashes(cortexName: string): Map<string, Map<string, string>> {
  const db = getCortexDb(cortexName);
  const rows = db.prepare(
    'SELECT retro_a, retro_b, hash_a, hash_b FROM retro_dedupe_judgments'
  ).all() as { retro_a: string; retro_b: string; hash_a: string; hash_b: string }[];
  const out = new Map<string, Map<string, string>>();
  for (const r of rows) {
    out.set(retroPairKey(r.retro_a, r.retro_b), new Map([[r.retro_a, r.hash_a], [r.retro_b, r.hash_b]]));
  }
  return out;
}

/**
 * Persists dedupe verdicts (equivalent and not-equivalent) with the content
 * hash of each side, replacing any earlier verdict for the same pair. Written
 * in one transaction so a run's judgments land together or not at all.
 */
export function recordDedupeJudgments(cortexName: string, judgments: RetroDedupeJudgmentRecord[]): void {
  if (judgments.length === 0) return;
  const db = getCortexDb(cortexName);
  const now = new Date().toISOString();

  db.exec('BEGIN');
  try {
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO retro_dedupe_judgments (retro_a, retro_b, hash_a, hash_b, equivalent, judged_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const j of judgments) {
      const [first, second] = j.aId < j.bId
        ? [{ id: j.aId, content: j.aContent }, { id: j.bId, content: j.bContent }]
        : [{ id: j.bId, content: j.bContent }, { id: j.aId, content: j.aContent }];
      stmt.run(
        first.id,
        second.id,
        retroContentHash(first.content),
        retroContentHash(second.content),
        j.equivalent ? 1 : 0,
        now,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export interface SearchRetrosParams {
  query?: string;
  /** Return all non-tombstoned retros, not just promoted=1. */
  all?: boolean;
  limit?: number;
}

/**
 * Searches retros for a cortex.
 * When `query` is set, uses FTS5 MATCH (falls back to LIKE on parse failure).
 * Otherwise dumps rows directly.
 * Tombstoned rows are always excluded.
 * By default returns only promoted=1; pass `all: true` to include relegated rows.
 * Ordering: promoted DESC, occurrences DESC, created_at DESC.
 */
export function searchRetros(cortexName: string, params: SearchRetrosParams = {}): RetroRow[] {
  const db = getCortexDb(cortexName);
  const limit = params.limit ?? 20;
  const q = params.query?.trim();
  const promotedClause = params.all ? '' : 'AND promoted = 1';

  if (q && q.length > 0) {
    const rPromotedClause = params.all ? '' : 'AND r.promoted = 1';
    try {
      return db.prepare(
        `SELECT r.* FROM retros r JOIN retros_fts f ON r.rowid = f.rowid
         WHERE retros_fts MATCH ?
           AND r.tombstoned_at IS NULL
           ${rPromotedClause}
         ORDER BY r.promoted DESC, r.occurrences DESC, r.created_at DESC
         LIMIT ?`
      ).all(q, limit) as unknown as RetroRow[];
    } catch {
      return db.prepare(
        `SELECT * FROM retros
         WHERE cortex_name = ? AND tombstoned_at IS NULL ${promotedClause}
           AND content LIKE ?
         ORDER BY promoted DESC, occurrences DESC, created_at DESC
         LIMIT ?`
      ).all(cortexName, `%${q}%`, limit) as unknown as RetroRow[];
    }
  }

  return db.prepare(
    `SELECT * FROM retros
     WHERE cortex_name = ? AND tombstoned_at IS NULL ${promotedClause}
     ORDER BY promoted DESC, occurrences DESC, created_at DESC
     LIMIT ?`
  ).all(cortexName, limit) as unknown as RetroRow[];
}

/**
 * Bumps last_recalled_at and recalled_count for a batch of retro ids.
 * All updates are wrapped in a single transaction.
 * No sync_version bump — recall stats are local relegation signal only.
 */
export function bumpRecallStats(cortexName: string, ids: string[]): void {
  if (ids.length === 0) return;
  const db = getCortexDb(cortexName);
  const now = new Date().toISOString();

  db.exec('BEGIN');
  try {
    const stmt = db.prepare(
      `UPDATE retros
       SET last_recalled_at = ?, recalled_count = recalled_count + 1
       WHERE id = ? AND cortex_name = ?`
    );
    for (const id of ids) {
      stmt.run(now, id, cortexName);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
