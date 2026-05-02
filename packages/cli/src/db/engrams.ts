import { DatabaseSync } from 'node:sqlite';
import { getEngramDbPath, ensureThinkDirs } from '../lib/paths.js';
import { getPeerId } from '../lib/config.js';
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
        CREATE TABLE IF NOT EXISTS memories (
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

      db.exec('CREATE INDEX IF NOT EXISTS idx_memories_ts ON memories(ts);');
      db.exec('CREATE INDEX IF NOT EXISTS idx_memories_sync_version ON memories(sync_version);');

      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
          USING fts5(content, content='memories', content_rowid='rowid');
      `);

      db.exec(`
        CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
        END;
      `);

      db.exec(`
        CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        END;
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS longterm_summary (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          content TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          sync_version INTEGER NOT NULL DEFAULT 0
        ) STRICT;
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS sync_cursors (
          backend TEXT NOT NULL,
          direction TEXT NOT NULL,
          cursor_value TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (backend, direction)
        ) STRICT;
      `);
    },
  },
  {
    version: 3,
    up: (db) => {
      db.exec('ALTER TABLE engrams ADD COLUMN episode_key TEXT;');
      db.exec('CREATE INDEX IF NOT EXISTS idx_engrams_episode_key ON engrams(episode_key);');
      db.exec('ALTER TABLE memories ADD COLUMN episode_key TEXT;');
      db.exec('CREATE INDEX IF NOT EXISTS idx_memories_episode_key ON memories(episode_key);');
    },
  },
  {
    version: 4,
    up: (db) => {
      db.exec('ALTER TABLE engrams ADD COLUMN context TEXT;');
      db.exec('ALTER TABLE engrams ADD COLUMN decisions TEXT;');
    },
  },
  {
    version: 5,
    up: (db) => {
      db.exec('ALTER TABLE memories ADD COLUMN decisions TEXT;');
    },
  },
  {
    version: 6,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS long_term_events (
          id TEXT PRIMARY KEY NOT NULL,
          ts TEXT NOT NULL,
          author TEXT NOT NULL,
          kind TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          topics TEXT NOT NULL DEFAULT '[]',
          supersedes TEXT,
          source_memory_ids TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          deleted_at TEXT,
          sync_version INTEGER NOT NULL DEFAULT 0
        ) STRICT;
      `);

      db.exec('CREATE INDEX IF NOT EXISTS idx_lte_ts ON long_term_events(ts);');
      db.exec('CREATE INDEX IF NOT EXISTS idx_lte_sync_version ON long_term_events(sync_version);');
      db.exec('CREATE INDEX IF NOT EXISTS idx_lte_supersedes ON long_term_events(supersedes);');

      // FTS over title + content for keyword search during recall.
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS long_term_events_fts
          USING fts5(title, content, content='long_term_events', content_rowid='rowid');
      `);

      db.exec(`
        CREATE TRIGGER IF NOT EXISTS long_term_events_ai AFTER INSERT ON long_term_events BEGIN
          INSERT INTO long_term_events_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
        END;
      `);

      db.exec(`
        CREATE TRIGGER IF NOT EXISTS long_term_events_ad AFTER DELETE ON long_term_events BEGIN
          INSERT INTO long_term_events_fts(long_term_events_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
        END;
      `);
    },
  },
  {
    version: 7,
    up: (db) => {
      // Identifies the peer that originally produced each memory. Locally-
      // written rows are stamped with this peer's id; rows ingested from
      // another peer (via the local-fs adapter, HiveDB, etc.) carry the
      // originator's id — without this, attribution is lost the moment a
      // memory crosses a peer boundary.
      db.exec('ALTER TABLE memories ADD COLUMN origin_peer_id TEXT;');
      db.exec('CREATE INDEX IF NOT EXISTS idx_memories_origin_peer_id ON memories(origin_peer_id);');

      // Eager backfill: pre-v7 rows must have originated on this peer (the
      // schema didn't exist anywhere else yet). Stamp them now so readers
      // never see a NULL and existing recall/list/summary keep working.
      const peerId = getPeerId();
      db.prepare('UPDATE memories SET origin_peer_id = ? WHERE origin_peer_id IS NULL').run(peerId);
    },
  },
];

/** Returns the per-cortex SQLite connection (holds engrams, memories, longterm_summary, and sync_cursors tables) */
export function getCortexDb(cortexName: string): DatabaseSync {
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

export function closeCortexDb(cortexName: string): void {
  const db = dbs.get(cortexName);
  if (db) {
    db.close();
    dbs.delete(cortexName);
  }
}

export function closeAllCortexDbs(): void {
  for (const [name, db] of dbs) {
    db.close();
    dbs.delete(name);
  }
}
