import type { PollContext, PollResult, SourceConnector } from './types.js';

/**
 * The mock connector exists for the e2e test and for future smoke tests
 * of CLI-side polling glue. Pattern semantics:
 *
 *   - integer string `"N"` (after `parseInt`, `>= 1`) → emit N synthetic
 *     events per poll, ids `mock-{count+1}..mock-{count+N}`
 *   - anything else → emit 1 synthetic event per poll
 *
 * The cursor is `{ count: number }` — total events emitted across all
 * polls for this subscription. Lets the e2e test scale event volume by
 * setting `pattern: "5"` and assert ids are monotonic across ticks.
 */
export interface MockCursor {
  count: number;
}

function eventsPerPoll(pattern: string): number {
  const n = Number.parseInt(pattern, 10);
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
};
