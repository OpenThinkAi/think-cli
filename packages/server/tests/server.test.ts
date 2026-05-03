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

  describe('catch-all 404', () => {
    it('returns a JSON body listing the served endpoints (authed callers)', async () => {
      const r = await client.request<{ error: string; detail: string }>({
        path: '/v1/cortexes/anything/memories',
      });
      expect(r.status).toBe(404);
      expect(r.body.error).toBe('endpoint not found');
      expect(r.body.detail).toMatch(/0\.3\.0/);
      expect(r.body.detail).toMatch(/\/v1\/health/);
      expect(r.body.detail).toMatch(/\/v1\/events/);
      expect(r.body.detail).toMatch(/\/v1\/subscriptions/);
    });

    it('applies to POSTs against unknown routes too', async () => {
      const r = await client.request<{ error: string; detail: string }>({
        method: 'POST',
        path: '/v1/cortexes/anything/long-term-events',
        body: { events: [] },
      });
      expect(r.status).toBe(404);
      expect(r.body.error).toBe('endpoint not found');
    });

    it('unauthed unknown paths 401 before the catch-all (auth gates first)', async () => {
      // Locked behaviour: the catch-all 404 body is reachable only by
      // authed callers. Unauthed/wrong-token requests get the auth 401
      // first, which is itself diagnostic. Avoids leaking route shape to
      // unauthenticated clients.
      const r = await client.request({
        path: '/v1/cortexes/anything/memories',
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
  });
});
