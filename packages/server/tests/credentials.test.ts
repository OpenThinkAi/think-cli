import { describe, it, expect, beforeEach } from 'vitest';
import { createTestClient, type TestClient } from './fixtures/app-client.js';
import {
  buildDefaultRegistry,
  registerConnector,
} from '../src/connectors/registry.js';
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

describe('PUT /v1/subscriptions/:id/credential', () => {
  beforeEach(async () => {
    client = createTestClient();
    subId = await createSub(client, { kind: 'mock', pattern: '1' });
  });

  it('204 on first store', async () => {
    const r = await client.request({
      method: 'PUT',
      path: `/v1/subscriptions/${subId}/credential`,
      body: { credential: 'first-token' },
    });
    expect(r.status).toBe(204);
    const count = client.db
      .prepare('SELECT COUNT(*) AS n FROM source_credentials WHERE subscription_id = ?')
      .get(subId) as { n: number };
    expect(count.n).toBe(1);
  });

  it('204 on second store; upserts (still one row, latest credential wins)', async () => {
    await client.request({
      method: 'PUT',
      path: `/v1/subscriptions/${subId}/credential`,
      body: { credential: 'first-token' },
    });
    const r = await client.request({
      method: 'PUT',
      path: `/v1/subscriptions/${subId}/credential`,
      body: { credential: 'second-token' },
    });
    expect(r.status).toBe(204);
    const rows = client.db
      .prepare('SELECT subscription_id FROM source_credentials WHERE subscription_id = ?')
      .all(subId);
    expect(rows).toHaveLength(1);
    // Confirm vault round-trip yields the second value.
    expect(client.vault.load(client.db, subId)).toBe('second-token');
  });

  it('400 on missing body', async () => {
    const r = await client.request({
      method: 'PUT',
      path: `/v1/subscriptions/${subId}/credential`,
    });
    expect(r.status).toBe(400);
  });

  it('400 on empty credential', async () => {
    const r = await client.request({
      method: 'PUT',
      path: `/v1/subscriptions/${subId}/credential`,
      body: { credential: '' },
    });
    expect(r.status).toBe(400);
  });

  it('400 on missing credential field', async () => {
    const r = await client.request({
      method: 'PUT',
      path: `/v1/subscriptions/${subId}/credential`,
      body: {},
    });
    expect(r.status).toBe(400);
  });

  it('404 when subscription does not exist', async () => {
    const r = await client.request({
      method: 'PUT',
      path: '/v1/subscriptions/no-such-sub/credential',
      body: { credential: 'x' },
    });
    expect(r.status).toBe(404);
  });

  it('cascades: deleting the subscription removes the stored credential', async () => {
    await client.request({
      method: 'PUT',
      path: `/v1/subscriptions/${subId}/credential`,
      body: { credential: 'will-be-cascaded' },
    });
    expect(client.vault.has(client.db, subId)).toBe(true);
    await client.request({ method: 'DELETE', path: `/v1/subscriptions/${subId}` });
    expect(client.vault.has(client.db, subId)).toBe(false);
  });

  it('requires bearer auth', async () => {
    const r = await client.request({
      method: 'PUT',
      path: `/v1/subscriptions/${subId}/credential`,
      body: { credential: 'x' },
      token: null,
    });
    expect(r.status).toBe(401);
  });
});

describe('POST /v1/subscriptions/:id/credential/test', () => {
  beforeEach(async () => {
    client = createTestClient();
    subId = await createSub(client, { kind: 'mock', pattern: '1' });
  });

  it('200 ok=true when mock has a non-empty stored credential', async () => {
    await client.request({
      method: 'PUT',
      path: `/v1/subscriptions/${subId}/credential`,
      body: { credential: 'non-empty-token' },
    });
    const r = await client.request<{ ok: boolean; detail?: string }>({
      method: 'POST',
      path: `/v1/subscriptions/${subId}/credential/test`,
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it('200 ok=false when stored credential is empty (planted directly via vault to bypass PUT validation)', async () => {
    // PUT rejects '' so we plant via the vault directly to exercise the
    // mock connector's empty-input branch.
    client.vault.store(client.db, subId, '');
    // Verify the round-trip via vault works (empty string is allowed at
    // the vault layer; only the route rejects it).
    expect(client.vault.load(client.db, subId)).toBe('');

    const r = await client.request<{ ok: boolean; detail?: string }>({
      method: 'POST',
      path: `/v1/subscriptions/${subId}/credential/test`,
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(r.body.detail).toMatch(/non-empty/);
  });

  it('404 when no credential stored for the subscription (the credential resource is the missing thing)', async () => {
    const r = await client.request<{ error: string }>({
      method: 'POST',
      path: `/v1/subscriptions/${subId}/credential/test`,
    });
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/no credential/);
  });

  it('404 when subscription does not exist', async () => {
    const r = await client.request({
      method: 'POST',
      path: '/v1/subscriptions/no-such-sub/credential/test',
    });
    expect(r.status).toBe(404);
  });

  it('501 when the connector has no verifyCredential method', async () => {
    const noverify: SourceConnector = {
      kind: 'noverify',
      async poll() {
        return { events: [], nextCursor: null };
      },
      // intentionally no verifyCredential
    };
    const registry = buildDefaultRegistry();
    registerConnector(registry, noverify);
    client = createTestClient({ registry });
    const sub = await createSub(client, { kind: 'noverify', pattern: 'x' });

    await client.request({
      method: 'PUT',
      path: `/v1/subscriptions/${sub}/credential`,
      body: { credential: 'whatever' },
    });
    const r = await client.request<{ error: string }>({
      method: 'POST',
      path: `/v1/subscriptions/${sub}/credential/test`,
    });
    expect(r.status).toBe(501);
    expect(r.body.error).toMatch(/verify not implemented/);
  });

  it('catches connector throws and maps to ok=false without leaking the credential', async () => {
    const PLAINTEXT = 'super-secret-token-zzz';
    const exploding: SourceConnector = {
      kind: 'explode',
      async poll() {
        return { events: [], nextCursor: null };
      },
      async verifyCredential() {
        // Realistic shape — connector fails for an internal reason.
        throw new Error('underlying verify call failed');
      },
    };
    const registry = buildDefaultRegistry();
    registerConnector(registry, exploding);
    client = createTestClient({ registry });
    const sub = await createSub(client, { kind: 'explode', pattern: 'x' });

    await client.request({
      method: 'PUT',
      path: `/v1/subscriptions/${sub}/credential`,
      body: { credential: PLAINTEXT },
    });
    const r = await client.request<{ ok: boolean; detail?: string }>({
      method: 'POST',
      path: `/v1/subscriptions/${sub}/credential/test`,
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(r.body.detail).toMatch(/verify failed/);
    expect(JSON.stringify(r.body)).not.toContain(PLAINTEXT);
  });

  it('requires bearer auth', async () => {
    const r = await client.request({
      method: 'POST',
      path: `/v1/subscriptions/${subId}/credential/test`,
      token: null,
    });
    expect(r.status).toBe(401);
  });
});
