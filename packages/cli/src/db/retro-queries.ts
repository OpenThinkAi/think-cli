import { v7 as uuidv7 } from 'uuid';
import { getCortexDb } from './engrams.js';

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
}

export interface InsertRetroParams {
  content: string;
  kind?: RetroKind | null;
}

export function insertRetro(cortexName: string, params: InsertRetroParams): RetroRow {
  const db = getCortexDb(cortexName);
  const id = uuidv7();
  const now = new Date().toISOString();
  const kind = params.kind ?? null;

  db.prepare(
    `INSERT INTO retros (id, content, kind, cortex_name, created_at, occurrences, sync_version)
     VALUES (?, ?, ?, ?, ?, 1, (SELECT COALESCE(MAX(sync_version), 0) + 1 FROM retros))`
  ).run(id, params.content, kind, cortexName, now);

  return db.prepare('SELECT * FROM retros WHERE id = ?').get(id) as unknown as RetroRow;
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

/** Merges mergedId into canonicalId: increments occurrences on canonical, tombstones merged. */
export function mergeRetro(cortexName: string, canonicalId: string, mergedId: string): void {
  const db = getCortexDb(cortexName);
  const now = new Date().toISOString();

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
