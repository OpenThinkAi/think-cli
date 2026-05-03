import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestClient, type TestClient } from './fixtures/app-client.js';

let client: TestClient;
let subA: string;
let subB: string;

beforeEach(async () => {
  client = createTestClient();
  const a = await client.request<{ subscription: { id: string } }>({
    method: 'POST',
    path: '/v1/subscriptions',
    body: { kind: 'github', pattern: 'org/repo-a' },
  });
  subA = a.body.subscription.id;
  const b = await client.request<{ subscription: { id: string } }>({
    method: 'POST',
    path: '/v1/subscriptions',
    body: { kind: 'github', pattern: 'org/repo-b' },
  });
  subB = b.body.subscription.id;
});

function seedEvent(sub: string, payload: object): void {
  client.db
    .prepare(
      'INSERT INTO events (id, subscription_id, payload_json, created_at) VALUES (?, ?, ?, ?)',
    )
    .run(randomUUID(), sub, JSON.stringify(payload), new Date().toISOString());
}

describe('GET /v1/events', () => {
  it('400 when subscription_id query param is missing', async () => {
    const r = await client.request({ path: '/v1/events?since=0' });
    expect(r.status).toBe(400);
  });

  it('404 when the named subscription_id does not exist', async () => {
    const r = await client.request({ path: '/v1/events?subscription_id=does-not-exist' });
    expect(r.status).toBe(404);
  });

  it('returns events scoped to the named subscription', async () => {
    seedEvent(subA, { msg: 'a1' });
    seedEvent(subB, { msg: 'b1' });
    seedEvent(subA, { msg: 'a2' });
    const r = await client.request<{ events: { payload: { msg: string } }[] }>({
      path: `/v1/events?subscription_id=${subA}`,
    });
    expect(r.status).toBe(200);
    expect(r.body.events).toHaveLength(2);
    expect(r.body.events.map((e) => e.payload.msg)).toEqual(['a1', 'a2']);
  });

  it('paginates via the since cursor', async () => {
    for (let i = 0; i < 5; i++) seedEvent(subA, { i });
    const r1 = await client.request<{
      events: { server_seq: number }[];
      next_since: number | null;
    }>({ path: `/v1/events?subscription_id=${subA}&limit=2` });
    expect(r1.body.events).toHaveLength(2);
    expect(r1.body.next_since).toBe(r1.body.events[1].server_seq);

    const r2 = await client.request<{
      events: { server_seq: number }[];
      next_since: number | null;
    }>({ path: `/v1/events?subscription_id=${subA}&since=${r1.body.next_since}&limit=2` });
    expect(r2.body.events).toHaveLength(2);
    expect(r2.body.events[0].server_seq).toBeGreaterThan(r1.body.next_since!);
  });

  it('next_since is null on an empty page', async () => {
    const r = await client.request<{ events: unknown[]; next_since: number | null }>({
      path: `/v1/events?subscription_id=${subA}&since=999`,
    });
    expect(r.body.events).toHaveLength(0);
    expect(r.body.next_since).toBeNull();
  });

  it('updates last_polled_at on read', async () => {
    const before = client.db
      .prepare('SELECT last_polled_at FROM subscriptions WHERE id = ?')
      .get(subA) as { last_polled_at: string | null };
    expect(before.last_polled_at).toBeNull();

    await client.request({ path: `/v1/events?subscription_id=${subA}` });
    const after = client.db
      .prepare('SELECT last_polled_at FROM subscriptions WHERE id = ?')
      .get(subA) as { last_polled_at: string | null };
    expect(after.last_polled_at).not.toBeNull();
  });

  it('400 when limit exceeds the hard cap of 1000', async () => {
    const r = await client.request({ path: `/v1/events?subscription_id=${subA}&limit=10000` });
    expect(r.status).toBe(400);
  });
});
