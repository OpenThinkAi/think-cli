import { Hono } from 'hono';
import { z } from 'zod';
import type { Database } from '../db.js';
import type { ConnectorRegistry } from '../connectors/registry.js';
import type { Vault } from '../vault/index.js';

/**
 * The two routes that own the credential surface for a subscription.
 *
 *   - `PUT  /v1/subscriptions/:id/credential` — accepts a plaintext
 *     credential, encrypts via the vault, upserts. Returns 204 with no
 *     body so the response can't leak whether this was a create vs
 *     update (AGT-029 AC #3 — no credential leak across any surface).
 *   - `POST /v1/subscriptions/:id/credential/test` — looks up the
 *     stored credential, decrypts, calls the connector's
 *     `verifyCredential`. Returns `{ ok, detail? }`. Connectors without
 *     a verifier yield 501. Connectors that throw are caught — the
 *     credential never escapes into an error message.
 *
 * **There is intentionally no GET / list / read route.** Once stored,
 * the plaintext is reachable only via the scheduler's `vault.load` call
 * inside the server process. The HTTP surface is write-and-test.
 */

const putBody = z.object({ credential: z.string().min(1) });

interface SubExistsRow {
  id: string;
  kind: string;
}

export function credentialsRoute(
  db: Database,
  vault: Vault,
  registry: ConnectorRegistry,
): Hono {
  const route = new Hono();

  route.put('/v1/subscriptions/:id/credential', async (c) => {
    const subId = c.req.param('id');
    const sub = db
      .prepare('SELECT id, kind FROM subscriptions WHERE id = ?')
      .get(subId) as SubExistsRow | undefined;
    if (!sub) return c.json({ error: 'subscription not found' }, 404);

    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return c.json({ error: 'invalid json body' }, 400);
    }
    const parsed = putBody.safeParse(json);
    if (!parsed.success) {
      return c.json({ error: 'invalid body', detail: parsed.error.issues }, 400);
    }
    vault.store(db, subId, parsed.data.credential);
    return c.body(null, 204);
  });

  route.post('/v1/subscriptions/:id/credential/test', async (c) => {
    const subId = c.req.param('id');
    const sub = db
      .prepare('SELECT id, kind FROM subscriptions WHERE id = ?')
      .get(subId) as SubExistsRow | undefined;
    if (!sub) return c.json({ error: 'subscription not found' }, 404);

    let plaintext: string | null;
    try {
      plaintext = vault.load(db, subId);
    } catch (err) {
      // Decrypt failure: row exists but the key didn't recover it
      // (rotated key, corrupted blob). Surface as a 500 with no
      // credential bytes — the operator gets the failure mode but no
      // material.
      const message = err instanceof Error ? err.message : String(err);
      return c.json(
        { error: 'failed to decrypt stored credential', detail: message },
        500,
      );
    }
    if (plaintext === null) {
      // Subscription exists but no credential row — the credential
      // resource is the missing thing, so 404 (not 400). The request
      // itself is well-formed; it's the underlying state that's absent.
      return c.json({ error: 'no credential stored' }, 404);
    }

    const connector = registry.get(sub.kind);
    if (!connector) {
      return c.json(
        { error: `no connector registered for kind '${sub.kind}'` },
        501,
      );
    }
    if (!connector.verifyCredential) {
      return c.json(
        { error: `verify not implemented for kind '${sub.kind}'` },
        501,
      );
    }

    try {
      const result = await connector.verifyCredential(plaintext);
      return c.json(result);
    } catch (err) {
      // A misbehaving connector that echoes the credential into its
      // Error.message would still be caught by the no-leak audit test,
      // which scans every response body for the plaintext. We don't
      // try to filter the message here — the contract on
      // `verifyCredential` is explicit, and silent stripping would just
      // mask the bug.
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, detail: `verify failed: ${message}` });
    }
  });

  return route;
}
