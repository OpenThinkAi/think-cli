import { Hono } from 'hono';
import { health } from './routes/health.js';
import { bearerAuth } from './middleware/auth.js';
import { eventsRoute } from './routes/events.js';
import { subscriptionsRoute } from './routes/subscriptions.js';
import type { Database } from './db.js';

/**
 * Builds the Hono app. Exported as a function so tests can construct an
 * isolated app per test file with a `:memory:` DB handle.
 *
 * Health is mounted ahead of auth (load-balancer probes don't carry tokens).
 * Everything else requires a valid bearer token.
 */
export function createApp(deps: { db: Database }): Hono {
  const app = new Hono();

  app.route('/', health);

  const authed = new Hono();
  authed.use('*', bearerAuth());
  authed.route('/', eventsRoute(deps.db));
  authed.route('/', subscriptionsRoute(deps.db));
  app.route('/', authed);

  // Operators upgrading from 0.1.x or 0.2.x will hit this catch-all if their
  // CLI still targets retired cortex routes. Naming the served paths plus
  // the version is enough to diagnose without a README read.
  app.notFound((c) =>
    c.json(
      {
        error: 'endpoint not found',
        detail:
          'open-think-server 0.3.0 serves /v1/health, /v1/events, and /v1/subscriptions. ' +
          'The cortex storage routes retired in 0.2.0 (AGT-026); CLIs still calling them ' +
          'should pin to open-think-server@0.1.x or migrate to the local-fs cortex (see README).',
      },
      404,
    ),
  );

  app.onError((err, c) => {
    console.error('[open-think-server]', err);
    return c.json({ error: 'internal error' }, 500);
  });

  return app;
}
