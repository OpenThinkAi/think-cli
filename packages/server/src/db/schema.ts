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
}
