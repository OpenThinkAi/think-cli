import { describe, it, expect, beforeEach } from 'vitest';
import { createTestClient, type TestClient } from './fixtures/app-client.js';
import { deterministicId } from '../../src/lib/deterministic-id.js';
import type {
  PushResponse,
  PullResponse,
  WireMemoryLine,
} from '../../src/sync/hub-protocol.js';

let client: TestClient;

beforeEach(() => {
  client = createTestClient();
});

const CORTEX = 'engineering';

function line(content: string, over: Partial<WireMemoryLine> = {}): WireMemoryLine {
  return {
    ts: '2026-06-18T00:00:00.000Z',
    author: 'matt',
    content,
    source_ids: [],
    kind: 'memory',
    ...over,
  };
}

function push(lines: WireMemoryLine[], cortex = CORTEX, token?: string | null) {
  return client.request<PushResponse>({
    method: 'POST',
    path: '/v1/cortex-sync/push',
    body: { cortex, lines },
    ...(token !== undefined ? { token } : {}),
  });
}

function pull(
  q: { cortex?: string; cursor?: number; limit?: number } = {},
  token?: string | null,
) {
  const params = new URLSearchParams();
  params.set('cortex', q.cortex ?? CORTEX);
  if (q.cursor !== undefined) params.set('cursor', String(q.cursor));
  if (q.limit !== undefined) params.set('limit', String(q.limit));
  return client.request<PullResponse>({
    path: `/v1/cortex-sync/pull?${params.toString()}`,
    ...(token !== undefined ? { token } : {}),
  });
}

describe('POST /v1/cortex-sync/push', () => {
  it('appends lines and returns assigned monotonic seqs (AC1)', async () => {
    const r = await push([line('a'), line('b'), line('c')]);
    expect(r.status).toBe(200);
    expect(r.body.accepted).toBe(3);
    expect(r.body.duplicates).toBe(0);
    expect(r.body.results.map((x) => x.status)).toEqual([
      'accepted',
      'accepted',
      'accepted',
    ]);
    expect(r.body.results.map((x) => x.server_seq)).toEqual([1, 2, 3]);
    expect(r.body.maxServerSeq).toBe(3);
    // Returned id matches the content-derived id (server never trusts wire id).
    expect(r.body.results[0].id).toBe(
      deterministicId('2026-06-18T00:00:00.000Z', 'matt', 'a'),
    );
  });

  it('idempotent re-push returns the original seq with no duplication (AC4)', async () => {
    await push([line('a'), line('b')]);
    const r = await push([line('a'), line('c')]);
    expect(r.status).toBe(200);
    expect(r.body.accepted).toBe(1); // only 'c' is new
    expect(r.body.duplicates).toBe(1); // 'a' is a replay
    const byContent = new Map(r.body.results.map((x) => [x.id, x]));
    const aId = deterministicId('2026-06-18T00:00:00.000Z', 'matt', 'a');
    const cId = deterministicId('2026-06-18T00:00:00.000Z', 'matt', 'c');
    expect(byContent.get(aId)).toMatchObject({ status: 'duplicate', server_seq: 1 });
    expect(byContent.get(cId)).toMatchObject({ status: 'accepted', server_seq: 3 });
    expect(r.body.maxServerSeq).toBe(3);

    // No duplication in storage: pull from the beginning sees exactly 3 lines.
    const after = await pull({ cursor: 0, limit: 1000 });
    expect(after.body.lines).toHaveLength(3);
    expect(after.body.lines.map((l) => l.content)).toEqual(['a', 'b', 'c']);
  });

  it('empty push against an empty cortex returns maxServerSeq 0', async () => {
    const r = await push([]);
    expect(r.status).toBe(200);
    expect(r.body.results).toHaveLength(0);
    expect(r.body.accepted).toBe(0);
    expect(r.body.maxServerSeq).toBe(0);
  });

  it('round-trips optional wire fields (episode_key, decisions, origin_peer_id)', async () => {
    await push([
      line('x', {
        episode_key: 'ep-1',
        decisions: ['ship it'],
        origin_peer_id: 'peer-1',
        source_ids: ['eng-1', 'eng-2'],
      }),
    ]);
    const r = await pull();
    expect(r.body.lines[0]).toMatchObject({
      content: 'x',
      episode_key: 'ep-1',
      decisions: ['ship it'],
      origin_peer_id: 'peer-1',
      source_ids: ['eng-1', 'eng-2'],
      kind: 'memory',
    });
  });

  it('400 on a body missing required fields', async () => {
    const r = await client.request({
      method: 'POST',
      path: '/v1/cortex-sync/push',
      body: { cortex: CORTEX, lines: [{ ts: 'x' }] },
    });
    expect(r.status).toBe(400);
  });

  it('400 on an invalid cortex name (path-traversal)', async () => {
    const r = await push([line('a')], '../etc');
    expect(r.status).toBe(400);
  });

  it('partitions lines by cortex name within the single tenant', async () => {
    await push([line('a')], 'cortex-a');
    await push([line('b')], 'cortex-b');
    const a = await pull({ cortex: 'cortex-a' });
    const b = await pull({ cortex: 'cortex-b' });
    expect(a.body.lines.map((l) => l.content)).toEqual(['a']);
    expect(b.body.lines.map((l) => l.content)).toEqual(['b']);
    // Per-cortex seq: each cortex starts at 1.
    expect(a.body.lines[0].server_seq).toBe(1);
    expect(b.body.lines[0].server_seq).toBe(1);
  });
});

describe('GET /v1/cortex-sync/pull', () => {
  it('returns server_seq > cursor ordered ASC and capped at N with nextCursor/hasMore (AC1, AC4)', async () => {
    await push([line('a'), line('b'), line('c'), line('d'), line('e')]);

    const p1 = await pull({ cursor: 0, limit: 2 });
    expect(p1.status).toBe(200);
    expect(p1.body.lines.map((l) => l.content)).toEqual(['a', 'b']);
    expect(p1.body.lines.map((l) => l.server_seq)).toEqual([1, 2]);
    expect(p1.body.nextCursor).toBe(2);
    expect(p1.body.hasMore).toBe(true); // page was full

    const p2 = await pull({ cursor: p1.body.nextCursor, limit: 2 });
    expect(p2.body.lines.map((l) => l.content)).toEqual(['c', 'd']);
    expect(p2.body.nextCursor).toBe(4);
    expect(p2.body.hasMore).toBe(true);

    const p3 = await pull({ cursor: p2.body.nextCursor, limit: 2 });
    expect(p3.body.lines.map((l) => l.content)).toEqual(['e']);
    expect(p3.body.nextCursor).toBe(5);
    expect(p3.body.hasMore).toBe(false); // not a full page
  });

  it('empty page leaves nextCursor unchanged and hasMore false', async () => {
    await push([line('a')]);
    const r = await pull({ cursor: 999 });
    expect(r.body.lines).toHaveLength(0);
    expect(r.body.nextCursor).toBe(999);
    expect(r.body.hasMore).toBe(false);
  });

  it('defaults cursor=0 and uses default limit when omitted', async () => {
    await push([line('a'), line('b')]);
    const r = await pull(); // no cursor/limit
    expect(r.body.lines.map((l) => l.content)).toEqual(['a', 'b']);
    expect(r.body.nextCursor).toBe(2);
    expect(r.body.hasMore).toBe(false);
  });

  it('400 when limit exceeds the hard cap of 1000 (N cap enforced, not clamped)', async () => {
    const r = await pull({ limit: 10000 });
    expect(r.status).toBe(400);
  });

  it('400 when limit=0 — schema enforces min(1), so the hasMore=full-page heuristic never sees a 0 limit', async () => {
    // Guards the pull handler's `hasMore = lines.length === limit` logic: a
    // limit of 0 would make that expression `0 === 0 = true` forever. The
    // protocol schema's min(1) rejects it at the boundary before the handler
    // runs, so the heuristic is only ever evaluated for limit >= 1.
    const r = await pull({ limit: 0 });
    expect(r.status).toBe(400);
  });

  it('400 when cortex query param is missing', async () => {
    const r = await client.request({ path: '/v1/cortex-sync/pull?cursor=0' });
    expect(r.status).toBe(400);
  });
});

describe('cortex-sync auth (AC2/AC3)', () => {
  it('401 on push without a token (AC2)', async () => {
    const r = await push([line('a')], CORTEX, null);
    expect(r.status).toBe(401);
  });

  it('401 on push with a wrong token (AC2)', async () => {
    const r = await push([line('a')], CORTEX, 'not-the-token');
    expect(r.status).toBe(401);
  });

  it('401 on pull without a token (AC2)', async () => {
    const r = await pull({}, null);
    expect(r.status).toBe(401);
  });

  it('401 on pull with a wrong token (AC2)', async () => {
    const r = await pull({}, 'not-the-token');
    expect(r.status).toBe(401);
  });

  it('a valid token round-trips push then pull (AC3)', async () => {
    const w = await push([line('hello')]); // default valid token
    expect(w.status).toBe(200);
    const r = await pull(); // default valid token
    expect(r.status).toBe(200);
    expect(r.body.lines.map((l) => l.content)).toEqual(['hello']);
  });
});

describe('no-regression: existing routes still resolve under the single THINK_TOKEN', () => {
  it('GET /v1/events still resolves (404 for unknown sub, not a routing miss)', async () => {
    const r = await client.request({ path: '/v1/events?subscription_id=missing' });
    expect(r.status).toBe(404); // route ran; subscription just absent
  });

  it('/v1/cortexes legacy path still returns 410 (not shadowed by cortex-sync)', async () => {
    const r = await client.request({ path: '/v1/cortexes', token: null });
    expect(r.status).toBe(410);
  });

  it('unknown endpoint 404 detail lists the new cortex-sync routes', async () => {
    const r = await client.request<{ detail: string }>({ path: '/v1/nope' });
    expect(r.status).toBe(404);
    expect(r.body.detail).toContain('/v1/cortex-sync/push');
    expect(r.body.detail).toContain('/v1/cortex-sync/pull');
  });
});
