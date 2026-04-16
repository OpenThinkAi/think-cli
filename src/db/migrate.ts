import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  version: number;
  up: (db: DatabaseSync) => void;
}

export function runMigrations(db: DatabaseSync, migrations: Migration[]): void {
  // Create the migrations tracking table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const currentVersion = db.prepare(
    'SELECT COALESCE(MAX(version), 0) as version FROM _migrations'
  ).get() as { version: number };

  const pending = migrations
    .filter(m => m.version > currentVersion.version)
    .sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    db.exec('BEGIN');
    try {
      migration.up(db);
      db.prepare('INSERT INTO _migrations (version, applied_at) VALUES (?, ?)').run(
        migration.version,
        new Date().toISOString()
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration v${migration.version} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
