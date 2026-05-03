import type { DatabaseSync } from 'node:sqlite';

/**
 * `events.server_seq` is the monotonic cursor read endpoints page over.
 * `INTEGER PRIMARY KEY AUTOINCREMENT` is safe for that role because the
 * server is single-process / single-writer (matches the v2 single-tenant
 * decision). Multi-writer would need a separate sequence source.
 *
 * `events_sub_id_unique` enforces `(subscription_id, id)` uniqueness so
 * `INSERT OR IGNORE` in the scheduler can safely tolerate a connector
 * replaying ids on transient errors. Per-subscription scoping: two
 * different subscriptions can legitimately share an id namespace.
 *
 * `subscriptions.cursor` is opaque per-connector JSON the framework
 * persists verbatim. Stored as TEXT (JSON-encoded) so each connector can
 * pick its own shape — GitHub uses a per-endpoint map, mock uses a count.
 *
 * `source_credentials` (added in 0.5.0) holds AES-256-GCM-encrypted
 * credentials, one per subscription. `subscription_id` is the PK so
 * `PUT /v1/subscriptions/:id/credential` can upsert without an extra id
 * column. `ciphertext` carries the encrypted bytes with the 16-byte GCM
 * auth tag appended (see `vault/cipher.ts`); `nonce` is the 12-byte GCM
 * nonce. ON DELETE CASCADE keeps the row from outliving its subscription.
 */
export function ensureSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL,
      pattern TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_polled_at TEXT,
      cursor TEXT
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
    ) STRICT;
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS events_sub_seq
      ON events(subscription_id, server_seq);
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS events_sub_id_unique
      ON events(subscription_id, id);
  `);

  // Additive migration: subscriptions.cursor was added in 0.4.0. SQLite
  // has no `ADD COLUMN IF NOT EXISTS`, so probe table_info first. Fresh
  // 0.4.0 DBs hit the CREATE TABLE above and already have the column;
  // existing 0.3.x DBs need the ALTER.
  const cols = db
    .prepare("PRAGMA table_info('subscriptions')")
    .all() as { name: string }[];
  if (!cols.some((c) => c.name === 'cursor')) {
    db.exec('ALTER TABLE subscriptions ADD COLUMN cursor TEXT');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS source_credentials (
      subscription_id TEXT PRIMARY KEY NOT NULL,
      ciphertext BLOB NOT NULL,
      nonce BLOB NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
    ) STRICT;
  `);
}
