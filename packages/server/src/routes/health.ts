import { Hono } from 'hono';
import { VERSION } from '../version.js';

export const health = new Hono();

health.get('/v1/health', (c) => {
  // Liveness only: process is up and serving. No backing-store probe — the
  // cortex storage role retired in AGT-026 and there's nothing for this
  // endpoint to introspect until the proxy role lands. The `version` field
  // lets curious operators distinguish 0.1.x (DB-reachable) from 0.2.x
  // (process-reachable only) without consulting the registry.
  return c.json({ status: 'ok', version: VERSION });
});
