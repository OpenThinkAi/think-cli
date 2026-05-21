import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { ensureSchema } from '../../../src/serve/db/schema.js';

/**
 * 0.3.0 → 0.4.0 migration: ensureSchema must add `subscriptions.cursor`
 * and the `events_sub_id_unique` index when run against a v0.3.0-shaped
 * DB. Test fixtures are `:memory:`, but a deployed server has an
 * existing file from a prior version, so this is the only place a
 * regression in the additive ALTER would surface.
 */
describe('schema migration from v0.3.0 shape', () => {
  function build03Schema(): DatabaseSync {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    // Verbatim v0.3.0 shape — no cursor column, no UNIQUE index on events.
    db.exec(`
      CREATE TABLE subscriptions (
        id TEXT PRIMARY KEY NOT NULL,
        kind TEXT NOT NULL,
        pattern TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_polled_at TEXT
      ) STRICT;
    `);
    db.exec(`
      CREATE TABLE events (
        id TEXT NOT NULL,
        subscription_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        server_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
      ) STRICT;
    `);
    db.exec(
      'CREATE INDEX events_sub_seq ON events(subscription_id, server_seq);',
    );
    return db;
  }

  it('adds the cursor column to subscriptions', () => {
    const db = build03Schema();
    db.prepare(
      'INSERT INTO subscriptions (id, kind, pattern, created_at) VALUES (?, ?, ?, ?)',
    ).run('s1', 'mock', '1', new Date().toISOString());

    ensureSchema(db);

    const cols = db.prepare("PRAGMA table_info('subscriptions')").all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain('cursor');

    // Pre-existing rows survive with cursor = NULL.
    const row = db.prepare('SELECT cursor FROM subscriptions WHERE id = ?').get('s1') as {
      cursor: string | null;
    };
    expect(row.cursor).toBeNull();
  });

  it('is idempotent: re-running ensureSchema after migration is a no-op', () => {
    const db = build03Schema();
    ensureSchema(db);
    expect(() => ensureSchema(db)).not.toThrow();
    const cols = db.prepare("PRAGMA table_info('subscriptions')").all() as { name: string }[];
    expect(cols.filter((c) => c.name === 'cursor')).toHaveLength(1);
  });

  it('creates the events_sub_id_unique index so INSERT OR IGNORE dedups', () => {
    const db = build03Schema();
    ensureSchema(db);

    db.prepare(
      'INSERT INTO subscriptions (id, kind, pattern, created_at) VALUES (?, ?, ?, ?)',
    ).run('s1', 'mock', '1', new Date().toISOString());
    const stmt = db.prepare(
      'INSERT OR IGNORE INTO events (id, subscription_id, payload_json, episode_key, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    stmt.run('evt-1', 's1', '{}', 'mock:s1:1', new Date().toISOString());
    const second = stmt.run('evt-1', 's1', '{}', 'mock:s1:1', new Date().toISOString());
    expect(second.changes).toBe(0);
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM events WHERE subscription_id = ?')
      .get('s1') as { n: number };
    expect(count.n).toBe(1);
  });

  it('creates source_credentials table on fresh and migrated DBs (AGT-029)', () => {
    // Fresh DB.
    const fresh = new DatabaseSync(':memory:');
    fresh.exec('PRAGMA foreign_keys = ON');
    ensureSchema(fresh);
    const freshCols = fresh
      .prepare("PRAGMA table_info('source_credentials')")
      .all() as { name: string }[];
    expect(freshCols.map((c) => c.name).sort()).toEqual(
      ['ciphertext', 'created_at', 'nonce', 'subscription_id'].sort(),
    );

    // Migrated v0.3.0 DB picks up the table too.
    const migrated = build03Schema();
    ensureSchema(migrated);
    const migratedCols = migrated
      .prepare("PRAGMA table_info('source_credentials')")
      .all() as { name: string }[];
    expect(migratedCols.map((c) => c.name)).toContain('subscription_id');
  });

  it('source_credentials row cascades when subscription is deleted', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    ensureSchema(db);
    db.prepare(
      'INSERT INTO subscriptions (id, kind, pattern, created_at) VALUES (?, ?, ?, ?)',
    ).run('s1', 'mock', '1', new Date().toISOString());
    db.prepare(
      'INSERT INTO source_credentials (subscription_id, ciphertext, nonce, created_at) VALUES (?, ?, ?, ?)',
    ).run('s1', Buffer.from('xx'), Buffer.from('yy'), new Date().toISOString());
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM source_credentials').get(),
    ).toEqual({ n: 1 });
    db.prepare('DELETE FROM subscriptions WHERE id = ?').run('s1');
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM source_credentials').get(),
    ).toEqual({ n: 0 });
  });

  it('different subscriptions can share an event id', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    ensureSchema(db);
    const insertSub = db.prepare(
      'INSERT INTO subscriptions (id, kind, pattern, created_at) VALUES (?, ?, ?, ?)',
    );
    insertSub.run('s1', 'mock', '1', new Date().toISOString());
    insertSub.run('s2', 'mock', '1', new Date().toISOString());
    const insertEvent = db.prepare(
      'INSERT OR IGNORE INTO events (id, subscription_id, payload_json, episode_key, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    expect(
      insertEvent.run('shared-id', 's1', '{}', 'mock:s1:1', new Date().toISOString()).changes,
    ).toBe(1);
    // Same id, different subscription — index is per-subscription.
    expect(
      insertEvent.run('shared-id', 's2', '{}', 'mock:s2:1', new Date().toISOString()).changes,
    ).toBe(1);
  });

  // AGT-381: episode_key migration. A populated pre-AGT-381 DB (events
  // table without the column) must come out of ensureSchema with the
  // column present, NOT NULL, backfilled to `legacy:<server_seq>`, and
  // with the `(episode_key, created_at)` index in place.
  describe('episode_key migration (AGT-381)', () => {
    function buildPreAgt381Db(): DatabaseSync {
      // v0.5.x shape — has `subscriptions.cursor`, `events_sub_id_unique`,
      // `source_credentials`, but no `events.episode_key`. This is the
      // shape an existing deployment carries on disk at the moment
      // AGT-381 lands.
      const db = new DatabaseSync(':memory:');
      db.exec('PRAGMA foreign_keys = ON');
      db.exec(`
        CREATE TABLE subscriptions (
          id TEXT PRIMARY KEY NOT NULL,
          kind TEXT NOT NULL,
          pattern TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_polled_at TEXT,
          cursor TEXT
        ) STRICT;
      `);
      db.exec(`
        CREATE TABLE events (
          id TEXT NOT NULL,
          subscription_id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          server_seq INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
        ) STRICT;
      `);
      db.exec('CREATE INDEX events_sub_seq ON events(subscription_id, server_seq);');
      db.exec('CREATE UNIQUE INDEX events_sub_id_unique ON events(subscription_id, id);');
      db.exec(`
        CREATE TABLE source_credentials (
          subscription_id TEXT PRIMARY KEY NOT NULL,
          ciphertext BLOB NOT NULL,
          nonce BLOB NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
        ) STRICT;
      `);
      return db;
    }

    it('adds the episode_key column to events and backfills legacy:<server_seq>', () => {
      const db = buildPreAgt381Db();
      db.prepare(
        'INSERT INTO subscriptions (id, kind, pattern, created_at) VALUES (?, ?, ?, ?)',
      ).run('s1', 'mock', '1', new Date().toISOString());
      // Seed three rows so the backfill has a non-trivial set to scan.
      const insertOld = db.prepare(
        'INSERT INTO events (id, subscription_id, payload_json, created_at) VALUES (?, ?, ?, ?)',
      );
      insertOld.run('evt-a', 's1', '{}', new Date().toISOString());
      insertOld.run('evt-b', 's1', '{}', new Date().toISOString());
      insertOld.run('evt-c', 's1', '{}', new Date().toISOString());

      ensureSchema(db);

      const cols = db.prepare("PRAGMA table_info('events')").all() as {
        name: string;
        notnull: number;
      }[];
      const episodeCol = cols.find((c) => c.name === 'episode_key');
      expect(episodeCol).toBeDefined();
      // NOT NULL after migration so the contract is enforced going
      // forward — new INSERTs that don't supply episode_key fail.
      expect(episodeCol!.notnull).toBe(1);

      const rows = db
        .prepare('SELECT id, episode_key, server_seq FROM events ORDER BY server_seq ASC')
        .all() as { id: string; episode_key: string; server_seq: number }[];
      expect(rows.map((r) => r.episode_key)).toEqual([
        `legacy:${rows[0].server_seq}`,
        `legacy:${rows[1].server_seq}`,
        `legacy:${rows[2].server_seq}`,
      ]);
    });

    it('creates events_episode_key_ts index on (episode_key, created_at)', () => {
      const db = buildPreAgt381Db();
      ensureSchema(db);
      // index_list reports the indexes attached to a table; index_info
      // reports the columns inside one. Together they confirm both the
      // existence of the named index and the column tuple we documented.
      const indexes = db.prepare("PRAGMA index_list('events')").all() as {
        name: string;
      }[];
      expect(indexes.map((i) => i.name)).toContain('events_episode_key_ts');
      const cols = db
        .prepare("PRAGMA index_info('events_episode_key_ts')")
        .all() as { seqno: number; name: string }[];
      expect(cols.sort((a, b) => a.seqno - b.seqno).map((c) => c.name)).toEqual([
        'episode_key',
        'created_at',
      ]);
    });

    it('uses the events_episode_key_ts index for per-episode lookups', () => {
      const db = new DatabaseSync(':memory:');
      db.exec('PRAGMA foreign_keys = ON');
      ensureSchema(db);
      db.prepare(
        'INSERT INTO subscriptions (id, kind, pattern, created_at) VALUES (?, ?, ?, ?)',
      ).run('s1', 'mock', '1', new Date().toISOString());
      // EXPLAIN QUERY PLAN should pick up the index for an
      // `episode_key = ?` filter ordered by `created_at`. Pinning the
      // plan keeps a regression that drops the index from going
      // unnoticed (the schema query would still execute correctly via
      // table scan, just slowly).
      const plan = db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT id FROM events WHERE episode_key = 'x' ORDER BY created_at",
        )
        .all() as { detail: string }[];
      const text = plan.map((p) => p.detail).join(' | ');
      expect(text).toMatch(/events_episode_key_ts/);
    });

    it('rejects NULL episode_key inserts after migration', () => {
      const db = buildPreAgt381Db();
      ensureSchema(db);
      db.prepare(
        'INSERT INTO subscriptions (id, kind, pattern, created_at) VALUES (?, ?, ?, ?)',
      ).run('s1', 'mock', '1', new Date().toISOString());
      // The schema rebuild promoted episode_key to NOT NULL. Confirm
      // SQLite enforces it — otherwise the migration silently regresses
      // to a nullable column and the curator downstream would have to
      // handle nulls forever.
      expect(() =>
        db
          .prepare(
            'INSERT INTO events (id, subscription_id, payload_json, episode_key, created_at) VALUES (?, ?, ?, ?, ?)',
          )
          .run('evt-x', 's1', '{}', null, new Date().toISOString()),
      ).toThrow();
    });

    it('is idempotent: re-running after migration does not double-rebuild', () => {
      const db = buildPreAgt381Db();
      db.prepare(
        'INSERT INTO subscriptions (id, kind, pattern, created_at) VALUES (?, ?, ?, ?)',
      ).run('s1', 'mock', '1', new Date().toISOString());
      db.prepare(
        'INSERT INTO events (id, subscription_id, payload_json, created_at) VALUES (?, ?, ?, ?)',
      ).run('evt-a', 's1', '{}', new Date().toISOString());
      ensureSchema(db);
      expect(() => ensureSchema(db)).not.toThrow();
      // After second run the row count and episode_key value should be
      // unchanged — second pass takes the fast path (column exists).
      const row = db
        .prepare('SELECT episode_key FROM events WHERE id = ?')
        .get('evt-a') as { episode_key: string };
      expect(row.episode_key).toMatch(/^legacy:/);
      const count = db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
      expect(count.n).toBe(1);
    });

    it('preserves server_seq across the rebuild so existing since= cursors keep working', () => {
      const db = buildPreAgt381Db();
      db.prepare(
        'INSERT INTO subscriptions (id, kind, pattern, created_at) VALUES (?, ?, ?, ?)',
      ).run('s1', 'mock', '1', new Date().toISOString());
      const seedAt = new Date().toISOString();
      // Insert three then delete one — leaves an AUTOINCREMENT gap that
      // the rebuild must respect so CLI consumers paging on `since=2`
      // don't suddenly see row 2 again.
      db.prepare(
        'INSERT INTO events (id, subscription_id, payload_json, created_at) VALUES (?, ?, ?, ?)',
      ).run('evt-a', 's1', '{}', seedAt);
      db.prepare(
        'INSERT INTO events (id, subscription_id, payload_json, created_at) VALUES (?, ?, ?, ?)',
      ).run('evt-b', 's1', '{}', seedAt);
      db.prepare(
        'INSERT INTO events (id, subscription_id, payload_json, created_at) VALUES (?, ?, ?, ?)',
      ).run('evt-c', 's1', '{}', seedAt);
      db.prepare('DELETE FROM events WHERE id = ?').run('evt-b');

      const before = db
        .prepare('SELECT id, server_seq FROM events ORDER BY server_seq')
        .all() as { id: string; server_seq: number }[];

      ensureSchema(db);

      const after = db
        .prepare('SELECT id, server_seq FROM events ORDER BY server_seq')
        .all() as { id: string; server_seq: number }[];
      expect(after).toEqual(before);
    });

    it('fresh DB lands with episode_key NOT NULL and the index', () => {
      // Fresh DBs go through the CREATE TABLE path, not the rebuild —
      // the assertion catches a regression where the post-rebuild shape
      // and the CREATE TABLE shape diverge.
      const db = new DatabaseSync(':memory:');
      db.exec('PRAGMA foreign_keys = ON');
      ensureSchema(db);
      const cols = db.prepare("PRAGMA table_info('events')").all() as {
        name: string;
        notnull: number;
      }[];
      const episodeCol = cols.find((c) => c.name === 'episode_key');
      expect(episodeCol).toBeDefined();
      expect(episodeCol!.notnull).toBe(1);
      const indexes = db.prepare("PRAGMA index_list('events')").all() as {
        name: string;
      }[];
      expect(indexes.map((i) => i.name)).toContain('events_episode_key_ts');
    });
  });
});
