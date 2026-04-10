import { v7 as uuidv7 } from 'uuid';
import { startOfWeek, endOfWeek, subWeeks } from 'date-fns';
import { getDb } from './client.js';

export interface Entry {
  id: string;
  timestamp: string;
  source: string;
  category: string;
  content: string;
  tags: string;
}

export interface InsertEntryParams {
  content: string;
  source?: string;
  category?: string;
  tags?: string[];
}

export interface GetEntriesParams {
  since?: Date;
  until?: Date;
  category?: string;
  tag?: string;
  limit?: number;
}

export function insertEntry(params: InsertEntryParams): Entry {
  const db = getDb();
  const id = uuidv7();
  const timestamp = new Date().toISOString();
  const source = params.source ?? 'manual';
  const category = params.category ?? 'note';
  const tags = JSON.stringify(params.tags ?? []);

  db.prepare(
    `INSERT INTO entries (id, timestamp, source, category, content, tags) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, timestamp, source, category, params.content, tags);

  return { id, timestamp, source, category, content: params.content, tags };
}

export function getEntries(params: GetEntriesParams): Entry[] {
  const db = getDb();
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.since) {
    conditions.push('timestamp >= ?');
    values.push(params.since.toISOString());
  }
  if (params.until) {
    conditions.push('timestamp <= ?');
    values.push(params.until.toISOString());
  }
  if (params.category) {
    conditions.push('category = ?');
    values.push(params.category);
  }
  if (params.tag) {
    conditions.push(`tags LIKE ?`);
    values.push(`%"${params.tag}"%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = params.limit ?? 100;

  return db.prepare(
    `SELECT id, timestamp, source, category, content, tags FROM entries ${where} ORDER BY timestamp DESC LIMIT ?`
  ).all(...values, limit) as Entry[];
}

export function getEntriesByWeek(weeksAgo: number = 0): Entry[] {
  const now = new Date();
  const targetWeek = subWeeks(now, weeksAgo);
  const monday = startOfWeek(targetWeek, { weekStartsOn: 1 });
  const sunday = endOfWeek(targetWeek, { weekStartsOn: 1 });

  return getEntries({ since: monday, until: sunday });
}

export function getDbVersion(): number {
  const db = getDb();
  const row = db.prepare('SELECT crsql_db_version() AS version').get() as { version: number };
  return row.version;
}

export function getChangeset(sinceVersion: number): unknown[] {
  const db = getDb();
  return db.prepare('SELECT * FROM crsql_changes WHERE db_version > ?').all(sinceVersion);
}

export function applyChangeset(changes: unknown[]): void {
  const db = getDb();
  const stmt = db.prepare(
    'INSERT INTO crsql_changes ("table", pk, cid, val, col_version, db_version, site_id, cl, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const applyAll = db.transaction((rows: unknown[]) => {
    for (const row of rows) {
      const r = row as Record<string, unknown>;
      stmt.run(r.table, r.pk, r.cid, r.val, r.col_version, r.db_version, r.site_id, r.cl, r.seq);
    }
  });
  applyAll(changes);
}

export interface PeerInfo {
  peer_id: string;
  last_synced_db_version: number;
  hostname: string | null;
  last_seen: string | null;
}

export function getAllPeers(): PeerInfo[] {
  const db = getDb();
  return db.prepare('SELECT * FROM sync_peers ORDER BY last_seen DESC').all() as PeerInfo[];
}

export function getPeerInfo(peerId: string): PeerInfo | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM sync_peers WHERE peer_id = ?').get(peerId) as PeerInfo | undefined;
}

export function updatePeerInfo(peerId: string, dbVersion: number, hostname: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO sync_peers (peer_id, last_synced_db_version, hostname, last_seen)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(peer_id) DO UPDATE SET
       last_synced_db_version = excluded.last_synced_db_version,
       hostname = excluded.hostname,
       last_seen = excluded.last_seen`
  ).run(peerId, dbVersion, hostname, new Date().toISOString());
}
