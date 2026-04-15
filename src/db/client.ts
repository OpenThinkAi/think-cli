import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ensureSchema } from './schema.js';

let db: DatabaseSync | null = null;

export function getDataDir(): string {
  if (process.env.THINK_HOME) {
    return process.env.THINK_HOME;
  }
  const xdgData = process.env.XDG_DATA_HOME || path.join(process.env.HOME!, '.local', 'share');
  return path.join(xdgData, 'think');
}

export function getDb(): DatabaseSync {
  if (db) return db;

  const dataDir = getDataDir();
  fs.mkdirSync(dataDir, { recursive: true });

  const dbPath = path.join(dataDir, 'think.db');
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');

  ensureSchema(db);

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
