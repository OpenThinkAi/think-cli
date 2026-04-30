import { Hono } from 'hono';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { isValidCortexName, CORTEX_NAME_ERROR } from '../lib/cortex-name.js';

export const LT_FIELD_LIMITS = {
  id: 128,
  ts: 64,
  author: 128,
  kind: 64,
  title: 512,
  content: 64_000,
  supersedes: 128,
  events_per_request: 500,
} as const;

const eventSchema = z.object({
  id: z.string().min(1).max(LT_FIELD_LIMITS.id),
  ts: z.string().min(1).max(LT_FIELD_LIMITS.ts),
  author: z.string().min(1).max(LT_FIELD_LIMITS.author),
  kind: z.string().min(1).max(LT_FIELD_LIMITS.kind),
  title: z.string().min(1).max(LT_FIELD_LIMITS.title),
  content: z.string().min(1).max(LT_FIELD_LIMITS.content),
  topics: z.array(z.string()).default([]),
  supersedes: z.string().max(LT_FIELD_LIMITS.supersedes).nullable().optional(),
  source_memory_ids: z.array(z.string()).default([]),
  deleted_at: z.string().max(64).nullable().optional(),
});

const upsertSchema = z.object({
  events: z.array(eventSchema).min(1),
});

export const longTermEvents = new Hono();

longTermEvents.post('/v1/cortexes/:name/long-term-events', async (c) => {
  const cortexName = c.req.param('name');
  if (!isValidCortexName(cortexName)) {
    return c.json({ error: CORTEX_NAME_ERROR }, 400);
  }

  const body = await c.req.json().catch(() => null) as { events?: unknown[] } | null;
  if (Array.isArray(body?.events) && body.events.length > LT_FIELD_LIMITS.events_per_request) {
    return c.json(
      { error: `too many events in one request (max ${LT_FIELD_LIMITS.events_per_request})` },
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

    await client.query(
      'INSERT INTO cortexes (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
      [cortexName],
    );

    const payload = parsed.data.events.map(e => ({
      id: e.id,
      ts: e.ts,
      author: e.author,
      kind: e.kind,
      title: e.title,
      content: e.content,
      topics: e.topics,
      supersedes: e.supersedes ?? null,
      source_memory_ids: e.source_memory_ids,
      deleted_at: e.deleted_at ?? null,
    }));

    // Upsert semantics:
    //   - INSERT a new (cortex, id) row outright.
    //   - On conflict, content fields are immutable (already-stored row wins);
    //     `deleted_at` is sticky-additive: once set, stays set; if currently
    //     NULL and the incoming row carries one, it gets stamped AND the
    //     row's server_seq is bumped so other peers will see the tombstone
    //     on their next pull. The WHERE clause prevents pointless updates
    //     (and seq bumps) when neither side has new tombstone info.
    const result = await client.query(
      `INSERT INTO long_term_events
         (cortex_name, id, ts, author, kind, title, content, topics, supersedes, source_memory_ids, deleted_at)
       SELECT $1, x.id, x.ts, x.author, x.kind, x.title, x.content,
              x.topics, x.supersedes, x.source_memory_ids, x.deleted_at
         FROM jsonb_to_recordset($2::jsonb) AS x(
           id text, ts text, author text, kind text, title text, content text,
           topics jsonb, supersedes text, source_memory_ids jsonb, deleted_at text
         )
       ON CONFLICT (cortex_name, id) DO UPDATE
         SET deleted_at = EXCLUDED.deleted_at,
             server_seq = nextval('long_term_events_seq')
         WHERE long_term_events.deleted_at IS NULL AND EXCLUDED.deleted_at IS NOT NULL`,
      [cortexName, JSON.stringify(payload)],
    );

    await client.query('COMMIT');
    // Same field name as the memories endpoint for cross-resource consistency.
    // For memories `inserted` is strictly insert-count (memories are immutable);
    // for LT events `inserted` also counts the tombstone-update path because
    // that's the only update path a row can take, and it represents new
    // information the server didn't have before. Both endpoints answer the
    // same question: how many of these did you newly observe?
    return c.json({
      accepted: parsed.data.events.length,
      inserted: result.rowCount ?? 0,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

longTermEvents.get('/v1/cortexes/:name/long-term-events', async (c) => {
  const cortexName = c.req.param('name');
  if (!isValidCortexName(cortexName)) {
    return c.json({ error: CORTEX_NAME_ERROR }, 400);
  }

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

  const result = await getPool().query(
    `SELECT id, ts, author, kind, title, content, topics, supersedes, source_memory_ids, deleted_at, server_seq
       FROM long_term_events
      WHERE cortex_name = $1 AND server_seq > $2::int8
      ORDER BY server_seq ASC
      LIMIT $3`,
    [cortexName, since.toString(), limit],
  );

  return c.json({
    events: result.rows,
    next_since: result.rows.length > 0
      ? (result.rows[result.rows.length - 1] as { server_seq: string }).server_seq
      : since.toString(),
  });
});
