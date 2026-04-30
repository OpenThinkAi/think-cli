import type pg from 'pg';

/**
 * Idempotent schema bootstrap. Runs once on server start.
 *
 * Single `memories` table mirroring the CLI's row shape plus:
 * - `cortex_name` to scope rows by cortex
 * - `server_seq` (BIGSERIAL) as the pagination cursor — every insert gets a
 *   monotonically-increasing sequence number; clients use it as their
 *   `since=` cursor on pull.
 * - `created_at_server` for audit.
 *
 * Memory ids are content-derived on the client (`deterministicId(ts, author,
 * content)`), so the (cortex_name, id) pair is the natural deduplication key.
 * `INSERT ... ON CONFLICT DO NOTHING` makes upserts idempotent without
 * touching existing rows — memories are immutable per the SyncAdapter
 * contract.
 *
 * Engrams are intentionally absent. There is no engram table, no engram
 * endpoint, and no path through this schema by which engram content could
 * leave a developer's machine.
 */
export async function ensureSchema(client: pg.PoolClient | pg.Pool): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS memories (
      cortex_name TEXT NOT NULL,
      id TEXT NOT NULL,
      ts TEXT NOT NULL,
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      source_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      episode_key TEXT,
      decisions JSONB,
      server_seq BIGSERIAL UNIQUE NOT NULL,
      created_at_server TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (cortex_name, id)
    );
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_memories_cortex_seq
      ON memories (cortex_name, server_seq);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS cortexes (
      name TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Long-term events mirror the CLI's higher-level lifecycle log (decisions,
  // milestones, incidents, etc.). Unlike memories, LT events DO carry
  // tombstones across the wire — supersession and explicit deletes are part
  // of the data model. The PK is (cortex_name, id) for dedup; the upsert
  // strategy picks the "tombstoned wins" rule (see routes file).
  //
  // server_seq uses an explicit named sequence (rather than BIGSERIAL) so
  // the route handler can call nextval() on UPDATE too. Without that,
  // tombstone updates wouldn't bump the cursor and other peers would never
  // see the deletion on their next pull.
  await client.query(`CREATE SEQUENCE IF NOT EXISTS long_term_events_seq`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS long_term_events (
      cortex_name TEXT NOT NULL,
      id TEXT NOT NULL,
      ts TEXT NOT NULL,
      author TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      topics JSONB NOT NULL DEFAULT '[]'::jsonb,
      supersedes TEXT,
      source_memory_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      deleted_at TEXT,
      server_seq BIGINT NOT NULL UNIQUE DEFAULT nextval('long_term_events_seq'),
      created_at_server TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (cortex_name, id)
    );
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_lte_cortex_seq
      ON long_term_events (cortex_name, server_seq);
  `);
}
