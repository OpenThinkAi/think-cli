import { DatabaseSync } from 'node:sqlite';
import { getEngramDbPath, ensureThinkDirs } from '../lib/paths.js';
import { runMigrations } from './migrate.js';
import type { Migration } from './migrate.js';

const dbs = new Map<string, DatabaseSync>();

const migrations: Migration[] = [
  {
    version: 1,
    up: (db) => {
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
    },
  },
  {
    version: 2,
    up: (db) => {
      db.exec(`
        CREATE TABLE memories (
          id TEXT PRIMARY KEY NOT NULL,
          ts TEXT NOT NULL,
          author TEXT NOT NULL,
          content TEXT NOT NULL,
          source_ids TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          deleted_at TEXT,
          sync_version INTEGER NOT NULL DEFAULT 0
        ) STRICT;
      `);

      db.exec('CREATE INDEX idx_memories_ts ON memories(ts);');
      db.exec('CREATE INDEX idx_memories_sync_version ON memories(sync_version);');

      db.exec(`
        CREATE VIRTUAL TABLE memories_fts
          USING fts5(content, content='memories', content_rowid='rowid');
      `);

      db.exec(`
        CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
        END;
      `);

      db.exec(`
        CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        END;
      `);

      db.exec(`
        CREATE TABLE longterm_summary (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          content TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          sync_version INTEGER NOT NULL DEFAULT 0
        ) STRICT;
      `);

      db.exec(`
        CREATE TABLE sync_cursors (
          backend TEXT NOT NULL,
          direction TEXT NOT NULL,
          cursor_value TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (backend, direction)
        ) STRICT;
      `);
    },
  },
];

export function getEngramsDb(cortexName: string): DatabaseSync {
  const cached = dbs.get(cortexName);
  if (cached) return cached;

  ensureThinkDirs();

  const dbPath = getEngramDbPath(cortexName);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');

  runMigrations(db, migrations);

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
