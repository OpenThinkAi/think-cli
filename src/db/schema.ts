import Database from 'better-sqlite3';

export function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY NOT NULL,
      timestamp TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      category TEXT NOT NULL DEFAULT 'note',
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]'
    ) STRICT;
  `);

  // Make entries table CRDT-aware for P2P sync.
  // crsql_as_crr is idempotent if already registered.
  try {
    db.exec(`SELECT crsql_as_crr('entries')`);
  } catch (_e) {
    // Already registered — safe to ignore
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_peers (
      peer_id TEXT PRIMARY KEY,
      last_synced_db_version INTEGER NOT NULL DEFAULT 0,
      hostname TEXT,
      last_seen TEXT
    );
  `);
}
