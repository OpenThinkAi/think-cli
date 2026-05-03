import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

/**
 * Bearer-token auth. The single configured token in `THINK_TOKEN` must match
 * the `Authorization: Bearer <token>` header. Comparison is constant-time so
 * a token-of-the-right-length attacker can't time their way to the secret.
 *
 * Tokens are required for all routes mounted under this middleware. The
 * health endpoint is mounted before the middleware and is intentionally
 * unauthenticated so load-balancer probes work without credentials.
 */
export function bearerAuth(): MiddlewareHandler {
  // Boot in src/index.ts already exits if THINK_TOKEN is unset, so reading
  // it as required here is safe — the env var is a process-lifetime invariant.
  const expected = process.env.THINK_TOKEN!;
  const expectedBuf = Buffer.from(expected);

  return async (c, next) => {
    const header = c.req.header('Authorization');
    const presented = header?.startsWith('Bearer ') ? header.slice(7) : null;
    if (!presented) {
      return c.json({ error: 'missing bearer token' }, 401);
    }

    const presentedBuf = Buffer.from(presented);
    if (
      expectedBuf.length !== presentedBuf.length ||
      !timingSafeEqual(expectedBuf, presentedBuf)
    ) {
      return c.json({ error: 'invalid token' }, 401);
    }

    await next();
  };
}
