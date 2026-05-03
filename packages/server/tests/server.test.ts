import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { bearerAuth } from '../src/middleware/auth.js';
import { health } from '../src/routes/health.js';
import { TEST_TOKEN, request } from './fixtures/app-client.js';

/**
 * The cortex storage routes retired in AGT-026; the server briefly serves
 * only /v1/health until AGT-027 lands the events/subscriptions surface. The
 * bearer-auth seam stays mounted in the production app so AGT-027 plugs into
 * it without re-discovery — but with no production routes behind it, the
 * tests below stand up a dummy authed app to keep the auth contract under
 * test.
 */

function buildAuthProbeApp(): Hono {
  const app = new Hono();
  app.route('/', health);
  const authed = new Hono();
  authed.use('*', bearerAuth());
  authed.get('/v1/__authed', (c) => c.json({ ok: true }));
  app.route('/', authed);
  return app;
}

async function probe(opts: { path: string; token?: string | null }): Promise<{ status: number; body: { ok?: boolean; status?: string; error?: string } }> {
  const app = buildAuthProbeApp();
  const headers: Record<string, string> = {};
  const token = opts.token === undefined ? TEST_TOKEN : opts.token;
  if (token !== null) headers['Authorization'] = `Bearer ${token}`;
  const res = await app.fetch(new Request(`http://test.local${opts.path}`, { headers }));
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  return { status: res.status, body };
}

describe('open-think-server', () => {
  describe('health', () => {
    it('responds 200 with status=ok and is unauthenticated', async () => {
      const r = await request<{ status: string }>({ path: '/v1/health', token: null });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('ok');
    });
  });

  describe('auth middleware', () => {
    it('rejects requests with no Authorization header', async () => {
      const r = await probe({ path: '/v1/__authed', token: null });
      expect(r.status).toBe(401);
      expect(r.body.error).toBe('missing bearer token');
    });

    it('rejects requests with the wrong token', async () => {
      const r = await probe({ path: '/v1/__authed', token: 'nope' });
      expect(r.status).toBe(401);
      expect(r.body.error).toBe('invalid token');
    });

    it('rejects same-length wrong tokens (constant-time path)', async () => {
      const wrong = 'x'.repeat(TEST_TOKEN.length);
      const r = await probe({ path: '/v1/__authed', token: wrong });
      expect(r.status).toBe(401);
      expect(r.body.error).toBe('invalid token');
    });

    it('accepts requests with the correct token', async () => {
      const r = await probe({ path: '/v1/__authed' });
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
    });
  });
});
