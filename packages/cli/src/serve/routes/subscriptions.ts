import { Hono } from 'hono';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Database } from '../db.js';
import {
  MAX_REDACT_SELECTORS,
  MAX_SELECTOR_LENGTH,
  parseSelector,
} from '../../lib/subscribe-redact.js';

const createSchema = z.object({
  kind: z.string().trim().min(1),
  pattern: z.string().trim().min(1),
});

/**
 * Per-subscription redact selectors (AGT-2337). Each selector must parse
 * under the JSONPath subset `parseSelector` accepts; an empty array clears
 * them. Bounded so a client can't store an unbounded blob on the proxy.
 */
const redactSchema = z.object({
  selectors: z
    .array(
      z
        .string()
        .max(MAX_SELECTOR_LENGTH)
        .refine((s) => parseSelector(s) !== null, {
          message: 'unsupported selector (use `$.a.b.c` or `a.b.c`; no indices, wildcards, or filters)',
        }),
    )
    .max(MAX_REDACT_SELECTORS),
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
    c.header('Location', `/v1/subscriptions/${id}`);
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
      .all() as unknown as SubscriptionRow[];
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

  // Replace the subscription's redact selectors (AGT-2337). The terminal-
  // event curator applies them, after the baseline PII strip, to every
  // event payload of this subscription before the LLM sees it.
  route.put('/v1/subscriptions/:id/redact', async (c) => {
    const id = c.req.param('id');
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return c.json({ error: 'invalid json body' }, 400);
    }
    const parsed = redactSchema.safeParse(json);
    if (!parsed.success) {
      return c.json({ error: 'invalid body', detail: parsed.error.issues }, 400);
    }
    const selectors = parsed.data.selectors.map((s) => s.trim());
    const result = db
      .prepare('UPDATE subscriptions SET redact_selectors = ? WHERE id = ?')
      .run(selectors.length === 0 ? null : JSON.stringify(selectors), id);
    if (result.changes === 0) {
      return c.json({ error: 'subscription not found' }, 404);
    }
    return c.json({ id, redact_selectors: selectors });
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
