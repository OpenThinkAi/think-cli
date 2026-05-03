import { Hono } from 'hono';
import { z } from 'zod';
import type { Database } from '../db.js';

const EVENTS_DEFAULT_LIMIT = 100;
const EVENTS_MAX_LIMIT = 1000;

const querySchema = z.object({
  subscription_id: z.string().min(1),
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(EVENTS_MAX_LIMIT).default(EVENTS_DEFAULT_LIMIT),
});

interface EventRow {
  id: string;
  subscription_id: string;
  payload_json: string;
  server_seq: number;
  created_at: string;
}

export function eventsRoute(db: Database): Hono {
  const route = new Hono();

  route.get('/v1/events', (c) => {
    const parsed = querySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: 'invalid query', detail: parsed.error.issues }, 400);
    }
    const { subscription_id, since, limit } = parsed.data;

    // 404 instead of empty array when the subscription is unknown — saves
    // callers from polling a typo'd id forever and getting `events: []` back.
    const sub = db
      .prepare('SELECT id FROM subscriptions WHERE id = ?')
      .get(subscription_id);
    if (!sub) {
      return c.json({ error: 'subscription not found' }, 404);
    }

    const rows = db
      .prepare(
        `SELECT id, subscription_id, payload_json, server_seq, created_at
           FROM events
          WHERE subscription_id = ? AND server_seq > ?
          ORDER BY server_seq ASC
          LIMIT ?`,
      )
      .all(subscription_id, since, limit) as EventRow[];

    // Side-effect on a read endpoint: cheap, idempotent, and the only signal
    // a connector has that anyone is listening to its subscription.
    db.prepare('UPDATE subscriptions SET last_polled_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      subscription_id,
    );

    const events = rows.map((r) => ({
      id: r.id,
      subscription_id: r.subscription_id,
      payload: JSON.parse(r.payload_json),
      server_seq: r.server_seq,
      created_at: r.created_at,
    }));
    const next_since = rows.length > 0 ? rows[rows.length - 1].server_seq : null;

    return c.json({ events, next_since });
  });

  return route;
}
