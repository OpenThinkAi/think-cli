import { v7 as uuidv7 } from 'uuid';
import { getEngramsDb } from './engrams.js';

export interface MemoryRow {
  id: string;
  ts: string;
  author: string;
  content: string;
  source_ids: string;
  created_at: string;
  deleted_at: string | null;
  sync_version: number;
}

export interface InsertMemoryParams {
  id?: string;
  ts: string;
  author: string;
  content: string;
  source_ids?: string[];
  deleted_at?: string | null;
}

export function getNextSyncVersion(cortexName: string): number {
  const db = getEngramsDb(cortexName);
  const row = db.prepare(
    'SELECT COALESCE(MAX(sync_version), 0) + 1 as next_version FROM memories'
  ).get() as { next_version: number };
  return row.next_version;
}

export function insertMemory(cortexName: string, params: InsertMemoryParams): MemoryRow {
  const db = getEngramsDb(cortexName);
  const id = params.id ?? uuidv7();
  const now = new Date().toISOString();
  const sourceIds = JSON.stringify(params.source_ids ?? []);
  const syncVersion = getNextSyncVersion(cortexName);

  db.prepare(
    `INSERT INTO memories (id, ts, author, content, source_ids, created_at, deleted_at, sync_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, params.ts, params.author, params.content, sourceIds, now, params.deleted_at ?? null, syncVersion);

  return {
    id,
    ts: params.ts,
    author: params.author,
    content: params.content,
    source_ids: sourceIds,
    created_at: now,
    deleted_at: params.deleted_at ?? null,
    sync_version: syncVersion,
  };
}

export function insertMemoryIfNotExists(cortexName: string, params: InsertMemoryParams & { id: string }): boolean {
  const db = getEngramsDb(cortexName);
  const existing = db.prepare('SELECT id FROM memories WHERE id = ?').get(params.id);
  if (existing) return false;

  insertMemory(cortexName, params);
  return true;
}

export function getMemories(cortexName: string, params: {
  since?: string;
  until?: string;
  limit?: number;
} = {}): MemoryRow[] {
  const db = getEngramsDb(cortexName);
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
  const limit = params.limit ?? 10000;
  values.push(limit);

  return db.prepare(
    `SELECT * FROM memories ${where} ORDER BY ts ASC LIMIT ?`
  ).all(...values) as unknown as MemoryRow[];
}

export function getMemoriesBySyncVersion(cortexName: string, sinceVersion: number): MemoryRow[] {
  const db = getEngramsDb(cortexName);
  return db.prepare(
    'SELECT * FROM memories WHERE sync_version > ? ORDER BY sync_version ASC'
  ).all(sinceVersion) as unknown as MemoryRow[];
}

export function searchMemories(cortexName: string, query: string, limit: number = 20): MemoryRow[] {
  const db = getEngramsDb(cortexName);
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
  const db = getEngramsDb(cortexName);
  const syncVersion = getNextSyncVersion(cortexName);
  db.prepare(
    'UPDATE memories SET deleted_at = ?, sync_version = ? WHERE id = ? AND deleted_at IS NULL'
  ).run(new Date().toISOString(), syncVersion, id);
}

export function getLongtermSummary(cortexName: string): string | null {
  const db = getEngramsDb(cortexName);
  const row = db.prepare('SELECT content FROM longterm_summary WHERE id = 1').get() as { content: string } | undefined;
  return row?.content ?? null;
}

export function setLongtermSummary(cortexName: string, content: string): void {
  const db = getEngramsDb(cortexName);
  const syncVersion = getNextSyncVersion(cortexName);
  db.prepare(
    `INSERT INTO longterm_summary (id, content, updated_at, sync_version)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at, sync_version = excluded.sync_version`
  ).run(content, new Date().toISOString(), syncVersion);
}

export function getSyncCursor(cortexName: string, backend: string, direction: string): string | null {
  const db = getEngramsDb(cortexName);
  const row = db.prepare(
    'SELECT cursor_value FROM sync_cursors WHERE backend = ? AND direction = ?'
  ).get(backend, direction) as { cursor_value: string } | undefined;
  return row?.cursor_value ?? null;
}

export function setSyncCursor(cortexName: string, backend: string, direction: string, cursorValue: string): void {
  const db = getEngramsDb(cortexName);
  db.prepare(
    `INSERT INTO sync_cursors (backend, direction, cursor_value, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(backend, direction) DO UPDATE SET cursor_value = excluded.cursor_value, updated_at = excluded.updated_at`
  ).run(backend, direction, cursorValue, new Date().toISOString());
}

export function getMemoryCount(cortexName: string): number {
  const db = getEngramsDb(cortexName);
  const row = db.prepare('SELECT COUNT(*) as count FROM memories WHERE deleted_at IS NULL').get() as { count: number };
  return row.count;
}
