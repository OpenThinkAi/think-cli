import { DatabaseSync } from 'node:sqlite';
import { ensureSchema } from './migrations/schema.js';

export type Database = DatabaseSync;

/**
 * Opens the server's SQLite handle and ensures the schema. Mirrors the CLI's
 * `db/client.ts` PRAGMA setup: WAL for file-backed DBs, NORMAL synchronous
 * (safe under WAL), and `foreign_keys = ON` so the events→subscriptions
 * cascade actually fires.
 *
 * `:memory:` is treated specially because WAL requires a file.
 */
export function openDb(dbPath: string): Database {
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
  }
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  ensureSchema(db);
  return db;
}
