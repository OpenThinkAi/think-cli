import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { getEngramDbPath, ensureThinkDirs } from '../lib/paths.js';

const dbs = new Map<string, DatabaseSync>();

function ensureEngramSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS engrams (
      id TEXT PRIMARY KEY NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      evaluated_at TEXT,
      promoted INTEGER,
      deleted_at TEXT
    ) STRICT;
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS engrams_fts
      USING fts5(content, content='engrams', content_rowid='rowid');
  `);

  // Triggers to keep FTS in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS engrams_ai AFTER INSERT ON engrams BEGIN
      INSERT INTO engrams_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS engrams_ad AFTER DELETE ON engrams BEGIN
      INSERT INTO engrams_fts(engrams_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    END;
  `);
}

export function getEngramsDb(cortexName: string): DatabaseSync {
  const cached = dbs.get(cortexName);
  if (cached) return cached;

  ensureThinkDirs();

  const dbPath = getEngramDbPath(cortexName);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');

  ensureEngramSchema(db);

  dbs.set(cortexName, db);
  return db;
}

export function closeEngramsDb(cortexName: string): void {
  const db = dbs.get(cortexName);
  if (db) {
    db.close();
    dbs.delete(cortexName);
  }
}

export function closeAllEngramsDbs(): void {
  for (const [name, db] of dbs) {
    db.close();
    dbs.delete(name);
  }
}
