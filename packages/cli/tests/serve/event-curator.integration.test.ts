/**
 * AGT-386 — end-to-end pipeline smoke test with the mock connector.
 *
 * Integration scope:
 *   We exercise the in-process pipeline:
 *     scheduler tick (mock connector) → events table
 *       → processTerminalEvent (curate + cortex-writer + mark curated)
 *       → JSONL lines on disk
 *       → AC #2 surrogate: read JSONL, run a topic-match query
 *
 *   We deliberately do NOT spin up the proxy's HTTP layer for the
 *   curate → write step. The HTTP layer is exercised by the existing
 *   scheduler.test.ts; AGT-386's value-add is proving that the
 *   curator → cortex-writer → dedup loop closes cleanly. Per the
 *   ticket's allowance: "If a real end-to-end test through the proxy's
 *   HTTP layer is too heavy for one ticket, write a tighter integration
 *   test that exercises the in-process pipeline … Document the choice."
 *
 *   What we DO use the HTTP layer for: subscription creation via
 *   `createTestClient`'s `POST /v1/subscriptions`, because going through
 *   the route gives us the same FK + token + middleware path the
 *   scheduler will see in production. The scheduler's `tickOnce()`
 *   produces the events; the wiring layer processes them; the test
 *   asserts on the JSONL output.
 *
 * SDK mock:
 *   The curator's `runTerminalEventCuration` calls into the Anthropic
 *   Agent SDK's `query` export. We mock that module at the test
 *   boundary, the same way `tests/lib/curator-terminal-event.test.ts`
 *   does. Each `querySpy.mockReturnValueOnce()` feeds the next curator
 *   call a deterministic payload.
 *
 * Push-debouncer mock:
 *   We pass `notifyPush: () => {}` into `processTerminalEvent` so no
 *   real git subprocess fires. The push-debouncer is already covered
 *   by its own tests; the smoke test's job is to assert the JSONL
 *   bytes, not the push-debouncer behaviour.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// SDK mock must be installed BEFORE the curator module is imported.
const querySpy = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: querySpy,
}));

// Import after the mock so the curator binds to the spy.
const { createTestClient } = await import('./fixtures/app-client.js');
const { processTerminalEvent, selectUncuratedEvents } = await import(
  '../../src/serve/event-curator.js'
);
const { getProxyPeerId } = await import('../../src/serve/peer-id.js');

const CORTEX = 'anglepoint-team';

/** Build an async generator yielding one synthetic SDK "result" message,
 * matching the `runTerminalEventCuration` consumer pattern. */
function generatorYielding(result: string): AsyncGenerator<{ result: string }> {
  return (async function* gen() {
    yield { result };
  })();
}

/** Read all JSONL lines from the active cortex page under THINK_HOME. */
function readCortexJsonl(thinkHome: string, cortex: string): Array<Record<string, unknown>> {
  const cortexDir = path.join(thinkHome, 'repo', cortex);
  if (!existsSync(cortexDir)) return [];
  const files = readdirSync(cortexDir).filter((f) => f.endsWith('.jsonl')).sort();
  const lines: Array<Record<string, unknown>> = [];
  for (const f of files) {
    const raw = readFileSync(path.join(cortexDir, f), 'utf-8');
    for (const ln of raw.split('\n')) {
      if (ln.length === 0) continue;
      lines.push(JSON.parse(ln) as Record<string, unknown>);
    }
  }
  return lines;
}

/**
 * AC #2 surrogate: "read the JSONL lines via the existing cortex-pull/
 * import code and verify they show up in a recall-like query against an
 * in-memory db." We take the lighter form the ticket allows: a topic-
 * substring match over the parsed JSONL. The real `think recall` path
 * goes through L2 (SQLite + FTS/vec) — reindexing for a smoke test
 * would amount to standing up the embed-model glue, which the ticket
 * explicitly says is too heavy for one ticket. The topic-substring
 * match exercises the same observable: "memory tagged <topic> is
 * reachable via a topic query."
 */
function recallByTopic(
  lines: Array<Record<string, unknown>>,
  topic: string,
): Array<Record<string, unknown>> {
  return lines.filter((line) => {
    const topics = line.topics;
    if (!Array.isArray(topics)) return false;
    return topics.some((t) => typeof t === 'string' && t.toLowerCase().includes(topic.toLowerCase()));
  });
}

describe('AGT-386 — end-to-end pipeline smoke test', () => {
  let thinkHome: string;
  let originalHome: string | undefined;
  let originalConsent: string | undefined;

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    thinkHome = mkdtempSync(path.join(tmpdir(), 'think-agt-386-'));
    process.env.THINK_HOME = thinkHome;
    originalConsent = process.env.THINK_LLM_CONSENT;
    process.env.THINK_LLM_CONSENT = '1';
    querySpy.mockReset();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    if (originalConsent === undefined) delete process.env.THINK_LLM_CONSENT;
    else process.env.THINK_LLM_CONSENT = originalConsent;
    rmSync(thinkHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('AC #1 + #2: mock connector emits a multi-topic terminal event → N memories land in the cortex JSONL with shared episode_key, distinct ids, proxy peer-id, source_ids=[event.id]; topic recall surrogate returns them', async () => {
    // 1. Spin up the proxy in-process and create a mock subscription.
    const client = createTestClient();
    const peerId = getProxyPeerId(client.db);

    const createRes = await client.request<{ subscription: { id: string } }>({
      method: 'POST',
      path: '/v1/subscriptions',
      body: { kind: 'mock', pattern: '1' },
    });
    expect(createRes.status).toBe(201);
    const subId = createRes.body.subscription.id;

    // 2. Drive one scheduler tick → mock connector emits a terminal event.
    const tickReport = await client.tickOnce();
    expect(tickReport.outcomes).toHaveLength(1);
    expect(tickReport.outcomes[0].status).toBe('ok');
    expect(tickReport.outcomes[0].events_inserted).toBe(1);

    // 3. Stub the curator to emit a multi-topic response on the next call.
    //    This represents a "long meeting transcript" being split into 3
    //    discrete topical memories — the AC #1 multi-topic case.
    const curatorResponse = JSON.stringify({
      memories: [
        {
          content:
            'The team agreed to migrate the logging stack from self-hosted Loki to Datadog by end of Q3. Cost analysis showed Datadog comes out cheaper above 200GB/day ingestion.',
          topics: ['infrastructure', 'logging'],
        },
        {
          content:
            'Hiring plan for H2: two senior backend roles greenlit, one staff platform role deferred to 2027 pending revenue review.',
          topics: ['hiring'],
        },
        {
          content:
            'Product pivoted the Q4 roadmap away from multi-tenant SSO toward an enterprise audit-log API. Three signed LOIs.',
          topics: ['product-roadmap'],
        },
      ],
    });
    querySpy.mockReturnValueOnce(generatorYielding(curatorResponse));

    // 4. Pull uncurated events and run the wiring layer on each.
    const uncurated = selectUncuratedEvents(client.db);
    expect(uncurated).toHaveLength(1);
    const eventRow = uncurated[0];

    const outcome = await processTerminalEvent({
      db: client.db,
      event: eventRow,
      peerId,
      cortexName: CORTEX,
      // No `notifyPush` override: cortex-writer's default would call the
      // real push-debouncer. Pass a no-op to keep the test hermetic.
      notifyPush: () => {},
    });
    expect(outcome.status).toBe('curated');
    expect(outcome.ids).toHaveLength(3);

    // 5. AC #1 assertions: 3 JSONL lines, shared episode_key, distinct
    //    ids, proxy peer-id, source_ids = [event.id].
    const lines = readCortexJsonl(thinkHome, CORTEX);
    expect(lines).toHaveLength(3);

    const expectedEpisodeKey = `mock:${subId}:1`;
    expect(eventRow.episode_key).toBe(expectedEpisodeKey);
    for (const line of lines) {
      expect(line.episode_key).toBe(expectedEpisodeKey);
      expect(line.author).toBe('proxy');
      expect(line.origin_peer_id).toBe(peerId);
      expect(line.source_ids).toEqual([eventRow.id]);
      expect(line.supersedes).toEqual([]);
      expect(line.compacted_from).toBeNull();
    }

    const ids = lines.map((l) => l.id as string);
    expect(new Set(ids).size).toBe(3); // all distinct
    expect(ids).toEqual(outcome.ids);

    // 6. AC #2 surrogate: a topic-match query returns the right memories.
    expect(recallByTopic(lines, 'infrastructure')).toHaveLength(1);
    expect(recallByTopic(lines, 'hiring')).toHaveLength(1);
    expect(recallByTopic(lines, 'product-roadmap')).toHaveLength(1);
    expect(recallByTopic(lines, 'no-such-topic')).toHaveLength(0);

    // 7. The events row is marked curated.
    const afterRow = client.db
      .prepare('SELECT curated_at FROM events WHERE id = ? AND subscription_id = ?')
      .get(eventRow.id, eventRow.subscription_id) as { curated_at: string | null };
    expect(afterRow.curated_at).not.toBeNull();
    expect(afterRow.curated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // 8. The same row is no longer surfaced by `selectUncuratedEvents`.
    expect(selectUncuratedEvents(client.db)).toHaveLength(0);
  });

  it('AC #3: re-emitting the same (connector, event.id) pair produces no additional memories', async () => {
    // The dedup story has two layers:
    //
    //  Layer 1 — INSERT OR IGNORE on the events table. The scheduler
    //  already enforces this via the UNIQUE(subscription_id, id) index;
    //  a connector replay simply doesn't insert a second row. This is
    //  covered by scheduler.test.ts "INSERT OR IGNORE dedups when a
    //  connector replays an id".
    //
    //  Layer 2 — `events.curated_at` flag. Even if the events row exists
    //  and someone calls `processTerminalEvent` on it a second time, we
    //  must not double-write to the cortex. This test exercises both
    //  layers in the order they fire in production:
    //
    //    tick 1 → 1 event inserted, curated, 2 memories written
    //    tick 2 → connector replays id, INSERT OR IGNORE drops it, no
    //             new uncurated rows surface → second pipeline pass
    //             over `selectUncuratedEvents()` is a no-op
    //    (alternate path) processTerminalEvent called directly on the
    //             already-curated row → returns { status: 'already-
    //             curated' }, no LLM call, no JSONL writes.
    const client = createTestClient();
    const peerId = getProxyPeerId(client.db);
    const subId = (
      await client.request<{ subscription: { id: string } }>({
        method: 'POST',
        path: '/v1/subscriptions',
        body: { kind: 'mock', pattern: '1' },
      })
    ).body.subscription.id;

    // First tick + first pipeline pass.
    await client.tickOnce();
    const firstResponse = JSON.stringify({
      memories: [
        { content: 'first memory', topics: ['topic-a'] },
        { content: 'second memory', topics: ['topic-b'] },
      ],
    });
    querySpy.mockReturnValueOnce(generatorYielding(firstResponse));
    const firstBatch = selectUncuratedEvents(client.db);
    expect(firstBatch).toHaveLength(1);
    await processTerminalEvent({
      db: client.db,
      event: firstBatch[0],
      peerId,
      cortexName: CORTEX,
      notifyPush: () => {},
    });

    expect(readCortexJsonl(thinkHome, CORTEX)).toHaveLength(2);
    expect(querySpy).toHaveBeenCalledTimes(1);

    // --- Layer 1: connector replays the same id on a second tick. ---
    //
    // The mock connector advances its own cursor, so a "vanilla" second
    // tick would emit `mock-2`. To exercise replay, we build a replay
    // connector that always emits the same id `mock-1` and swap it in.
    // The new id collides with the row already in the events table, so
    // INSERT OR IGNORE drops it.
    //
    // We swap by re-registering on the same registry instance — the
    // scheduler reads from `client.registry` on every tick.
    const { registerConnector } = await import('../../src/serve/connectors/registry.js');
    registerConnector(client.registry, {
      kind: 'mock',
      async poll(ctx) {
        return {
          events: [
            {
              id: 'mock-1', // identical to what the real mock emitted on tick 1
              episodeKey: `mock:${ctx.subscription.id}:1`,
              terminal: true,
              payload: { seq: 1, subscription_id: ctx.subscription.id, replayed: true },
            },
          ],
          nextCursor: { count: 1 },
        };
      },
    });

    const tick2 = await client.tickOnce();
    const out = tick2.outcomes.find((o) => o.subscription_id === subId)!;
    expect(out.status).toBe('ok');
    expect(out.events_emitted).toBe(1);
    expect(out.events_inserted).toBe(0); // INSERT OR IGNORE dropped it

    // No new uncurated rows surfaced.
    expect(selectUncuratedEvents(client.db)).toHaveLength(0);

    // --- Layer 2: re-invoke processTerminalEvent on the already-curated row. ---
    const reloaded = client.db
      .prepare(
        'SELECT id, subscription_id, payload_json, episode_key, created_at, curated_at FROM events WHERE subscription_id = ?',
      )
      .get(subId) as {
      id: string;
      subscription_id: string;
      payload_json: string;
      episode_key: string;
      created_at: string;
      curated_at: string | null;
    };
    expect(reloaded.curated_at).not.toBeNull();

    const replayOutcome = await processTerminalEvent({
      db: client.db,
      event: reloaded,
      peerId,
      cortexName: CORTEX,
      notifyPush: () => {},
    });
    expect(replayOutcome.status).toBe('already-curated');
    expect(replayOutcome.ids).toEqual([]);

    // No additional LLM call was issued.
    expect(querySpy).toHaveBeenCalledTimes(1);

    // JSONL is unchanged — still exactly 2 lines.
    expect(readCortexJsonl(thinkHome, CORTEX)).toHaveLength(2);
  });

  it('the wiring layer passes connector kind as a default source tag', async () => {
    // Sanity-check on the bridge: when sourceTags is unset, the wiring
    // layer derives `[<connector kind>]` from the subscription row. The
    // curator surfaces source_tags in its prompt header, so we assert
    // by inspecting the `call.prompt` text the SDK spy received.
    const client = createTestClient();
    const peerId = getProxyPeerId(client.db);
    await client.request<{ subscription: { id: string } }>({
      method: 'POST',
      path: '/v1/subscriptions',
      body: { kind: 'mock', pattern: '1' },
    });
    await client.tickOnce();
    querySpy.mockReturnValueOnce(
      generatorYielding(
        JSON.stringify({ memories: [{ content: 'ok', topics: ['t'] }] }),
      ),
    );

    const [evt] = selectUncuratedEvents(client.db);
    await processTerminalEvent({
      db: client.db,
      event: evt,
      peerId,
      cortexName: CORTEX,
      notifyPush: () => {},
    });

    expect(querySpy).toHaveBeenCalledTimes(1);
    const promptText = querySpy.mock.calls[0][0].prompt as string;
    expect(promptText).toContain('source_tags: mock');
  });
});
