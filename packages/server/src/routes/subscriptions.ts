import { Hono } from 'hono';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Database } from '../db.js';

const createSchema = z.object({
  kind: z.string().min(1),
  pattern: z.string().min(1),
});

interface SubscriptionRow {
  id: string;
  kind: string;
  pattern: string;
  created_at: string;
  last_polled_at: string | null;
}

export function subscriptionsRoute(db: Database): Hono {
  const route = new Hono();

  route.post('/v1/subscriptions', async (c) => {
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return c.json({ error: 'invalid json body' }, 400);
    }
    const parsed = createSchema.safeParse(json);
    if (!parsed.success) {
      return c.json({ error: 'invalid body', detail: parsed.error.issues }, 400);
    }
    const id = randomUUID();
    const created_at = new Date().toISOString();
    db.prepare(
      'INSERT INTO subscriptions (id, kind, pattern, created_at) VALUES (?, ?, ?, ?)',
    ).run(id, parsed.data.kind, parsed.data.pattern, created_at);
    return c.json(
      {
        subscription: {
          id,
          kind: parsed.data.kind,
          pattern: parsed.data.pattern,
          created_at,
          last_polled_at: null,
        },
      },
      201,
    );
  });

  route.get('/v1/subscriptions', (c) => {
    const rows = db
      .prepare(
        'SELECT id, kind, pattern, created_at, last_polled_at FROM subscriptions ORDER BY created_at ASC',
      )
      .all() as SubscriptionRow[];
    return c.json({ subscriptions: rows });
  });

  route.get('/v1/subscriptions/:id', (c) => {
    const row = db
      .prepare(
        'SELECT id, kind, pattern, created_at, last_polled_at FROM subscriptions WHERE id = ?',
      )
      .get(c.req.param('id')) as SubscriptionRow | undefined;
    if (!row) return c.json({ error: 'subscription not found' }, 404);
    return c.json({ subscription: row });
  });

  route.delete('/v1/subscriptions/:id', (c) => {
    const result = db
      .prepare('DELETE FROM subscriptions WHERE id = ?')
      .run(c.req.param('id'));
    if (result.changes === 0) {
      return c.json({ error: 'subscription not found' }, 404);
    }
    return c.body(null, 204);
  });

  return route;
}
