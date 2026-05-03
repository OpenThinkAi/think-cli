import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { ensureSchema } from '../../src/db/schema.js';

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
      'INSERT OR IGNORE INTO events (id, subscription_id, payload_json, created_at) VALUES (?, ?, ?, ?)',
    );
    stmt.run('evt-1', 's1', '{}', new Date().toISOString());
    const second = stmt.run('evt-1', 's1', '{}', new Date().toISOString());
    expect(second.changes).toBe(0);
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM events WHERE subscription_id = ?')
      .get('s1') as { n: number };
    expect(count.n).toBe(1);
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
      'INSERT OR IGNORE INTO events (id, subscription_id, payload_json, created_at) VALUES (?, ?, ?, ?)',
    );
    expect(insertEvent.run('shared-id', 's1', '{}', new Date().toISOString()).changes).toBe(1);
    // Same id, different subscription — index is per-subscription.
    expect(insertEvent.run('shared-id', 's2', '{}', new Date().toISOString()).changes).toBe(1);
  });
});
