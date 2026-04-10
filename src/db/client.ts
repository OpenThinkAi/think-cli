import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { extensionPath } from '@vlcn.io/crsqlite';
import { ensureSchema } from './schema.js';

let db: Database.Database | null = null;

export function getDataDir(): string {
  const xdgData = process.env.XDG_DATA_HOME || path.join(process.env.HOME!, '.local', 'share');
  return path.join(xdgData, 'think');
}

export function getDb(): Database.Database {
  if (db) return db;

  const dataDir = getDataDir();
  fs.mkdirSync(dataDir, { recursive: true });

  const dbPath = path.join(dataDir, 'think.db');
  db = new Database(dbPath);
  db.loadExtension(extensionPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  ensureSchema(db);

  return db;
}

export function closeDb(): void {
  if (db) {
    db.prepare('SELECT crsql_finalize()').run();
    db.close();
    db = null;
  }
}
