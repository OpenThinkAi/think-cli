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

export function searchRetros(cortexName: string, query: string, limit: number = 20): RetroRow[] {
  const db = getCortexDb(cortexName);
  try {
    return db.prepare(
      `SELECT r.* FROM retros r JOIN retros_fts f ON r.rowid = f.rowid
       WHERE retros_fts MATCH ? AND r.tombstoned_at IS NULL
       ORDER BY rank LIMIT ?`
    ).all(query, limit) as unknown as RetroRow[];
  } catch {
    const pattern = `%${query.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
    return db.prepare(
      `SELECT * FROM retros WHERE content LIKE ? ESCAPE '\\' AND tombstoned_at IS NULL ORDER BY created_at DESC LIMIT ?`
    ).all(pattern, limit) as unknown as RetroRow[];
  }
}

export function getRetrosBySyncVersion(
  cortexName: string,
  sinceVersion: number,
  limit?: number,
): RetroRow[] {
  const db = getCortexDb(cortexName);
  if (limit != null) {
    return db.prepare(
      'SELECT * FROM retros WHERE sync_version > ? ORDER BY sync_version ASC LIMIT ?'
    ).all(sinceVersion, limit) as unknown as RetroRow[];
  }
  return db.prepare(
    'SELECT * FROM retros WHERE sync_version > ? ORDER BY sync_version ASC'
  ).all(sinceVersion) as unknown as RetroRow[];
}

export function tombstoneRetro(cortexName: string, id: string, reason: string): void {
  const db = getCortexDb(cortexName);
  db.prepare(
    `UPDATE retros SET tombstoned_at = ?, tombstone_reason = ?,
     sync_version = (SELECT COALESCE(MAX(sync_version), 0) + 1 FROM retros)
     WHERE id = ? AND tombstoned_at IS NULL`
  ).run(new Date().toISOString(), reason, id);
}
