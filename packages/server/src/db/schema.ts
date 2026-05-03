import type { DatabaseSync } from 'node:sqlite';

/**
 * `events.server_seq` is the monotonic cursor read endpoints page over.
 * `INTEGER PRIMARY KEY AUTOINCREMENT` is safe for that role because the
 * server is single-process / single-writer (matches the v2 single-tenant
 * decision). Multi-writer would need a separate sequence source.
 *
 * `id` on `events` intentionally has no `UNIQUE` constraint — this version
 * lands the read surface only, so connector dedup semantics aren't defined
 * here yet.
 */
export function ensureSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL,
      pattern TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_polled_at TEXT
    ) STRICT;
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT NOT NULL,
      subscription_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      server_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS events_sub_seq
      ON events(subscription_id, server_seq);
  `);
}
