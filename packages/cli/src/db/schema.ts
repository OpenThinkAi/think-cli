import type { DatabaseSync } from 'node:sqlite';

export function ensureSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY NOT NULL,
      timestamp TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      category TEXT NOT NULL DEFAULT 'note',
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      deleted_at TEXT
    ) STRICT;
  `);

  // Add deleted_at column if migrating from older schema
  const columns = db.prepare(`PRAGMA table_info(entries)`).all() as { name: string }[];
  if (!columns.some(c => c.name === 'deleted_at')) {
    db.exec(`ALTER TABLE entries ADD COLUMN deleted_at TEXT`);
  }
}
