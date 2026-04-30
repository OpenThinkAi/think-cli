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

  conditions.push('deleted_at IS NULL');

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

export function deleteEntry(id: string): boolean {
  const db = getDb();
  const result = db.prepare(
    'UPDATE entries SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL'
  ).run(new Date().toISOString(), id);
  return result.changes > 0;
}

export function deleteEntriesByContent(pattern: string): number {
  const db = getDb();
  const result = db.prepare(
    'UPDATE entries SET deleted_at = ? WHERE content LIKE ? AND deleted_at IS NULL'
  ).run(new Date().toISOString(), `%${pattern}%`);
  return result.changes;
}

