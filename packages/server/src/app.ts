import { Hono } from 'hono';
import { health } from './routes/health.js';
import { cortex } from './routes/cortex.js';
import { memories } from './routes/memories.js';
import { bearerAuth } from './middleware/auth.js';

/**
 * Builds the Hono app. Exported as a function so tests can construct an
 * isolated app per test file without binding to a port.
 *
 * Health is mounted ahead of auth (load balancers must reach it without
 * credentials). Everything else requires a valid bearer token.
 */
export function createApp(): Hono {
  const app = new Hono();

  app.route('/', health);

  const authed = new Hono();
  authed.use('*', bearerAuth());
  authed.route('/', cortex);
  authed.route('/', memories);

  app.route('/', authed);

  app.onError((err, c) => {
    console.error('[open-think-server]', err);
    return c.json({ error: 'internal error' }, 500);
  });

  return app;
}
