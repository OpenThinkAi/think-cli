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
 * `events.episode_key` (added in the terminal-event pivot, AGT-381) is
 * the connector-stamped stable identifier that downstream
 * proxy-curated memories group sibling rows under (e.g.
 * `github:org/repo#536`, `linear:TEAM-123`, `meeting:<uuid>`).
 * Index `events_episode_key_ts` on `(episode_key, created_at)` covers
 * the per-episode lookup the curator and recall hydration use.
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
  // Fresh DBs get `episode_key` as a NOT NULL column straight away;
  // existing-DB migration to add it is handled by the additive ALTER
  // below. The CREATE TABLE statement here defines the post-migration
  // shape — pre-migration shapes are handled in the probe block.
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT NOT NULL,
      subscription_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      episode_key TEXT NOT NULL,
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
  const subCols = db
    .prepare("PRAGMA table_info('subscriptions')")
    .all() as { name: string }[];
  if (!subCols.some((c) => c.name === 'cursor')) {
    db.exec('ALTER TABLE subscriptions ADD COLUMN cursor TEXT');
  }

  // Additive migration: events.episode_key was added with the terminal-
  // event pivot (AGT-381). Fresh DBs land it via the CREATE TABLE above;
  // pre-existing DBs need an ALTER + backfill. SQLite can't ADD a
  // NOT NULL column without a default on a populated table, so we land
  // the column nullable, backfill `legacy:<server_seq>` on every existing
  // row, then promote the column to NOT NULL via a table rebuild (the
  // 12-step ALTER TABLE recipe collapsed into one CREATE TABLE … AS
  // SELECT for STRICT mode compatibility).
  const eventsCols = db
    .prepare("PRAGMA table_info('events')")
    .all() as { name: string }[];
  if (!eventsCols.some((c) => c.name === 'episode_key')) {
    db.exec('ALTER TABLE events ADD COLUMN episode_key TEXT');
    db.exec(
      "UPDATE events SET episode_key = 'legacy:' || server_seq WHERE episode_key IS NULL",
    );
    // SQLite has no `ALTER COLUMN … SET NOT NULL`; we rebuild the table
    // to enforce NOT NULL going forward. Indexes survive the rebuild via
    // the CREATE INDEX IF NOT EXISTS calls below. The rebuild preserves
    // server_seq values so existing GET /v1/events `since=` cursors keep
    // working.
    db.exec('BEGIN');
    try {
      // Temporarily lower foreign_keys so the rebuild can drop the old
      // table without cascading the events away. We snapshot the user-
      // visible setting and restore it after.
      const fkRow = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec(`
        CREATE TABLE events_new (
          id TEXT NOT NULL,
          subscription_id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          episode_key TEXT NOT NULL,
          server_seq INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
        ) STRICT;
      `);
      db.exec(`
        INSERT INTO events_new (id, subscription_id, payload_json, episode_key, server_seq, created_at)
          SELECT id, subscription_id, payload_json, episode_key, server_seq, created_at FROM events;
      `);
      db.exec('DROP TABLE events');
      db.exec('ALTER TABLE events_new RENAME TO events');
      // Recreate the two existing indexes; CREATE INDEX IF NOT EXISTS at
      // the top of ensureSchema runs again on next boot but we recreate
      // here to keep this call self-contained.
      db.exec(`
        CREATE INDEX IF NOT EXISTS events_sub_seq
          ON events(subscription_id, server_seq);
      `);
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS events_sub_id_unique
          ON events(subscription_id, id);
      `);
      db.exec(`PRAGMA foreign_keys = ${fkRow.foreign_keys ? 'ON' : 'OFF'}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // `(episode_key, created_at)` index covers per-episode lookups
  // ordered by time — the curator hydrates siblings by episode key, and
  // recall expansion (PE-16) returns them in chronological order.
  db.exec(`
    CREATE INDEX IF NOT EXISTS events_episode_key_ts
      ON events(episode_key, created_at);
  `);

  // Additive migration: events.curated_at was added with the proxy
  // event-curator wiring layer (AGT-386, think-proxy-events PE-06).
  // It records the ISO timestamp at which a terminal event was passed
  // through the curator + cortex-writer pipeline, and is the dedup
  // pivot — `processTerminalEvent` no-ops when `curated_at IS NOT NULL`.
  //
  // Nullable by design. Existing rows pre-AGT-386 keep `curated_at = NULL`
  // and remain eligible for a future backfill pass. Going forward, every
  // event that ingests under the terminal-event model gets curated within
  // a tick or two and stamps a value here. Older non-terminal rows under
  // the legacy episode_key (`legacy:<server_seq>`) are NOT eligible for
  // curation and stay NULL forever — this is intentional and matches the
  // hard cut-over to terminal-event ingest in PE-02.
  //
  // We re-probe rather than reusing the `eventsCols` snapshot above
  // because the AGT-381 rebuild may have run between then and now and
  // dropped/recreated the table without `curated_at`.
  const eventsColsAfter = db
    .prepare("PRAGMA table_info('events')")
    .all() as { name: string }[];
  if (!eventsColsAfter.some((c) => c.name === 'curated_at')) {
    db.exec('ALTER TABLE events ADD COLUMN curated_at TEXT');
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

  // `proxy_kv` (added in AGT-385) is a small key-value table for proxy-wide
  // persisted state that doesn't fit naturally on any of the resource tables.
  // First user: `peer_id` — the single stable identity the proxy stamps on
  // every memory it writes into the team cortex (see `serve/peer-id.ts` and
  // the think-proxy-events project). Future entries (e.g. cortex name once
  // PE-00 lands) can land in the same table without another schema bump.
  //
  // We chose sqlite over a sidecar JSON file because (a) `THINK_DB_PATH`
  // already covers operator override / persistence semantics, and (b) all
  // other proxy state already lives here so backup/restore is one file.
  db.exec(`
    CREATE TABLE IF NOT EXISTS proxy_kv (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
  `);
}
