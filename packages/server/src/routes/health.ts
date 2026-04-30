import { Hono } from 'hono';
import { getPool } from '../db/pool.js';

export const health = new Hono();

health.get('/v1/health', async (c) => {
  // Liveness only: confirm we can reach Postgres. Doesn't introspect schema —
  // schema correctness is the deploy's responsibility, and this endpoint
  // gets called by load balancers on every health check.
  try {
    await getPool().query('SELECT 1');
    return c.json({ status: 'ok' });
  } catch (err) {
    // Don't leak Postgres error detail (which can include hostnames, role
    // names, connection-string fragments) on an unauthenticated endpoint.
    // Log server-side; clients only need the status code + status string.
    console.error('[open-think-server] health check failed:', err);
    return c.json({ status: 'error' }, 503);
  }
});
