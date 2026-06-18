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
 *
 * `cortex_lines` (added in AGT-571, cortex-sync hub store) is the backing
 * store for cursor-based pull. It holds the memory lines a hub seat has
 * accepted, each stamped with a **per-cortex** monotonic `server_seq` — the
 * pull cursor defined by the AGT-570 wire contract (`sync/hub-protocol.ts`
 * `StoredLine.server_seq`, `docs/cortex-sync-protocol.md#server_seq`). The
 * append/read functions and the full rationale live in
 * `serve/cortex-lines-store.ts`.
 *
 * Why `server_seq` here is a plain `INTEGER` and NOT `AUTOINCREMENT` like
 * `events.server_seq`: that column is a *global* rowid sequence, but the wire
 * contract requires each cortex to own an *independent* sequence space
 * ("sequences are not comparable across cortexes" — AGT-570 spec). So the
 * store assigns it per cortex as `COALESCE(MAX(server_seq),0)+1 WHERE
 * cortex=?` inside a single write transaction. That is collision-safe for the
 * SAME reason `events` AUTOINCREMENT is safe: `think serve` is single-process
 * / single-writer (the v2 single-tenant decision), so no two appends race for
 * the same MAX. A future multi-writer hub would break this and need a
 * dedicated per-cortex sequence table (`cortex_seq(cortex PK, next_seq)`)
 * bumped under a row lock — out of scope for v1, called out so the invariant
 * isn't silently relied on.
 *
 * `cortex_lines_cortex_seq` indexes `(cortex, server_seq)` — it covers BOTH
 * the hot-path range read (`WHERE cortex=? AND server_seq > ? ORDER BY
 * server_seq LIMIT N`) and the `MAX(server_seq) WHERE cortex=?` lookup the
 * append uses to allocate the next seq.
 *
 * `cortex_lines_cortex_id_unique` enforces `(cortex, id)` uniqueness so an
 * `INSERT OR IGNORE` tolerates a client replaying a line (memories have
 * content-derived ids — re-pushing the same line MUST NOT duplicate it or
 * reassign its seq). This mirrors `events_sub_id_unique` + `INSERT OR IGNORE`
 * tolerating connector id replays; per-cortex scoping lets two cortexes
 * legitimately share an id namespace.
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
      occurred_at TEXT,
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

  // Additive migration: events.occurred_at records the source artifact's
  // real settle time (PR merged_at/closed_at, release published_at, Slack
  // thread root time) as supplied by the connector's `EventInput.occurredAt`.
  // It becomes the curated memory's `ts` (driving recall recency), falling
  // back to wall-clock insertion time when null. Nullable by design:
  // pre-existing rows and any event whose connector couldn't determine a
  // clean source date stay NULL and fall back to insertion time. Re-probed
  // (not reusing the snapshot above) because the AGT-381 rebuild may have
  // rebuilt the table since.
  const eventsColsForOccurred = db
    .prepare("PRAGMA table_info('events')")
    .all() as { name: string }[];
  if (!eventsColsForOccurred.some((c) => c.name === 'occurred_at')) {
    db.exec('ALTER TABLE events ADD COLUMN occurred_at TEXT');
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

  // `cortex_lines` (AGT-571) — see the header block for why `server_seq` is a
  // per-cortex sequence assigned in the store rather than AUTOINCREMENT. A
  // brand-new table needs only CREATE IF NOT EXISTS; existing DBs from prior
  // versions simply gain the empty table on next boot (additive, AC4).
  //
  // Columns mirror the AGT-570 wire `StoredLine` (`sync/hub-protocol.ts`):
  //   - `id` is the content-derived `deterministicId(ts, author, content)`.
  //   - the always-present wire fields (`ts`, `author`, `content`,
  //     `source_ids`) are stored as their own columns; `source_ids` is a JSON
  //     TEXT array since SQLite has no array type.
  //   - the optional wire fields (`episode_key`, `decisions`,
  //     `origin_peer_id`) are nullable; `decisions` is JSON TEXT when present.
  //   - `created_at` is the server's wall-clock accept time, distinct from the
  //     line's own `ts` (the memory's authored timestamp) — kept for audit /
  //     debugging, never part of the wire contract.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cortex_lines (
      cortex TEXT NOT NULL,
      id TEXT NOT NULL,
      server_seq INTEGER NOT NULL,
      ts TEXT NOT NULL,
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      source_ids TEXT NOT NULL,
      episode_key TEXT,
      decisions TEXT,
      origin_peer_id TEXT,
      created_at TEXT NOT NULL
    ) STRICT;
  `);
  // Covers the range-read hot path AND the per-cortex MAX(server_seq) lookup
  // the append uses to allocate the next seq.
  db.exec(`
    CREATE INDEX IF NOT EXISTS cortex_lines_cortex_seq
      ON cortex_lines(cortex, server_seq);
  `);
  // Idempotent re-append: a UNIQUE (cortex, id) lets `INSERT OR IGNORE`
  // tolerate a replayed content-derived line without duplicating it.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS cortex_lines_cortex_id_unique
      ON cortex_lines(cortex, id);
  `);
}
