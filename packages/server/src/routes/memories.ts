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
    return c.json({ error: 'invalid cortex name (use a-z, A-Z, 0-9, _, -)' }, 400);
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

    // Single round-trip bulk insert via jsonb_to_recordset. ON CONFLICT
    // DO NOTHING preserves immutability — existing rows are never overwritten.
    const payload = parsed.data.memories.map(m => ({
      id: m.id,
      ts: m.ts,
      author: m.author,
      content: m.content,
      source_ids: m.source_ids,
      episode_key: m.episode_key ?? null,
      decisions: m.decisions ?? null,
    }));

    const result = await client.query(
      `INSERT INTO memories
         (cortex_name, id, ts, author, content, source_ids, episode_key, decisions)
       SELECT $1, x.id, x.ts, x.author, x.content, x.source_ids, x.episode_key, x.decisions
         FROM jsonb_to_recordset($2::jsonb) AS x(
           id text, ts text, author text, content text,
           source_ids jsonb, episode_key text, decisions jsonb
         )
       ON CONFLICT (cortex_name, id) DO NOTHING`,
      [cortexName, JSON.stringify(payload)],
    );

    await client.query('COMMIT');
    return c.json({ accepted: parsed.data.memories.length, inserted: result.rowCount ?? 0 });
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
    return c.json({ error: 'invalid cortex name (use a-z, A-Z, 0-9, _, -)' }, 400);
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

  // server_seq is a BIGSERIAL; pg returns it as a string to preserve precision
  // past 2^53. The cursor wire format is "non-negative integer encoded as
  // string" — clients pass it verbatim back as `since=`. If we ever need to
  // change the cursor shape (composite key, base64, etc.) it'll need a
  // version bump on the route.
  return c.json({
    memories: result.rows,
    next_since: result.rows.length > 0
      ? result.rows[result.rows.length - 1].server_seq
      : String(since),
  });
});
