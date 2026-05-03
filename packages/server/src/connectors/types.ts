/**
 * `SourceConnector` is the framework's only contract with a per-source
 * implementation. The framework owns persistence and scheduling; the
 * connector owns talking to the source and producing events.
 *
 * Cursor opacity is deliberate. Each connector picks its own shape
 * (GitHub: per-endpoint `{ etag, lastModified, since }`; mock: `{ count }`).
 * The framework persists `nextCursor` as JSON-encoded TEXT and feeds it
 * back to the next `poll()` verbatim. A connector that sees `null` is
 * being polled for the first time (or is recovering from an unparseable
 * stored cursor — see scheduler/index.ts).
 *
 * Rate-limit and conditional-GET handling are the connector's
 * responsibility, not the framework's. A 304-on-If-None-Match becomes
 * `{ events: [], nextCursor: same-or-updated-cursor }` — a successful
 * poll that produced no new events.
 */
export interface PollContext<TCursor = unknown> {
  subscription: { id: string; kind: string; pattern: string };
  /**
   * Decrypted credential for this subscription, or `null` if none is
   * configured. Wired but not yet populated — credential storage lands in
   * AGT-029. Connectors that need a credential should throw on `null`.
   */
  credential: string | null;
  /**
   * `null` on the first poll for a subscription, or after the previous
   * cursor failed to parse out of storage. Otherwise the verbatim
   * `nextCursor` returned by the previous successful poll.
   */
  cursor: TCursor | null;
}

export interface EventInput {
  /**
   * Stable per-source id. The framework dedups via
   * `UNIQUE(subscription_id, id)` + `INSERT OR IGNORE`, so a connector
   * replaying a previously-emitted id is harmless.
   */
  id: string;
  payload: unknown;
}

export interface PollResult<TCursor = unknown> {
  events: EventInput[];
  nextCursor: TCursor;
}

export interface SourceConnector<TCursor = unknown> {
  kind: string;
  poll(ctx: PollContext<TCursor>): Promise<PollResult<TCursor>>;
}
