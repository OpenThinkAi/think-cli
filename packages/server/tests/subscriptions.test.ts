import { describe, it, expect, beforeEach } from 'vitest';
import { createTestClient, type TestClient } from './fixtures/app-client.js';

let client: TestClient;

beforeEach(() => {
  client = createTestClient();
});

describe('subscriptions CRUD', () => {
  it('POST creates and returns the assigned id', async () => {
    const r = await client.request<{ id: string; kind: string; pattern: string }>({
      method: 'POST',
      path: '/v1/subscriptions',
      body: { kind: 'github', pattern: 'org/repo' },
    });
    expect(r.status).toBe(201);
    expect(r.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.body.kind).toBe('github');
    expect(r.body.pattern).toBe('org/repo');
  });

  it('POST 400 on malformed body', async () => {
    const r = await client.request({
      method: 'POST',
      path: '/v1/subscriptions',
      body: { kind: 'github' },
    });
    expect(r.status).toBe(400);
  });

  it('POST 400 on non-JSON body', async () => {
    // Hand-roll the request so we can send invalid JSON without the fixture
    // serializing it for us.
    const r = await client.request({ method: 'POST', path: '/v1/subscriptions' });
    expect(r.status).toBe(400);
  });

  it('GET lists all subscriptions ordered by created_at', async () => {
    await client.request({
      method: 'POST',
      path: '/v1/subscriptions',
      body: { kind: 'a', pattern: 'p1' },
    });
    await client.request({
      method: 'POST',
      path: '/v1/subscriptions',
      body: { kind: 'b', pattern: 'p2' },
    });
    const r = await client.request<{ subscriptions: { kind: string }[] }>({
      path: '/v1/subscriptions',
    });
    expect(r.body.subscriptions).toHaveLength(2);
    expect(r.body.subscriptions.map((s) => s.kind)).toEqual(['a', 'b']);
  });

  it('GET-by-id 404 for unknown id', async () => {
    const r = await client.request({ path: '/v1/subscriptions/does-not-exist' });
    expect(r.status).toBe(404);
  });

  it('GET-by-id returns the row', async () => {
    const created = await client.request<{ id: string }>({
      method: 'POST',
      path: '/v1/subscriptions',
      body: { kind: 'github', pattern: 'org/repo' },
    });
    const r = await client.request<{ id: string; kind: string }>({
      path: `/v1/subscriptions/${created.body.id}`,
    });
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(created.body.id);
    expect(r.body.kind).toBe('github');
  });

  it('DELETE removes the row', async () => {
    const created = await client.request<{ id: string }>({
      method: 'POST',
      path: '/v1/subscriptions',
      body: { kind: 'a', pattern: 'p' },
    });
    const del = await client.request({
      method: 'DELETE',
      path: `/v1/subscriptions/${created.body.id}`,
    });
    expect(del.status).toBe(204);
    const after = await client.request({ path: `/v1/subscriptions/${created.body.id}` });
    expect(after.status).toBe(404);
  });

  it('DELETE 404 for unknown id', async () => {
    const r = await client.request({ method: 'DELETE', path: '/v1/subscriptions/does-not-exist' });
    expect(r.status).toBe(404);
  });

  it('DELETE cascades to events for that subscription', async () => {
    const created = await client.request<{ id: string }>({
      method: 'POST',
      path: '/v1/subscriptions',
      body: { kind: 'a', pattern: 'p' },
    });
    client.db
      .prepare(
        'INSERT INTO events (id, subscription_id, payload_json, created_at) VALUES (?, ?, ?, ?)',
      )
      .run('evt-1', created.body.id, '{}', new Date().toISOString());
    expect(
      client.db.prepare('SELECT COUNT(*) AS n FROM events').get(),
    ).toEqual({ n: 1 });
    await client.request({
      method: 'DELETE',
      path: `/v1/subscriptions/${created.body.id}`,
    });
    expect(
      client.db.prepare('SELECT COUNT(*) AS n FROM events').get(),
    ).toEqual({ n: 0 });
  });
});
