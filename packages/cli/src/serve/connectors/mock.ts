import type { PollContext, PollResult, SourceConnector } from './types.js';

/**
 * The mock connector exists for the e2e test and for future smoke tests
 * of CLI-side polling glue. Pattern semantics:
 *
 *   - strict integer string `"N"` (N >= 1) → emit N synthetic events per
 *     poll, ids `mock-{count+1}..mock-{count+N}`
 *   - anything else (non-integer, decimal, `"0"`, negatives, trailing
 *     garbage like `"5abc"`) → emit 1 synthetic event per poll
 *
 * The cursor is `{ count: number }` — total events emitted across all
 * polls for this subscription. Lets the e2e test scale event volume by
 * setting `pattern: "5"` and assert ids are monotonic across ticks.
 */
export interface MockCursor {
  count: number;
}

function eventsPerPoll(pattern: string): number {
  // Use Number() rather than parseInt() so "5abc" rejects to NaN instead
  // of coercing to 5 — README claims integer-string semantics and the
  // parser should match the contract.
  const n = Number(pattern);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

export const mockConnector: SourceConnector<MockCursor> = {
  kind: 'mock',
  async poll(ctx: PollContext<MockCursor>): Promise<PollResult<MockCursor>> {
    const startCount = ctx.cursor?.count ?? 0;
    const n = eventsPerPoll(ctx.subscription.pattern);
    const events = [];
    for (let i = 1; i <= n; i++) {
      const seq = startCount + i;
      events.push({
        id: `mock-${seq}`,
        payload: { seq, subscription_id: ctx.subscription.id },
      });
    }
    return { events, nextCursor: { count: startCount + n } };
  },
  // Trivial verifier so the credential-test endpoint has a kind to
  // exercise without needing a live source. Non-empty → ok; empty → not
  // ok with a generic detail. Never echoes the credential.
  async verifyCredential(credential) {
    if (credential.length === 0) {
      return { ok: false, detail: 'mock requires a non-empty credential' };
    }
    return { ok: true };
  },
};
