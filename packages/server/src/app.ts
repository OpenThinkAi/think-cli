import { Hono } from 'hono';
import { health } from './routes/health.js';
import { bearerAuth } from './middleware/auth.js';

/**
 * Builds the Hono app. Exported as a function so tests can construct an
 * isolated app per test file without binding to a port.
 *
 * Health is mounted ahead of auth (load balancers must reach it without
 * credentials). The bearer-auth seam is mounted with no authed routes — the
 * cortex storage role retired in AGT-026 and the proxy role (AGT-027) plugs
 * its routes in here.
 */
export function createApp(): Hono {
  const app = new Hono();

  app.route('/', health);

  const authed = new Hono();
  authed.use('*', bearerAuth());

  app.route('/', authed);

  app.onError((err, c) => {
    console.error('[open-think-server]', err);
    return c.json({ error: 'internal error' }, 500);
  });

  return app;
}
