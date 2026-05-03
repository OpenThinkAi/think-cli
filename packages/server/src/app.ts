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

  // Pre-auth 410 for known-retired 0.1.x routes. Upgraders running their
  // old CLI against a 0.3.x server need to see the migration body without
  // configuring a token first; gating it behind auth would turn an
  // already-broken-CLI scenario into a confusing one. The retired paths
  // are public knowledge from 0.1.x — there's no shape to leak.
  app.all('/v1/cortexes/*', (c) =>
    c.json(
      {
        error: 'cortex storage retired',
        detail:
          'open-think-server 0.2.0 retired the cortex storage role; CLIs still calling ' +
          'these routes should pin to open-think-server@0.1.x or migrate to the local-fs ' +
          'cortex (see https://github.com/OpenThinkAi/think-cli/blob/main/packages/server/README.md).',
      },
      410,
    ),
  );

  const authed = new Hono();
  authed.use('*', bearerAuth());
  authed.route('/', eventsRoute(deps.db));
  authed.route('/', subscriptionsRoute(deps.db));
  app.route('/', authed);

  app.notFound((c) =>
    c.json(
      {
        error: 'endpoint not found',
        detail:
          'open-think-server 0.3.0 serves /v1/health, /v1/events, and /v1/subscriptions.',
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
