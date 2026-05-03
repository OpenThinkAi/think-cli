import { Hono } from 'hono';

export const health = new Hono();

health.get('/v1/health', (c) => {
  // Liveness only: process is up and serving. No backing-store probe — the
  // cortex storage role retired in AGT-026 and there's nothing for this
  // endpoint to introspect until the proxy role lands.
  return c.json({ status: 'ok' });
});
