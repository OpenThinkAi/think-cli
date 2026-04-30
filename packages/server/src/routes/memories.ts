import { Hono } from 'hono';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { isValidCortexName, CORTEX_NAME_ERROR } from '../lib/cortex-name.js';

export const FIELD_LIMITS = {
  id: 128,
  ts: 64,
  author: 128,
  content: 64_000,
  episode_key: 256,
  memories_per_request: 500,
} as const;

const memorySchema = z.object({
  id: z.string().min(1).max(FIELD_LIMITS.id),
  ts: z.string().min(1).max(FIELD_LIMITS.ts),
  author: z.string().min(1).max(FIELD_LIMITS.author),
  content: z.string().min(1).max(FIELD_LIMITS.content),
  source_ids: z.array(z.string()).default([]),
  episode_key: z.string().max(FIELD_LIMITS.episode_key).optional(),
  decisions: z.array(z.string()).optional(),
});

const upsertSchema = z.object({
  memories: z.array(memorySchema).min(1),
});

export const memories = new Hono();

memories.post('/v1/cortexes/:name/memories', async (c) => {
  const cortexName = c.req.param('name');
  if (!isValidCortexName(cortexName)) {
    return c.json({ error: CORTEX_NAME_ERROR }, 400);
  }

  const body = await c.req.json().catch(() => null) as { memories?: unknown[] } | null;
  // Hard cap on batch size before zod even runs — protects against
  // multi-MB JSON bodies that pass schema validation but waste cycles.
  if (Array.isArray(body?.memories) && body.memories.length > FIELD_LIMITS.memories_per_request) {
    return c.json(
      { error: `too many memories in one request (max ${FIELD_LIMITS.memories_per_request})` },
      400,
    );
  }
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

memories.get('/v1/cortexes/:name/memories', async (c) => {
  const cortexName = c.req.param('name');
  if (!isValidCortexName(cortexName)) {
    return c.json({ error: CORTEX_NAME_ERROR }, 400);
  }

  // Parse `since` as a non-negative bigint string so the BIGSERIAL precision
  // claim made on the wire format is actually honored end-to-end.
  const sinceRaw = c.req.query('since') ?? '0';
  let since: bigint;
  try {
    since = BigInt(sinceRaw);
  } catch {
    return c.json({ error: 'invalid since (must be a non-negative integer)' }, 400);
  }
  if (since < 0n) {
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
    // node-postgres binds string params as text; pg coerces to int8.
    // Passing the string keeps the value safe past 2^53.
    `SELECT id, ts, author, content, source_ids, episode_key, decisions, server_seq
       FROM memories
      WHERE cortex_name = $1 AND server_seq > $2::int8
      ORDER BY server_seq ASC
      LIMIT $3`,
    [cortexName, since.toString(), limit],
  );

  return c.json({
    memories: result.rows,
    next_since: result.rows.length > 0
      ? result.rows[result.rows.length - 1].server_seq
      : since.toString(),
  });
});
