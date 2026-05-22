import { randomBytes } from 'node:crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestClient, type TestClient } from './fixtures/app-client.js';
import { buildDefaultRegistry, registerConnector } from '../../src/serve/connectors/registry.js';
import type { EventInput, SourceConnector } from '../../src/serve/connectors/types.js';
import { createScheduler } from '../../src/serve/scheduler/index.js';
import { openDb } from '../../src/serve/db.js';
import { createVault } from '../../src/serve/vault/index.js';
import type { EventRow } from '../../src/serve/event-curator.js';

let client: TestClient;
let subId: string;

async function createSub(c: TestClient, body: { kind: string; pattern: string }): Promise<string> {
  const r = await c.request<{ subscription: { id: string } }>({
    method: 'POST',
    path: '/v1/subscriptions',
    body,
  });
  return r.body.subscription.id;
}

describe('scheduler — e2e (AC #7)', () => {
  beforeEach(async () => {
    client = createTestClient();
    subId = await createSub(client, { kind: 'mock', pattern: '3' });
  });

  it('events accumulate with monotonic ids across ticks; last_polled_at updates', async () => {
    const beforeRow = client.db
      .prepare('SELECT last_polled_at FROM subscriptions WHERE id = ?')
      .get(subId) as { last_polled_at: string | null };
    expect(beforeRow.last_polled_at).toBeNull();

    const r1 = await client.tickOnce();
    expect(r1.outcomes).toHaveLength(1);
    expect(r1.outcomes[0].status).toBe('ok');
    expect(r1.outcomes[0].events_inserted).toBe(3);
    expect(r1.outcomes[0].events_emitted).toBe(3);

    const r2 = await client.tickOnce();
    expect(r2.outcomes[0].events_inserted).toBe(3);

    // Read endpoint reflects the accumulated events with monotonic server_seq.
    const events = await client.request<{
      events: { id: string; server_seq: number; payload: { seq: number } }[];
      next_since: number | null;
    }>({ path: `/v1/events?subscription_id=${subId}` });
    expect(events.body.events).toHaveLength(6);
    expect(events.body.events.map((e) => e.id)).toEqual([
      'mock-1',
      'mock-2',
      'mock-3',
      'mock-4',
      'mock-5',
      'mock-6',
    ]);
    const seqs = events.body.events.map((e) => e.server_seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs); // already monotonic ascending
    expect(events.body.next_since).toBe(seqs[seqs.length - 1]);

    // last_polled_at is now set, and the cursor advanced to count=6.
    const after = client.db
      .prepare('SELECT last_polled_at, cursor FROM subscriptions WHERE id = ?')
      .get(subId) as { last_polled_at: string | null; cursor: string | null };
    expect(after.last_polled_at).not.toBeNull();
    expect(JSON.parse(after.cursor!)).toEqual({ count: 6 });
  });

  it('INSERT OR IGNORE dedups when a connector replays an id', async () => {
    // Custom connector that returns the same id on every poll.
    const replayConnector: SourceConnector<{ count: number }> = {
      kind: 'replay',
      async poll(ctx) {
        const next = (ctx.cursor?.count ?? 0) + 1;
        return {
          events: [
            {
              id: 'duplicate-id',
              episodeKey: 'replay:duplicate-id',
              terminal: true,
              payload: { n: next },
            },
          ],
          nextCursor: { count: next },
        };
      },
    };
    const registry = buildDefaultRegistry();
    registerConnector(registry, replayConnector);
    client = createTestClient({ registry });
    const replaySub = await createSub(client, { kind: 'replay', pattern: 'x' });

    const r1 = await client.tickOnce();
    const out1 = r1.outcomes.find((o) => o.subscription_id === replaySub)!;
    expect(out1.events_inserted).toBe(1);
    expect(out1.events_emitted).toBe(1);

    const r2 = await client.tickOnce();
    const out2 = r2.outcomes.find((o) => o.subscription_id === replaySub)!;
    expect(out2.events_emitted).toBe(1);
    expect(out2.events_inserted).toBe(0); // INSERT OR IGNORE dropped it
    expect(out2.status).toBe('ok'); // dedup is not an error

    // Cursor still advanced — the connector reported progress even though
    // the id was a replay.
    const row = client.db
      .prepare('SELECT cursor FROM subscriptions WHERE id = ?')
      .get(replaySub) as { cursor: string };
    expect(JSON.parse(row.cursor)).toEqual({ count: 2 });
  });

  it('isolates failures: one bad connector does not block the others', async () => {
    const explodingConnector: SourceConnector<unknown> = {
      kind: 'explode',
      async poll() {
        throw new Error('boom');
      },
    };
    const registry = buildDefaultRegistry();
    registerConnector(registry, explodingConnector);
    client = createTestClient({ registry });

    const goodSub = await createSub(client, { kind: 'mock', pattern: '2' });
    const badSub = await createSub(client, { kind: 'explode', pattern: 'n/a' });

    const report = await client.tickOnce();
    const goodOutcome = report.outcomes.find((o) => o.subscription_id === goodSub)!;
    const badOutcome = report.outcomes.find((o) => o.subscription_id === badSub)!;
    expect(goodOutcome.status).toBe('ok');
    expect(goodOutcome.events_inserted).toBe(2);
    expect(badOutcome.status).toBe('error');
    expect(badOutcome.error).toBe('boom');

    // last_polled_at: set on success, stays null on failure.
    const goodRow = client.db
      .prepare('SELECT last_polled_at FROM subscriptions WHERE id = ?')
      .get(goodSub) as { last_polled_at: string | null };
    const badRow = client.db
      .prepare('SELECT last_polled_at FROM subscriptions WHERE id = ?')
      .get(badSub) as { last_polled_at: string | null };
    expect(goodRow.last_polled_at).not.toBeNull();
    expect(badRow.last_polled_at).toBeNull();
  });

  it('skips subscriptions whose kind has no registered connector', async () => {
    // Insert a row directly so we bypass the route-level shape check —
    // the scheduler must be defensive against rows whose connector was
    // unregistered between subscription create and tick.
    client.db
      .prepare(
        'INSERT INTO subscriptions (id, kind, pattern, created_at) VALUES (?, ?, ?, ?)',
      )
      .run('orphan-sub', 'unknown-kind', 'x', new Date().toISOString());

    const report = await client.tickOnce();
    const orphan = report.outcomes.find((o) => o.subscription_id === 'orphan-sub')!;
    expect(orphan.status).toBe('skipped');
    expect(orphan.events_inserted).toBe(0);
  });

  it('GET /v1/events sees the events the scheduler wrote, with next_since advancing', async () => {
    await client.tickOnce();
    const r1 = await client.request<{ events: unknown[]; next_since: number | null }>({
      path: `/v1/events?subscription_id=${subId}`,
    });
    expect(r1.body.events).toHaveLength(3);
    expect(r1.body.next_since).not.toBeNull();
    const cursor1 = r1.body.next_since!;

    await client.tickOnce();
    const r2 = await client.request<{ events: unknown[]; next_since: number | null }>({
      path: `/v1/events?subscription_id=${subId}&since=${cursor1}`,
    });
    expect(r2.body.events).toHaveLength(3);
    expect(r2.body.next_since).toBeGreaterThan(cursor1);
  });

  it('overlap guard: parallel tickOnce calls serialize, do not double-emit', async () => {
    // Fire two tickOnce calls without awaiting between them.
    const [a, b] = await Promise.all([client.tickOnce(), client.tickOnce()]);
    // Both reports describe a single tick worth of work; together they
    // should produce exactly the 6 events two sequential ticks produce.
    const inserted = a.outcomes[0].events_inserted + b.outcomes[0].events_inserted;
    expect(inserted).toBe(6);
    const events = await client.request<{ events: { id: string }[] }>({
      path: `/v1/events?subscription_id=${subId}`,
    });
    expect(events.body.events.map((e) => e.id)).toEqual([
      'mock-1',
      'mock-2',
      'mock-3',
      'mock-4',
      'mock-5',
      'mock-6',
    ]);
  });

  it('connector receives the decrypted stored credential on each poll', async () => {
    const seen: (string | null)[] = [];
    const tap: SourceConnector<{ count: number }> = {
      kind: 'tap',
      async poll(ctx) {
        seen.push(ctx.credential);
        return { events: [], nextCursor: { count: (ctx.cursor?.count ?? 0) + 1 } };
      },
    };
    const registry = buildDefaultRegistry();
    registerConnector(registry, tap);
    client = createTestClient({ registry });
    const tapSub = await createSub(client, { kind: 'tap', pattern: 'x' });

    // Pre-credential tick: connector sees null.
    await client.tickOnce();
    expect(seen[0]).toBeNull();

    // Store a credential, then tick again — connector now sees the
    // decrypted plaintext.
    await client.request({
      method: 'PUT',
      path: `/v1/subscriptions/${tapSub}/credential`,
      body: { credential: 'tap-secret-value' },
    });
    await client.tickOnce();
    expect(seen[1]).toBe('tap-secret-value');
  });

  it('drops an unparseable cursor and lets the connector start fresh', async () => {
    // Stuff a junk cursor into the row. Next tick should still succeed
    // and overwrite the cursor with a valid one.
    client.db
      .prepare('UPDATE subscriptions SET cursor = ? WHERE id = ?')
      .run('not-json{{{', subId);
    const report = await client.tickOnce();
    expect(report.outcomes[0].status).toBe('ok');
    expect(report.outcomes[0].events_inserted).toBe(3);
    const row = client.db
      .prepare('SELECT cursor FROM subscriptions WHERE id = ?')
      .get(subId) as { cursor: string };
    expect(JSON.parse(row.cursor)).toEqual({ count: 3 });
  });
});

describe('scheduler — episode_key on connector emissions (AGT-381)', () => {
  beforeEach(() => {
    client = createTestClient();
  });

  it('connector-emitted events land with the declared episode_key', async () => {
    subId = await createSub(client, { kind: 'mock', pattern: '2' });
    const report = await client.tickOnce();
    expect(report.outcomes[0].status).toBe('ok');
    expect(report.outcomes[0].events_inserted).toBe(2);

    // Read the rows directly from the events table — bypassing the
    // route — so we confirm the episode_key the connector emitted is
    // the value persisted, not just one the route synthesises on read.
    const rows = client.db
      .prepare(
        'SELECT id, episode_key FROM events WHERE subscription_id = ? ORDER BY server_seq',
      )
      .all(subId) as { id: string; episode_key: string }[];
    expect(rows).toEqual([
      { id: 'mock-1', episode_key: `mock:${subId}:1` },
      { id: 'mock-2', episode_key: `mock:${subId}:2` },
    ]);

    // GET /v1/events surfaces episode_key on each event too — the
    // CLI consumer downstream reads from this endpoint and uses
    // episode_key to group sibling memories.
    const resp = await client.request<{
      events: { id: string; episode_key: string }[];
    }>({ path: `/v1/events?subscription_id=${subId}` });
    expect(resp.body.events.map((e) => ({ id: e.id, episode_key: e.episode_key }))).toEqual([
      { id: 'mock-1', episode_key: `mock:${subId}:1` },
      { id: 'mock-2', episode_key: `mock:${subId}:2` },
    ]);
  });
});

describe('scheduler — terminal-event contract enforcement (AGT-382)', () => {
  beforeEach(() => {
    client = createTestClient();
  });

  it('drops non-terminal events; stores nothing, logs a structured warning', async () => {
    // Bypass the EventInput type to model a misbehaving connector. The
    // contract says `terminal: true`, but the framework must defend
    // against runtime drift (connectors are written by third parties;
    // TypeScript's word is not gospel at the proxy ingest boundary).
    const misbehavingConnector: SourceConnector<{ count: number }> = {
      kind: 'misbehaving',
      async poll(ctx) {
        const next = (ctx.cursor?.count ?? 0) + 1;
        const events: EventInput[] = [
          // One legitimate terminal event followed by a non-terminal
          // one — confirms the rejection is per-event, not per-poll.
          {
            id: `ok-${next}`,
            episodeKey: `misbehaving:${ctx.subscription.id}:${next}`,
            terminal: true,
            payload: { ok: true },
          },
          // Cast through `unknown` so the test can construct the
          // contract-violating shape the runtime guard catches.
          {
            id: `bad-${next}`,
            episodeKey: `misbehaving:${ctx.subscription.id}:${next}-preview`,
            terminal: false as unknown as true,
            payload: { ok: false },
          },
        ];
        return { events, nextCursor: { count: next } };
      },
    };
    const registry = buildDefaultRegistry();
    registerConnector(registry, misbehavingConnector);
    client = createTestClient({ registry });
    const sub = await createSub(client, { kind: 'misbehaving', pattern: 'x' });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const report = await client.tickOnce();
      const outcome = report.outcomes.find((o) => o.subscription_id === sub)!;
      expect(outcome.status).toBe('ok');
      expect(outcome.events_emitted).toBe(2);
      expect(outcome.events_inserted).toBe(1);
      expect(outcome.events_rejected_non_terminal).toBe(1);

      // The terminal event landed; the non-terminal one did not. We
      // assert by event id rather than count alone so a regression
      // that swaps the rejection direction (drops the good event,
      // keeps the bad one) is caught.
      const ids = (
        client.db
          .prepare('SELECT id FROM events WHERE subscription_id = ?')
          .all(sub) as { id: string }[]
      ).map((r) => r.id);
      expect(ids).toEqual(['ok-1']);

      // Structured warning carries enough context for an operator to
      // locate the offending connector — kind, subscription id, event
      // id. Anything weaker (just "non-terminal event dropped") would
      // be useless in a multi-connector deployment.
      const warning = warn.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.includes('non-terminal'));
      expect(warning).toBeDefined();
      expect(warning).toContain('kind=misbehaving');
      expect(warning).toContain(`subscription_id=${sub}`);
      expect(warning).toContain('event_id=bad-1');
    } finally {
      warn.mockRestore();
    }
  });

  it('rejects truthy-but-not-literal-true terminal markers (1, "true")', async () => {
    // The contract is `terminal === true`, not "truthy". A connector
    // returning `1` or `"true"` is still a contract violation at the
    // runtime boundary; coercing those to true would silently paper
    // over a connector bug.
    const fuzzyConnector: SourceConnector<{ count: number }> = {
      kind: 'fuzzy',
      async poll(ctx) {
        const next = (ctx.cursor?.count ?? 0) + 1;
        return {
          events: [
            {
              id: `evt-${next}`,
              episodeKey: `fuzzy:${ctx.subscription.id}:${next}`,
              terminal: 1 as unknown as true,
              payload: { n: next },
            },
          ],
          nextCursor: { count: next },
        };
      },
    };
    const registry = buildDefaultRegistry();
    registerConnector(registry, fuzzyConnector);
    client = createTestClient({ registry });
    const sub = await createSub(client, { kind: 'fuzzy', pattern: 'x' });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const report = await client.tickOnce();
      const outcome = report.outcomes.find((o) => o.subscription_id === sub)!;
      expect(outcome.events_rejected_non_terminal).toBe(1);
      expect(outcome.events_inserted).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('still advances the cursor even when every event is rejected', async () => {
    // Failure to insert is not a failure of the poll — the connector
    // told us where it got to. Cursor advances so the same junk
    // payload doesn't replay forever.
    const allBadConnector: SourceConnector<{ count: number }> = {
      kind: 'all-bad',
      async poll(ctx) {
        const next = (ctx.cursor?.count ?? 0) + 1;
        return {
          events: [
            {
              id: `evt-${next}`,
              episodeKey: `all-bad:${ctx.subscription.id}:${next}`,
              terminal: false as unknown as true,
              payload: {},
            },
          ],
          nextCursor: { count: next },
        };
      },
    };
    const registry = buildDefaultRegistry();
    registerConnector(registry, allBadConnector);
    client = createTestClient({ registry });
    const sub = await createSub(client, { kind: 'all-bad', pattern: 'x' });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await client.tickOnce();
    } finally {
      warn.mockRestore();
    }
    const row = client.db
      .prepare('SELECT cursor FROM subscriptions WHERE id = ?')
      .get(sub) as { cursor: string };
    expect(JSON.parse(row.cursor)).toEqual({ count: 1 });
  });
});

// ---------------------------------------------------------------------------
// Curator drain: per-tick post-poll pass that pulls uncurated events from
// the events table, runs each through processTerminalEvent, and records
// per-event outcomes. Uses the `processEvent` / `selectEvents` seams so
// these tests assert the drain's control flow (skip reasons, batching,
// failure isolation, dynamic cortex resolution) without booting the
// claude-agent-sdk or writing JSONL to disk.
// ---------------------------------------------------------------------------

describe('scheduler — curator drain', () => {
  function buildEventRow(opts: { id: string; subscription_id?: string }): EventRow {
    return {
      id: opts.id,
      subscription_id: opts.subscription_id ?? 'sub-x',
      payload_json: '{}',
      episode_key: `ep:${opts.id}`,
      created_at: '2026-05-22T00:00:00.000Z',
      curated_at: null,
    };
  }

  function makeNakedScheduler(opts: {
    peerId?: string;
    getCortexName?: () => string | null;
    curateBatchSize?: number;
    selectEvents?: ReturnType<typeof vi.fn>;
    processEvent?: ReturnType<typeof vi.fn>;
  } = {}) {
    const db = openDb(':memory:');
    const vault = createVault(randomBytes(32));
    const registry = buildDefaultRegistry();
    const scheduler = createScheduler({
      db,
      registry,
      vault,
      intervalMs: 60_000,
      peerId: opts.peerId,
      getCortexName: opts.getCortexName,
      curateBatchSize: opts.curateBatchSize,
      // `as never` because the seam types reference the real signatures —
      // tests supply vi.fn() stubs that match shape but not exact type.
      selectEvents: opts.selectEvents as never,
      processEvent: opts.processEvent as never,
    });
    return { db, scheduler };
  }

  it('skips drain when peerId is unset (disabled-no-peer-id)', async () => {
    const selectEvents = vi.fn();
    const { scheduler } = makeNakedScheduler({
      getCortexName: () => 'cortex/engineering',
      selectEvents,
    });
    const report = await scheduler.tickOnce();
    expect(report.curate_skip_reason).toBe('disabled-no-peer-id');
    expect(report.curate_outcomes).toEqual([]);
    expect(selectEvents).not.toHaveBeenCalled();
  });

  it('skips drain when getCortexName is unset (disabled-no-cortex-resolver)', async () => {
    const selectEvents = vi.fn();
    const { scheduler } = makeNakedScheduler({
      peerId: 'proxy-test',
      selectEvents,
    });
    const report = await scheduler.tickOnce();
    expect(report.curate_skip_reason).toBe('disabled-no-cortex-resolver');
    expect(report.curate_outcomes).toEqual([]);
    expect(selectEvents).not.toHaveBeenCalled();
  });

  it('skips drain when getCortexName returns null (no-active-cortex)', async () => {
    const selectEvents = vi.fn();
    const { scheduler } = makeNakedScheduler({
      peerId: 'proxy-test',
      getCortexName: () => null,
      selectEvents,
    });
    const report = await scheduler.tickOnce();
    expect(report.curate_skip_reason).toBe('no-active-cortex');
    expect(report.curate_outcomes).toEqual([]);
    expect(selectEvents).not.toHaveBeenCalled();
  });

  it('reports empty-queue when drain runs but selectEvents returns nothing', async () => {
    const selectEvents = vi.fn().mockReturnValue([]);
    const processEvent = vi.fn();
    const { scheduler } = makeNakedScheduler({
      peerId: 'proxy-test',
      getCortexName: () => 'cortex/engineering',
      selectEvents,
      processEvent,
    });
    const report = await scheduler.tickOnce();
    expect(report.curate_skip_reason).toBe('empty-queue');
    expect(report.curate_outcomes).toEqual([]);
    expect(selectEvents).toHaveBeenCalledTimes(1);
    expect(processEvent).not.toHaveBeenCalled();
  });

  it('processes uncurated events and records per-event outcomes in order', async () => {
    const events: EventRow[] = [
      buildEventRow({ id: 'evt-a' }),
      buildEventRow({ id: 'evt-b' }),
      buildEventRow({ id: 'evt-c' }),
    ];
    const selectEvents = vi.fn().mockReturnValue(events);
    const processEvent = vi.fn(async ({ event }: { event: EventRow }) => ({
      status: 'curated' as const,
      ids: [`mem-${event.id}`],
    }));

    const { scheduler } = makeNakedScheduler({
      peerId: 'proxy-test',
      getCortexName: () => 'cortex/engineering',
      selectEvents,
      processEvent,
    });
    const report = await scheduler.tickOnce();

    expect(report.curate_skip_reason).toBeNull();
    expect(report.curate_outcomes).toHaveLength(3);
    expect(report.curate_outcomes.map((o) => o.event_id)).toEqual(['evt-a', 'evt-b', 'evt-c']);
    for (const outcome of report.curate_outcomes) {
      expect(outcome.status).toBe('curated');
      expect(outcome.memory_ids).toEqual([`mem-${outcome.event_id}`]);
    }
    expect(processEvent).toHaveBeenCalledTimes(3);
    // Confirms peerId + cortexName are threaded into every call — these
    // are the two fields the cortex-writer stamps onto every memory it
    // writes, so a regression that drops them would silently land
    // memories under the wrong identity or in the wrong cortex.
    for (let i = 0; i < 3; i++) {
      const call = processEvent.mock.calls[i][0] as {
        peerId: string;
        cortexName: string;
      };
      expect(call.peerId).toBe('proxy-test');
      expect(call.cortexName).toBe('cortex/engineering');
    }
  });

  it('passes curateBatchSize through to selectEvents as the row limit', async () => {
    const selectEvents = vi.fn().mockReturnValue([]);
    const { scheduler } = makeNakedScheduler({
      peerId: 'proxy-test',
      getCortexName: () => 'cortex/engineering',
      curateBatchSize: 3,
      selectEvents,
    });
    await scheduler.tickOnce();
    expect(selectEvents).toHaveBeenCalledWith(expect.anything(), { limit: 3 });
  });

  it('isolates per-event failures: one throw does not block the rest', async () => {
    const events: EventRow[] = [
      buildEventRow({ id: 'evt-ok-1' }),
      buildEventRow({ id: 'evt-boom' }),
      buildEventRow({ id: 'evt-ok-2' }),
    ];
    const selectEvents = vi.fn().mockReturnValue(events);
    const processEvent = vi.fn(async ({ event }: { event: EventRow }) => {
      if (event.id === 'evt-boom') {
        throw new Error('curator rate-limited');
      }
      return { status: 'curated' as const, ids: [`mem-${event.id}`] };
    });

    const { scheduler } = makeNakedScheduler({
      peerId: 'proxy-test',
      getCortexName: () => 'cortex/engineering',
      selectEvents,
      processEvent,
    });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let report;
    try {
      report = await scheduler.tickOnce();
    } finally {
      errSpy.mockRestore();
    }

    expect(report.curate_skip_reason).toBeNull();
    expect(report.curate_outcomes).toHaveLength(3);
    const [ok1, boom, ok2] = report.curate_outcomes;
    expect(ok1.status).toBe('curated');
    expect(boom.status).toBe('error');
    expect(boom.error).toContain('rate-limited');
    expect(ok2.status).toBe('curated');
    // All three were attempted — failure of evt-boom did not short-circuit.
    expect(processEvent).toHaveBeenCalledTimes(3);
  });

  it('re-evaluates getCortexName on every tick (operator can switch live)', async () => {
    let activeCortex: string | null = 'cortex/alpha';
    const getCortexName = vi.fn(() => activeCortex);
    const selectEvents = vi.fn().mockReturnValue([buildEventRow({ id: 'evt-1' })]);
    const processEvent = vi.fn().mockResolvedValue({
      status: 'curated' as const,
      ids: ['mem-1'],
    });

    const { scheduler } = makeNakedScheduler({
      peerId: 'proxy-test',
      getCortexName,
      selectEvents,
      processEvent,
    });

    await scheduler.tickOnce();
    expect(processEvent.mock.calls[0][0]).toMatchObject({ cortexName: 'cortex/alpha' });

    // Operator switches the active cortex mid-flight; next tick picks it
    // up without restart.
    activeCortex = 'cortex/beta';
    await scheduler.tickOnce();
    expect(processEvent.mock.calls[1][0]).toMatchObject({ cortexName: 'cortex/beta' });

    // And if they unset it (cortex/* deleted, or `--no-active` mode),
    // the next tick should skip cleanly.
    activeCortex = null;
    const report = await scheduler.tickOnce();
    expect(report.curate_skip_reason).toBe('no-active-cortex');
    // selectEvents must NOT be called when there's no active cortex —
    // the early bail order is "check cortex first, then read queue".
    // Two calls total: one for each of the first two ticks.
    expect(selectEvents).toHaveBeenCalledTimes(2);
  });

  it('passes through already-curated outcome without inventing memory_ids', async () => {
    const selectEvents = vi.fn().mockReturnValue([buildEventRow({ id: 'evt-x' })]);
    const processEvent = vi.fn().mockResolvedValue({
      status: 'already-curated' as const,
      ids: [],
    });
    const { scheduler } = makeNakedScheduler({
      peerId: 'proxy-test',
      getCortexName: () => 'cortex/engineering',
      selectEvents,
      processEvent,
    });
    const report = await scheduler.tickOnce();
    expect(report.curate_outcomes).toHaveLength(1);
    expect(report.curate_outcomes[0].status).toBe('already-curated');
    expect(report.curate_outcomes[0].memory_ids).toBeUndefined();
  });

  it('drain infrastructure failure (getCortexName throws) returns error reason, does not abort the tick', async () => {
    const getCortexName = vi.fn(() => {
      throw new Error('config file corrupted');
    });
    const selectEvents = vi.fn();
    const { scheduler } = makeNakedScheduler({
      peerId: 'proxy-test',
      getCortexName,
      selectEvents,
    });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let report;
    try {
      // The critical contract: this MUST resolve, not reject. If
      // runDrain's throw propagated, the whole tick would abort and
      // polls would silently stop running. Operators would see the
      // proxy "go dark" with no diagnostic until the next tick.
      report = await scheduler.tickOnce();
    } finally {
      errSpy.mockRestore();
    }

    expect(report.curate_skip_reason).toBe('error');
    expect(report.curate_outcomes).toEqual([]);
    expect(selectEvents).not.toHaveBeenCalled();
    // The tick still completes — both timestamps are populated.
    expect(report.poll_finished_at).toBeTruthy();
    expect(report.finished_at).toBeTruthy();
  });

  it('drain infrastructure failure (selectEvents throws) returns error reason, processes no events', async () => {
    const selectEvents = vi.fn(() => {
      throw new Error('database is locked');
    });
    const processEvent = vi.fn();
    const { scheduler } = makeNakedScheduler({
      peerId: 'proxy-test',
      getCortexName: () => 'cortex/engineering',
      selectEvents,
      processEvent,
    });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let report;
    try {
      report = await scheduler.tickOnce();
    } finally {
      errSpy.mockRestore();
    }

    expect(report.curate_skip_reason).toBe('error');
    expect(report.curate_outcomes).toEqual([]);
    expect(processEvent).not.toHaveBeenCalled();
  });

  it('reports poll_finished_at separately from finished_at so drain time does not skew poll-latency metrics', async () => {
    // Sequence the `now()` clock so we can assert ordering exactly:
    // ts1 = started_at, ts2 = poll_finished_at (after the poll loop),
    // ts3 = finished_at (after the drain).
    const stamps = [
      '2026-05-22T22:00:00.000Z',
      '2026-05-22T22:00:01.000Z',
      '2026-05-22T22:00:42.000Z',
    ];
    let i = 0;
    const now = () => stamps[i++];

    const selectEvents = vi.fn().mockReturnValue([buildEventRow({ id: 'evt-1' })]);
    const processEvent = vi.fn().mockResolvedValue({
      status: 'curated' as const,
      ids: ['mem-1'],
    });
    const { scheduler } = makeNakedScheduler({
      peerId: 'proxy-test',
      getCortexName: () => 'cortex/engineering',
      selectEvents,
      processEvent,
    });
    // Override `now` by reaching into a fresh scheduler — the public
    // `now` option flows through `createScheduler` so we re-build with
    // it set.
    const db = openDb(':memory:');
    const vault = createVault(randomBytes(32));
    const registry = buildDefaultRegistry();
    const schedulerWithClock = createScheduler({
      db,
      registry,
      vault,
      intervalMs: 60_000,
      now,
      peerId: 'proxy-test',
      getCortexName: () => 'cortex/engineering',
      selectEvents: selectEvents as never,
      processEvent: processEvent as never,
    });

    const report = await schedulerWithClock.tickOnce();
    expect(report.started_at).toBe(stamps[0]);
    expect(report.poll_finished_at).toBe(stamps[1]);
    expect(report.finished_at).toBe(stamps[2]);

    // unused to silence lint about the first scheduler we didn't end
    // up using
    void scheduler;
  });

  it('clamps curateBatchSize <= 0 up to 1 (operator typo should not silently disable the drain)', async () => {
    const selectEvents = vi.fn().mockReturnValue([]);
    const { scheduler } = makeNakedScheduler({
      peerId: 'proxy-test',
      getCortexName: () => 'cortex/engineering',
      curateBatchSize: 0,
      selectEvents,
    });
    await scheduler.tickOnce();
    expect(selectEvents).toHaveBeenCalledWith(expect.anything(), { limit: 1 });

    selectEvents.mockClear();
    const { scheduler: s2 } = makeNakedScheduler({
      peerId: 'proxy-test',
      getCortexName: () => 'cortex/engineering',
      curateBatchSize: -10,
      selectEvents,
    });
    await s2.tickOnce();
    expect(selectEvents).toHaveBeenCalledWith(expect.anything(), { limit: 1 });
  });
});
