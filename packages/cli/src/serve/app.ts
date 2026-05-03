import { Hono } from 'hono';
import { health } from './routes/health.js';
import { bearerAuth } from './middleware/auth.js';
import { credentialsRoute } from './routes/credentials.js';
import { eventsRoute } from './routes/events.js';
import { subscriptionsRoute } from './routes/subscriptions.js';
import type { ConnectorRegistry } from './connectors/registry.js';
import type { Database } from './db.js';
import type { Vault } from './vault/index.js';

/**
 * Builds the Hono app. Exported as a function so tests can construct an
 * isolated app per test file with a `:memory:` DB handle.
 *
 * Health is mounted ahead of auth (load-balancer probes don't carry tokens).
 * Everything else requires a valid bearer token.
 */
export function createApp(deps: {
  db: Database;
  vault: Vault;
  registry: ConnectorRegistry;
}): Hono {
  const app = new Hono();

  app.route('/', health);

  // Pre-auth 410 for known-retired 0.1.x routes. Upgraders running their
  // old CLI against a 0.3.x server need to see the migration body without
  // configuring a token first; gating it behind auth would turn an
  // already-broken-CLI scenario into a confusing one. The retired paths
  // are public knowledge from 0.1.x — there's no shape to leak.
  const cortexGone = (c: import('hono').Context) =>
    c.json(
      {
        error: 'cortex storage retired',
        detail:
          'open-think-server 0.2.0 retired the cortex storage role; CLIs still calling ' +
          'these routes should pin to open-think-server@0.1.x or migrate to the local-fs ' +
          'cortex (see https://github.com/OpenThinkAi/think-cli/blob/main/packages/cli/docs/serve.md).',
      },
      410,
    );
  // Both forms: bare `/v1/cortexes` (the 0.1.x list endpoint) and any
  // sub-path. Hono's `/*` matches one-or-more segments past the parent,
  // so the bare path needs its own registration.
  app.all('/v1/cortexes', cortexGone);
  app.all('/v1/cortexes/*', cortexGone);

  const authed = new Hono();
  authed.use('*', bearerAuth());
  authed.route('/', eventsRoute(deps.db));
  authed.route('/', subscriptionsRoute(deps.db));
  authed.route('/', credentialsRoute(deps.db, deps.vault, deps.registry));
  app.route('/', authed);

  app.notFound((c) =>
    c.json(
      {
        error: 'endpoint not found',
        detail:
          'open-think serve v0.5.0 serves /v1/health, /v1/events, /v1/subscriptions, ' +
          'and /v1/subscriptions/:id/credential.',
      },
      404,
    ),
  );

  app.onError((err, c) => {
    console.error('[open-think serve]', err);
    return c.json({ error: 'internal error' }, 500);
  });

  return app;
}
