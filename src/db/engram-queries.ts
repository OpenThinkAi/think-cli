import { v7 as uuidv7 } from 'uuid';
import { getEngramsDb } from './engrams.js';

export interface Engram {
  id: string;
  content: string;
  created_at: string;
  expires_at: string;
  evaluated_at: string | null;
  promoted: number | null;
  deleted_at: string | null;
}

export interface InsertEngramParams {
  content: string;
  expiresInDays?: number;
}

export function insertEngram(cortexName: string, params: InsertEngramParams): Engram {
  const db = getEngramsDb(cortexName);
  const id = uuidv7();
  const now = new Date();
  const created_at = now.toISOString();
  const expiresInDays = params.expiresInDays ?? 60;
  const expires_at = new Date(now.getTime() + expiresInDays * 86400000).toISOString();

  db.prepare(
    `INSERT INTO engrams (id, content, created_at, expires_at) VALUES (?, ?, ?, ?)`
  ).run(id, params.content, created_at, expires_at);

  return { id, content: params.content, created_at, expires_at, evaluated_at: null, promoted: null, deleted_at: null };
}

export function getPendingEngrams(cortexName: string): Engram[] {
  const db = getEngramsDb(cortexName);
  return db.prepare(
    `SELECT * FROM engrams WHERE evaluated_at IS NULL AND deleted_at IS NULL AND expires_at > ? ORDER BY created_at ASC`
  ).all(new Date().toISOString()) as unknown as Engram[];
}

export function getEngrams(cortexName: string, params: { since?: Date; limit?: number }): Engram[] {
  const db = getEngramsDb(cortexName);
  const conditions = ['deleted_at IS NULL'];
  const values: string[] = [];

  if (params.since) {
    conditions.push('created_at >= ?');
    values.push(params.since.toISOString());
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = params.limit ?? 1000;

  return db.prepare(
    `SELECT * FROM engrams ${where} ORDER BY created_at DESC LIMIT ?`
  ).all(...values, limit) as unknown as Engram[];
}

export function markEvaluated(cortexName: string, ids: string[], promoted: boolean): void {
  const db = getEngramsDb(cortexName);
  const now = new Date().toISOString();
  const promotedVal = promoted ? 1 : 0;
  const stmt = db.prepare(
    `UPDATE engrams SET evaluated_at = ?, promoted = ? WHERE id = ?`
  );

  for (const id of ids) {
    stmt.run(now, promotedVal, id);
  }
}

export function pruneExpiredEngrams(cortexName: string): number {
  const db = getEngramsDb(cortexName);
  const result = db.prepare(
    `DELETE FROM engrams WHERE expires_at < ? AND evaluated_at IS NOT NULL`
  ).run(new Date().toISOString());
  return Number(result.changes);
}

export function searchEngrams(cortexName: string, query: string, limit: number = 20): Engram[] {
  const db = getEngramsDb(cortexName);
  try {
    return db.prepare(
      `SELECT e.* FROM engrams e JOIN engrams_fts f ON e.rowid = f.rowid
       WHERE engrams_fts MATCH ? AND e.deleted_at IS NULL
       ORDER BY rank LIMIT ?`
    ).all(query, limit) as unknown as Engram[];
  } catch {
    // FTS match syntax can fail on certain inputs — fall back to LIKE
    return db.prepare(
      `SELECT * FROM engrams WHERE content LIKE ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?`
    ).all(`%${query}%`, limit) as unknown as Engram[];
  }
}
