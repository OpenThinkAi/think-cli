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
