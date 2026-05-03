import { describe, it, expect } from 'vitest';
import { request } from './fixtures/app-client.js';

/**
 * The cortex storage routes retired in AGT-026; the bearer-auth middleware
 * went with them. AGT-027 will land both back together (events +
 * subscriptions surface gated by auth). Until then the server serves
 * /v1/health and a catch-all 404 with a migration-pointer body.
 */

describe('open-think-server', () => {
  describe('health', () => {
    it('responds 200 with status=ok and version', async () => {
      const r = await request<{ status: string; version: string }>({ path: '/v1/health' });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('ok');
      // Lets curious operators distinguish 0.1.x (DB-reachable) from 0.2.x
      // (process-reachable only) without consulting the registry.
      expect(r.body.version).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  describe('retired-endpoint 404', () => {
    it('returns a JSON body naming the retired role and the migration path', async () => {
      const r = await request<{ error: string; detail: string }>({
        path: '/v1/cortexes/anything/memories',
      });
      expect(r.status).toBe(404);
      expect(r.body.error).toBe('endpoint not found');
      expect(r.body.detail).toMatch(/AGT-026/);
      expect(r.body.detail).toMatch(/think cortex migrate/);
    });

    it('applies to POSTs against retired routes too', async () => {
      const r = await request<{ error: string; detail: string }>({
        method: 'POST',
        path: '/v1/cortexes/anything/long-term-events',
        body: { events: [] },
      });
      expect(r.status).toBe(404);
      expect(r.body.error).toBe('endpoint not found');
      expect(r.body.detail).toMatch(/AGT-026/);
    });
  });
});
