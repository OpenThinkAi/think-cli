import { describe, it, expect } from 'vitest';
import { request } from './fixtures/app-client.js';

/**
 * Health, catch-all 404 body, and the bearer-auth contract.
 * Per-route behaviour lives in events.test.ts / subscriptions.test.ts.
 */

describe('open-think-server', () => {
  describe('health', () => {
    it('responds 200 with status=ok and version', async () => {
      const r = await request<{ status: string; version: string }>({
        path: '/v1/health',
        token: null,
      });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('ok');
      expect(r.body.version).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('is unauthenticated (load balancer probes carry no token)', async () => {
      const r = await request<{ status: string }>({ path: '/v1/health', token: null });
      expect(r.status).toBe(200);
    });
  });

  describe('catch-all 404', () => {
    it('returns a JSON body listing the served endpoints', async () => {
      const r = await request<{ error: string; detail: string }>({
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
      const r = await request<{ error: string; detail: string }>({
        method: 'POST',
        path: '/v1/cortexes/anything/long-term-events',
        body: { events: [] },
      });
      expect(r.status).toBe(404);
      expect(r.body.error).toBe('endpoint not found');
    });
  });

  describe('auth', () => {
    it('rejects authed routes with no Authorization header', async () => {
      const r = await request({ path: '/v1/subscriptions', token: null });
      expect(r.status).toBe(401);
    });

    it('rejects authed routes with the wrong token', async () => {
      const r = await request({ path: '/v1/subscriptions', token: 'nope' });
      expect(r.status).toBe(401);
    });

    it('accepts authed routes with the correct token', async () => {
      const r = await request<{ subscriptions: unknown[] }>({ path: '/v1/subscriptions' });
      expect(r.status).toBe(200);
      expect(r.body.subscriptions).toEqual([]);
    });
  });
});
