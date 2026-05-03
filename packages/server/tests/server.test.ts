import { describe, it, expect, beforeEach } from 'vitest';
import { createTestClient, type TestClient } from './fixtures/app-client.js';

/**
 * Health, catch-all 404 body, and the bearer-auth contract.
 * Per-route behaviour lives in events.test.ts / subscriptions.test.ts.
 */

let client: TestClient;

beforeEach(() => {
  client = createTestClient();
});

describe('open-think-server', () => {
  describe('health', () => {
    it('responds 200 with status=ok and version', async () => {
      const r = await client.request<{ status: string; version: string }>({
        path: '/v1/health',
        token: null,
      });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('ok');
      expect(r.body.version).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('is unauthenticated (load balancer probes carry no token)', async () => {
      const r = await client.request<{ status: string }>({ path: '/v1/health', token: null });
      expect(r.status).toBe(200);
    });
  });

  describe('retired cortex routes (410 Gone)', () => {
    it('GET /v1/cortexes/* returns 410 with the migration body, no auth required', async () => {
      const r = await client.request<{ error: string; detail: string }>({
        path: '/v1/cortexes/anything/memories',
        token: null,
      });
      expect(r.status).toBe(410);
      expect(r.body.error).toBe('cortex storage retired');
      expect(r.body.detail).toMatch(/open-think-server@0\.1\.x/);
      expect(r.body.detail).toMatch(/local-fs cortex/);
    });

    it('POST /v1/cortexes/* also 410, also unauth', async () => {
      const r = await client.request({
        method: 'POST',
        path: '/v1/cortexes/anything/long-term-events',
        body: { events: [] },
        token: null,
      });
      expect(r.status).toBe(410);
    });
  });

  describe('catch-all 404', () => {
    it('returns a JSON body listing the served endpoints', async () => {
      const r = await client.request<{ error: string; detail: string }>({
        path: '/v1/something-completely-unknown',
      });
      expect(r.status).toBe(404);
      expect(r.body.error).toBe('endpoint not found');
      expect(r.body.detail).toMatch(/0\.3\.0/);
      expect(r.body.detail).toMatch(/\/v1\/health/);
      expect(r.body.detail).toMatch(/\/v1\/events/);
      expect(r.body.detail).toMatch(/\/v1\/subscriptions/);
    });

    it('unauthed unknown paths 401 before the catch-all (auth gates first)', async () => {
      // Locked behaviour: for non-retired unknown paths, the catch-all 404
      // is reachable only by authed callers; unauthed get a diagnostic 401.
      // Retired /v1/cortexes/* paths bypass auth and 410 — the upgrade UX
      // path is documented in the test above.
      const r = await client.request({
        path: '/v1/something-completely-unknown',
        token: null,
      });
      expect(r.status).toBe(401);
    });
  });

  describe('auth', () => {
    it('rejects authed routes with no Authorization header', async () => {
      const r = await client.request({ path: '/v1/subscriptions', token: null });
      expect(r.status).toBe(401);
    });

    it('rejects authed routes with the wrong token', async () => {
      const r = await client.request({ path: '/v1/subscriptions', token: 'nope' });
      expect(r.status).toBe(401);
    });

    it('accepts authed routes with the correct token', async () => {
      const r = await client.request<{ subscriptions: unknown[] }>({ path: '/v1/subscriptions' });
      expect(r.status).toBe(200);
      expect(r.body.subscriptions).toEqual([]);
    });

    it('Bearer scheme name is case-insensitive (RFC 7235 §2.1)', async () => {
      // The fixture always emits "Bearer ", so hit createApp directly to
      // vary the scheme casing.
      const { createApp } = await import('../src/app.js');
      const { openDb } = await import('../src/db.js');
      const app = createApp({ db: openDb(':memory:') });
      for (const scheme of ['bearer', 'BEARER', 'bEaReR']) {
        const res = await app.fetch(
          new Request('http://test.local/v1/subscriptions', {
            headers: { Authorization: `${scheme} ${process.env.THINK_TOKEN}` },
          }),
        );
        expect(res.status, `scheme=${scheme}`).toBe(200);
      }
    });
  });
});
