import { randomUUID } from 'node:crypto';
import type { Database } from './db.js';
import type { Vault } from './vault/index.js';

/**
 * Admin operations for `think serve` subcommands (AGT-388).
 *
 * These helpers wrap the same sqlite tables the HTTP routes write to —
 * `subscriptions` and `source_credentials` via the vault — so an operator
 * can manage repos at runtime without restarting the proxy. The scheduler
 * reads the `subscriptions` table on every tick, so additions/removals
 * take effect within `THINK_POLL_INTERVAL_SECONDS`.
 *
 * Kept connector-agnostic (the operator passes `kind` as a string) so the
 * Linear/meeting connectors in later phases can reuse the same surface
 * without a second admin module.
 */

export interface SubscriptionRow {
  id: string;
  kind: string;
  pattern: string;
  created_at: string;
  last_polled_at: string | null;
}

export interface AddSubscriptionResult {
  created: boolean;
  subscription: SubscriptionRow;
}

/**
 * Add a subscription `(kind, pattern)` if one doesn't already exist.
 * Idempotent: a second add with the same `(kind, pattern)` returns the
 * existing row with `created: false`. This is the right shape for a
 * CLI command — re-running `think serve subscribe github octo/widget`
 * after a typo'd unrelated flag shouldn't fail or duplicate the row.
 */
export function addSubscription(
  db: Database,
  kind: string,
  pattern: string,
  opts: { now?: () => string } = {},
): AddSubscriptionResult {
  const now = opts.now ?? (() => new Date().toISOString());
  const existing = db
    .prepare(
      'SELECT id, kind, pattern, created_at, last_polled_at FROM subscriptions WHERE kind = ? AND pattern = ?',
    )
    .get(kind, pattern) as SubscriptionRow | undefined;
  if (existing) {
    return { created: false, subscription: existing };
  }
  const id = randomUUID();
  const created_at = now();
  db.prepare(
    'INSERT INTO subscriptions (id, kind, pattern, created_at) VALUES (?, ?, ?, ?)',
  ).run(id, kind, pattern, created_at);
  return {
    created: true,
    subscription: { id, kind, pattern, created_at, last_polled_at: null },
  };
}

/**
 * Remove the subscription with the given `(kind, pattern)`. Returns the
 * deleted row if one existed, or `null` if no match. Cascades via the
 * `events.subscription_id` FK (events for the sub are dropped too) and
 * the `source_credentials.subscription_id` FK (stored PAT is dropped).
 */
export function removeSubscription(
  db: Database,
  kind: string,
  pattern: string,
): SubscriptionRow | null {
  const existing = db
    .prepare(
      'SELECT id, kind, pattern, created_at, last_polled_at FROM subscriptions WHERE kind = ? AND pattern = ?',
    )
    .get(kind, pattern) as SubscriptionRow | undefined;
  if (!existing) return null;
  db.prepare('DELETE FROM subscriptions WHERE id = ?').run(existing.id);
  return existing;
}

/**
 * List subscriptions grouped by `kind`. Used by `think serve status` to
 * give the operator a one-shot view of "what is this proxy actually
 * polling". Each group's rows are ordered by `created_at ASC` so the
 * oldest sub for each kind appears first (mirrors `GET /v1/subscriptions`).
 */
export function listSubscriptionsByKind(
  db: Database,
): Record<string, SubscriptionRow[]> {
  const rows = db
    .prepare(
      'SELECT id, kind, pattern, created_at, last_polled_at FROM subscriptions ORDER BY kind ASC, created_at ASC',
    )
    .all() as SubscriptionRow[];
  const grouped: Record<string, SubscriptionRow[]> = {};
  for (const r of rows) {
    if (!grouped[r.kind]) grouped[r.kind] = [];
    grouped[r.kind].push(r);
  }
  return grouped;
}

/**
 * Store a credential plaintext against the subscription matched by
 * `(kind, pattern)`. Throws if no matching subscription exists — the
 * operator typically `subscribe`s first, then `creds add`s.
 *
 * Returns the subscription_id the credential was stored against so the
 * CLI can surface a confirmation message including the id.
 */
export function setSubscriptionCredential(
  db: Database,
  vault: Vault,
  kind: string,
  pattern: string,
  plaintext: string,
): string {
  if (plaintext.length === 0) {
    // Mirror the route-level guard. The vault itself accepts empty
    // strings; we reject here so the operator gets a clear error
    // instead of silently storing an empty PAT.
    throw new Error('credential must be a non-empty string');
  }
  const sub = db
    .prepare('SELECT id FROM subscriptions WHERE kind = ? AND pattern = ?')
    .get(kind, pattern) as { id: string } | undefined;
  if (!sub) {
    throw new Error(
      `no subscription found for kind=${kind} pattern=${pattern}; run \`think serve subscribe ${kind} ${pattern}\` first`,
    );
  }
  vault.store(db, sub.id, plaintext);
  return sub.id;
}
