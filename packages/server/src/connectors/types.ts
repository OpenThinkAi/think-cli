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
   * configured. The framework reads this from the encrypted
   * `source_credentials` table and hands it to the connector for the
   * duration of the poll. Connectors that need a credential should throw
   * on `null` — the failure-isolation branch in the scheduler will turn
   * that into a per-poll error without crashing the tick.
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

/**
 * Result of a `verifyCredential` probe. `ok` is the gate; `detail` is an
 * optional human-readable note for the test endpoint to relay back to
 * the operator (e.g. an HTTP status from the source).
 *
 * **Invariant**: `detail` MUST NOT contain the credential value or any
 * derivative of it. The credential is opaque to the verifier's caller
 * and must stay opaque on the way back. The route that relays this
 * envelope to clients is the only externally visible surface, and AGT-029
 * AC #3 forbids any credential leak there.
 */
export interface VerifyCredentialResult {
  ok: boolean;
  detail?: string;
}

export interface SourceConnector<TCursor = unknown> {
  kind: string;
  poll(ctx: PollContext<TCursor>): Promise<PollResult<TCursor>>;
  /**
   * Optional pre-flight probe used by `POST /v1/subscriptions/:id/credential/test`.
   * Connectors with nothing to verify against (e.g. `mock` for empty
   * input checks; future cron / file-system kinds) can omit it; the
   * route returns `501 Not Implemented` in that case.
   *
   * Implementations must not log, echo, or include the credential in
   * thrown errors. A connector throw is caught at the route boundary
   * and surfaces as `{ ok: false, detail: 'verify failed: <message>' }`,
   * so any credential leak in `Error.message` would land in the response.
   */
  verifyCredential?(credential: string): Promise<VerifyCredentialResult>;
}
