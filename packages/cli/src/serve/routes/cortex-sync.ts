import { Hono } from 'hono';
import type { Database } from '../db.js';
import {
  appendCortexLine,
  readCortexLines,
  maxCortexSeq,
} from '../cortex-lines-store.js';
import {
  pushRequestSchema,
  pullRequestSchema,
  type PushResponse,
  type PushedLineResult,
  type PullResponse,
} from '../../sync/hub-protocol.js';

/**
 * Cortex-sync HTTP routes — AGT-572, cortex-sync hub.
 *
 * Implements the AGT-570 wire contract (`sync/hub-protocol.ts`,
 * `docs/cortex-sync-protocol.md`) against the AGT-571 store
 * (`cortex-lines-store.ts`). Two routes:
 *
 *   - `POST /v1/cortex-sync/push` — append a batch of memory lines, returning
 *     each line's authoritative `server_seq` and whether it was newly
 *     `accepted` or an idempotent `duplicate`.
 *   - `GET  /v1/cortex-sync/pull` — range-read lines with `server_seq > cursor`,
 *     ordered ascending, capped at `limit`, returning the next cursor + a
 *     `hasMore` page-full flag.
 *
 * Both validate strictly against the protocol's own zod schemas (reused, never
 * redefined) and return `400` on an invalid body/query.
 *
 * Routing note: these deliberately live under `/v1/cortex-sync/*`, NOT under
 * `/v1/cortexes` — the latter is reserved for the pre-auth `410 cortex storage
 * retired` shim for legacy 0.1.x clients (see `app.ts`). Colliding would mask
 * these routes behind that 410.
 *
 * Auth: this factory adds NO auth of its own. It is mounted inside the
 * `authed` group in `app.ts`, inheriting the existing single-tenant
 * `bearerAuth()` / `THINK_TOKEN` middleware (AC2/AC3). Single-tenant means one
 * token guards one logical cortex namespace; the cortex name in the request
 * body selects a namespace partition within that single tenant, it is NOT a
 * tenant boundary. Multi-tenant resolution is a later think-hub wave.
 */
export function cortexSyncRoute(db: Database): Hono {
  const route = new Hono();

  // --- PUSH (AC1, AC4) ---------------------------------------------------
  route.post('/v1/cortex-sync/push', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const parsed = pushRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'invalid body', detail: parsed.error.issues }, 400);
    }
    const { cortex, lines } = parsed.data;

    const results: PushedLineResult[] = [];
    let accepted = 0;
    let duplicates = 0;
    for (const line of lines) {
      const r = appendCortexLine(db, cortex, line);
      results.push({
        id: r.id,
        server_seq: r.server_seq,
        status: r.inserted ? 'accepted' : 'duplicate',
      });
      if (r.inserted) accepted += 1;
      else duplicates += 1;
    }

    const body: PushResponse = {
      results,
      accepted,
      duplicates,
      maxServerSeq: maxCortexSeq(db, cortex),
    };
    return c.json(body);
  });

  // --- PULL (AC1, AC4) ---------------------------------------------------
  route.get('/v1/cortex-sync/pull', (c) => {
    const parsed = pullRequestSchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: 'invalid query', detail: parsed.error.issues }, 400);
    }
    const { cortex, cursor, limit } = parsed.data;

    const lines = readCortexLines(db, cortex, cursor, limit);

    // nextCursor: the max server_seq in this page (lines are ASC, so the last
    // row). On an empty page the cursor is unchanged, so the client polls the
    // same point. hasMore is true iff the page was full — there may be more
    // lines past nextCursor (mirrors the contract's pagination rule).
    const nextCursor =
      lines.length > 0 ? lines[lines.length - 1].server_seq : cursor;
    const hasMore = lines.length === limit;

    const body: PullResponse = { lines, nextCursor, hasMore };
    return c.json(body);
  });

  return route;
}
