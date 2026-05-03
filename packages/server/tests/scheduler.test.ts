import { describe, it, expect, beforeEach } from 'vitest';
import { createTestClient, type TestClient } from './fixtures/app-client.js';
import { buildDefaultRegistry, registerConnector } from '../src/connectors/registry.js';
import type { SourceConnector } from '../src/connectors/types.js';

let client: TestClient;
let subId: string;

async function createSub(c: TestClient, body: { kind: string; pattern: string }): Promise<string> {
  const r = await c.request<{ subscription: { id: string } }>({
    method: 'POST',
    path: '/v1/subscriptions',
    body,
  });
  return r.body.subscription.id;
}

describe('scheduler — e2e (AC #7)', () => {
  beforeEach(async () => {
    client = createTestClient();
    subId = await createSub(client, { kind: 'mock', pattern: '3' });
  });

  it('events accumulate with monotonic ids across ticks; last_polled_at updates', async () => {
    const beforeRow = client.db
      .prepare('SELECT last_polled_at FROM subscriptions WHERE id = ?')
      .get(subId) as { last_polled_at: string | null };
    expect(beforeRow.last_polled_at).toBeNull();

    const r1 = await client.tickOnce();
    expect(r1.outcomes).toHaveLength(1);
    expect(r1.outcomes[0].status).toBe('ok');
    expect(r1.outcomes[0].events_inserted).toBe(3);
    expect(r1.outcomes[0].events_emitted).toBe(3);

    const r2 = await client.tickOnce();
    expect(r2.outcomes[0].events_inserted).toBe(3);

    // Read endpoint reflects the accumulated events with monotonic server_seq.
    const events = await client.request<{
      events: { id: string; server_seq: number; payload: { seq: number } }[];
      next_since: number | null;
    }>({ path: `/v1/events?subscription_id=${subId}` });
    expect(events.body.events).toHaveLength(6);
    expect(events.body.events.map((e) => e.id)).toEqual([
      'mock-1',
      'mock-2',
      'mock-3',
      'mock-4',
      'mock-5',
      'mock-6',
    ]);
    const seqs = events.body.events.map((e) => e.server_seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs); // already monotonic ascending
    expect(events.body.next_since).toBe(seqs[seqs.length - 1]);

    // last_polled_at is now set, and the cursor advanced to count=6.
    const after = client.db
      .prepare('SELECT last_polled_at, cursor FROM subscriptions WHERE id = ?')
      .get(subId) as { last_polled_at: string | null; cursor: string | null };
    expect(after.last_polled_at).not.toBeNull();
    expect(JSON.parse(after.cursor!)).toEqual({ count: 6 });
  });

  it('INSERT OR IGNORE dedups when a connector replays an id', async () => {
    // Custom connector that returns the same id on every poll.
    const replayConnector: SourceConnector<{ count: number }> = {
      kind: 'replay',
      async poll(ctx) {
        const next = (ctx.cursor?.count ?? 0) + 1;
        return {
          events: [{ id: 'duplicate-id', payload: { n: next } }],
          nextCursor: { count: next },
        };
      },
    };
    const registry = buildDefaultRegistry();
    registerConnector(registry, replayConnector);
    client = createTestClient({ registry });
    const replaySub = await createSub(client, { kind: 'replay', pattern: 'x' });

    const r1 = await client.tickOnce();
    const out1 = r1.outcomes.find((o) => o.subscription_id === replaySub)!;
    expect(out1.events_inserted).toBe(1);
    expect(out1.events_emitted).toBe(1);

    const r2 = await client.tickOnce();
    const out2 = r2.outcomes.find((o) => o.subscription_id === replaySub)!;
    expect(out2.events_emitted).toBe(1);
    expect(out2.events_inserted).toBe(0); // INSERT OR IGNORE dropped it
    expect(out2.status).toBe('ok'); // dedup is not an error

    // Cursor still advanced — the connector reported progress even though
    // the id was a replay.
    const row = client.db
      .prepare('SELECT cursor FROM subscriptions WHERE id = ?')
      .get(replaySub) as { cursor: string };
    expect(JSON.parse(row.cursor)).toEqual({ count: 2 });
  });

  it('isolates failures: one bad connector does not block the others', async () => {
    const explodingConnector: SourceConnector<unknown> = {
      kind: 'explode',
      async poll() {
        throw new Error('boom');
      },
    };
    const registry = buildDefaultRegistry();
    registerConnector(registry, explodingConnector);
    client = createTestClient({ registry });

    const goodSub = await createSub(client, { kind: 'mock', pattern: '2' });
    const badSub = await createSub(client, { kind: 'explode', pattern: 'n/a' });

    const report = await client.tickOnce();
    const goodOutcome = report.outcomes.find((o) => o.subscription_id === goodSub)!;
    const badOutcome = report.outcomes.find((o) => o.subscription_id === badSub)!;
    expect(goodOutcome.status).toBe('ok');
    expect(goodOutcome.events_inserted).toBe(2);
    expect(badOutcome.status).toBe('error');
    expect(badOutcome.error).toBe('boom');

    // last_polled_at: set on success, stays null on failure.
    const goodRow = client.db
      .prepare('SELECT last_polled_at FROM subscriptions WHERE id = ?')
      .get(goodSub) as { last_polled_at: string | null };
    const badRow = client.db
      .prepare('SELECT last_polled_at FROM subscriptions WHERE id = ?')
      .get(badSub) as { last_polled_at: string | null };
    expect(goodRow.last_polled_at).not.toBeNull();
    expect(badRow.last_polled_at).toBeNull();
  });

  it('skips subscriptions whose kind has no registered connector', async () => {
    // Insert a row directly so we bypass the route-level shape check —
    // the scheduler must be defensive against rows whose connector was
    // unregistered between subscription create and tick.
    client.db
      .prepare(
        'INSERT INTO subscriptions (id, kind, pattern, created_at) VALUES (?, ?, ?, ?)',
      )
      .run('orphan-sub', 'unknown-kind', 'x', new Date().toISOString());

    const report = await client.tickOnce();
    const orphan = report.outcomes.find((o) => o.subscription_id === 'orphan-sub')!;
    expect(orphan.status).toBe('skipped');
    expect(orphan.events_inserted).toBe(0);
  });

  it('GET /v1/events sees the events the scheduler wrote, with next_since advancing', async () => {
    await client.tickOnce();
    const r1 = await client.request<{ events: unknown[]; next_since: number | null }>({
      path: `/v1/events?subscription_id=${subId}`,
    });
    expect(r1.body.events).toHaveLength(3);
    expect(r1.body.next_since).not.toBeNull();
    const cursor1 = r1.body.next_since!;

    await client.tickOnce();
    const r2 = await client.request<{ events: unknown[]; next_since: number | null }>({
      path: `/v1/events?subscription_id=${subId}&since=${cursor1}`,
    });
    expect(r2.body.events).toHaveLength(3);
    expect(r2.body.next_since).toBeGreaterThan(cursor1);
  });

  it('overlap guard: parallel tickOnce calls serialize, do not double-emit', async () => {
    // Fire two tickOnce calls without awaiting between them.
    const [a, b] = await Promise.all([client.tickOnce(), client.tickOnce()]);
    // Both reports describe a single tick worth of work; together they
    // should produce exactly the 6 events two sequential ticks produce.
    const inserted = a.outcomes[0].events_inserted + b.outcomes[0].events_inserted;
    expect(inserted).toBe(6);
    const events = await client.request<{ events: { id: string }[] }>({
      path: `/v1/events?subscription_id=${subId}`,
    });
    expect(events.body.events.map((e) => e.id)).toEqual([
      'mock-1',
      'mock-2',
      'mock-3',
      'mock-4',
      'mock-5',
      'mock-6',
    ]);
  });

  it('drops an unparseable cursor and lets the connector start fresh', async () => {
    // Stuff a junk cursor into the row. Next tick should still succeed
    // and overwrite the cursor with a valid one.
    client.db
      .prepare('UPDATE subscriptions SET cursor = ? WHERE id = ?')
      .run('not-json{{{', subId);
    const report = await client.tickOnce();
    expect(report.outcomes[0].status).toBe('ok');
    expect(report.outcomes[0].events_inserted).toBe(3);
    const row = client.db
      .prepare('SELECT cursor FROM subscriptions WHERE id = ?')
      .get(subId) as { cursor: string };
    expect(JSON.parse(row.cursor)).toEqual({ count: 3 });
  });
});
