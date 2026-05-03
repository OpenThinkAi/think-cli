import { Hono } from 'hono';
import { health } from './routes/health.js';

/**
 * Builds the Hono app. Exported as a function so tests can construct an
 * isolated app per test file without binding to a port.
 *
 * The cortex storage role retired in AGT-026; the bearer-auth middleware
 * went with it. AGT-027 will plug events/subscriptions routes in here and
 * re-mount auth at the same time — a four-line round-trip rather than the
 * silent-401-on-retired-endpoints UX a preserved-but-routeless auth seam
 * created.
 */
export function createApp(): Hono {
  const app = new Hono();

  app.route('/', health);

  // Operators upgrading from 0.1.x will hit this catch-all when their CLI
  // still targets the retired cortex routes. Generic Hono 404s say nothing
  // about why the endpoint vanished; this body names the cause and the path
  // forward so an outage doesn't require a README read to diagnose.
  app.notFound((c) => c.json(
    {
      error: 'endpoint not found',
      detail:
        'open-think-server 0.2.0 retired the cortex storage role (AGT-026); ' +
        'only GET /v1/health is served until AGT-027 lands the proxy role. ' +
        'If you are on the CLI side, pin to open-think-server@0.1.x and run ' +
        '`think cortex migrate --to fs --path <folder>` to move to a local-fs cortex ' +
        '(see https://github.com/OpenThinkAi/think-cli/blob/main/packages/server/README.md).',
    },
    404,
  ));

  app.onError((err, c) => {
    console.error('[open-think-server]', err);
    return c.json({ error: 'internal error' }, 500);
  });

  return app;
}
