import { Hono } from 'hono';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { isValidCortexName } from '../lib/cortex-name.js';

const memorySchema = z.object({
  id: z.string().min(1).max(128),
  ts: z.string().min(1).max(64),
  author: z.string().min(1).max(128),
  content: z.string().min(1).max(64_000),
  source_ids: z.array(z.string()).default([]),
  episode_key: z.string().max(256).optional(),
  decisions: z.array(z.string()).optional(),
});

const upsertSchema = z.object({
  memories: z.array(memorySchema).min(1).max(500),
});

export const memories = new Hono();

memories.post('/v1/cortex/:name/memories', async (c) => {
  const cortexName = c.req.param('name');
  if (!isValidCortexName(cortexName)) {
    return c.json({ error: 'invalid cortex name' }, 400);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = upsertSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid body', details: parsed.error.issues }, 400);
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Auto-create the cortex on first write — keeps clients from needing
    // a separate POST /v1/cortex round-trip for the common path.
    await client.query(
      'INSERT INTO cortexes (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
      [cortexName],
    );

    let inserted = 0;
    for (const m of parsed.data.memories) {
      const result = await client.query(
        `INSERT INTO memories
           (cortex_name, id, ts, author, content, source_ids, episode_key, decisions)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb)
         ON CONFLICT (cortex_name, id) DO NOTHING`,
        [
          cortexName,
          m.id,
          m.ts,
          m.author,
          m.content,
          JSON.stringify(m.source_ids),
          m.episode_key ?? null,
          m.decisions ? JSON.stringify(m.decisions) : null,
        ],
      );
      inserted += result.rowCount ?? 0;
    }

    await client.query('COMMIT');
    return c.json({ accepted: parsed.data.memories.length, inserted });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

memories.get('/v1/cortex/:name/memories', async (c) => {
  const cortexName = c.req.param('name');
  if (!isValidCortexName(cortexName)) {
    return c.json({ error: 'invalid cortex name' }, 400);
  }

  const since = Number(c.req.query('since') ?? 0);
  if (!Number.isFinite(since) || since < 0) {
    return c.json({ error: 'invalid since (must be a non-negative integer)' }, 400);
  }

  const limitRaw = Number(c.req.query('limit') ?? 500);
  if (!Number.isFinite(limitRaw) || limitRaw < 1 || limitRaw > 1000) {
    return c.json({ error: 'invalid limit (1..1000)' }, 400);
  }
  const limit = Math.floor(limitRaw);

  const result = await getPool().query<{
    id: string;
    ts: string;
    author: string;
    content: string;
    source_ids: unknown;
    episode_key: string | null;
    decisions: unknown;
    server_seq: string;
  }>(
    `SELECT id, ts, author, content, source_ids, episode_key, decisions, server_seq
       FROM memories
      WHERE cortex_name = $1 AND server_seq > $2
      ORDER BY server_seq ASC
      LIMIT $3`,
    [cortexName, since, limit],
  );

  // server_seq is a BIGSERIAL — pg returns it as string to avoid losing
  // precision past 2^53. Clients are expected to treat it as opaque.
  return c.json({
    memories: result.rows.map(row => ({
      id: row.id,
      ts: row.ts,
      author: row.author,
      content: row.content,
      source_ids: row.source_ids,
      episode_key: row.episode_key,
      decisions: row.decisions,
      server_seq: row.server_seq,
    })),
    next_since: result.rows.length > 0
      ? result.rows[result.rows.length - 1].server_seq
      : String(since),
  });
});
