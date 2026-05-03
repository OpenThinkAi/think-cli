import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestClient, type TestClient } from './fixtures/app-client.js';

/**
 * AGT-029 AC #3 — route audit. Stores a credential with a known unique
 * marker, then drives every read-shaped endpoint and asserts the marker
 * never appears in any response body. Also asserts that no GET route
 * exists for the credential resource (by construction — the only routes
 * registered are PUT and POST .../test, never GET).
 *
 * This is a defensive net rather than a positive contract: the code is
 * structured so the leak would have to be an active mistake. The audit
 * makes the mistake immediately visible in CI.
 */

const PLAINTEXT_MARKER = `super-secret-token-${randomUUID()}`;

let client: TestClient;
let subId: string;

beforeEach(async () => {
  client = createTestClient();
  const r = await client.request<{ subscription: { id: string } }>({
    method: 'POST',
    path: '/v1/subscriptions',
    body: { kind: 'mock', pattern: '1' },
  });
  subId = r.body.subscription.id;
  // Plant the credential via the public route so we exercise the same
  // path real callers use.
  await client.request({
    method: 'PUT',
    path: `/v1/subscriptions/${subId}/credential`,
    body: { credential: PLAINTEXT_MARKER },
  });
});

async function bodyText(opts: { method?: string; path: string; body?: unknown }): Promise<string> {
  const r = await client.request<unknown>({
    method: opts.method ?? 'GET',
    path: opts.path,
    body: opts.body,
  });
  // Stringify so structured responses are searchable.
  return JSON.stringify(r.body ?? '');
}

describe('credential leak audit (AGT-029 AC #3)', () => {
  it('no read endpoint returns the plaintext credential', async () => {
    const probes: { method?: string; path: string; body?: unknown }[] = [
      { path: '/v1/health' },
      { path: '/v1/subscriptions' },
      { path: `/v1/subscriptions/${subId}` },
      { path: `/v1/events?subscription_id=${subId}` },
      { path: '/v1/something-unknown' },
      { path: `/v1/subscriptions/${subId}/credential` }, // GET is intentionally not registered
      { path: `/v1/subscriptions/${subId}/credential/test`, method: 'POST' },
    ];
    for (const probe of probes) {
      const text = await bodyText(probe);
      expect(text, `probe ${probe.method ?? 'GET'} ${probe.path}`).not.toContain(PLAINTEXT_MARKER);
    }
  });

  it('responses do not surface raw ciphertext or nonce field names', async () => {
    const probes = [
      `/v1/subscriptions`,
      `/v1/subscriptions/${subId}`,
      `/v1/events?subscription_id=${subId}`,
    ];
    for (const path of probes) {
      const text = await bodyText({ path });
      expect(text, `path ${path}`).not.toMatch(/"ciphertext"/);
      expect(text, `path ${path}`).not.toMatch(/"nonce"/);
      // The credential field name is allowed in error responses (as a
      // zod-issue path), but it must not appear with a value attached
      // in any 2xx body.
    }
  });

  it('no GET route exists for /v1/subscriptions/:id/credential — auth-or-404, never 200', async () => {
    const r = await client.request({ path: `/v1/subscriptions/${subId}/credential` });
    expect(r.status).not.toBe(200);
    // Hono's 404-after-auth path returns the catch-all body (or 404 with
    // method-not-allowed semantics). Either way: NOT a successful read.
    expect([404, 405]).toContain(r.status);
  });

  it('test endpoint returns ok=true without echoing the credential', async () => {
    const r = await client.request<{ ok: boolean; detail?: string }>({
      method: 'POST',
      path: `/v1/subscriptions/${subId}/credential/test`,
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain(PLAINTEXT_MARKER);
  });
});
