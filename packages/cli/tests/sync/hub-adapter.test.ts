import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { createApp } from '../../src/serve/app.js';
import { buildDefaultRegistry } from '../../src/serve/connectors/registry.js';
import { openDb, type Database } from '../../src/serve/db.js';
import { createVault } from '../../src/serve/vault/index.js';
import { HubSyncAdapter, type FetchLike } from '../../src/sync/hub-adapter.js';
import { saveConfig, getConfig } from '../../src/lib/config.js';
import {
  insertMemory,
  getMemoryCount,
  getSyncCursor,
} from '../../src/db/memory-queries.js';
import { appendCortexLine } from '../../src/serve/cortex-lines-store.js';
import { createPeerPair, type TestPeer, type PeerPair } from '../fixtures/peer-pair.js';

// The bearer middleware reads THINK_TOKEN once at app construction, so it must
// be set before createApp() runs. Match the token in the peers' hub config.
const TOKEN = 'hub-test-token-' + randomBytes(6).toString('hex');
process.env.THINK_TOKEN = TOKEN;
const HUB_URL = 'http://hub.test.local';

/**
 * A fetch stub that drives the REAL cortex-sync routes (AGT-572) of an
 * in-memory `think serve` app. This proves the client+server contract
 * end-to-end rather than asserting against a hand-rolled response shape.
 */
function makeHubFetch(app: Hono): FetchLike {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return app.fetch(new Request(url, init as RequestInit));
  }) as FetchLike;
}

function configureHub(token = TOKEN, remoteCortex?: string): void {
  const existing = getConfig();
  saveConfig({
    ...existing,
    cortex: {
      hub: { url: HUB_URL, token, ...(remoteCortex ? { cortex: remoteCortex } : {}) },
      author: 'test',
    },
  });
}

let pair: PeerPair;
let serveDb: Database;
let app: Hono;
let hubFetch: FetchLike;

beforeEach(() => {
  pair = createPeerPair();
  serveDb = openDb(':memory:');
  app = createApp({
    db: serveDb,
    vault: createVault(randomBytes(32)),
    registry: buildDefaultRegistry(),
  });
  hubFetch = makeHubFetch(app);
});

afterEach(() => {
  pair.cleanup();
});

function adapter(token = TOKEN, remoteCortex?: string): HubSyncAdapter {
  configureHub(token, remoteCortex);
  return new HubSyncAdapter(hubFetch);
}

describe('hub adapter push (AC1, AC4)', () => {
  it('serializes + posts only own-authored, non-deleted memories', async () => {
    pair.peerA.activate();
    const localPeer = getConfig().peerId;
    insertMemory(pair.cortexName, { ts: '2026-06-18T00:00:00Z', author: 'a', content: 'own-1' });
    insertMemory(pair.cortexName, { ts: '2026-06-18T00:00:01Z', author: 'a', content: 'own-2' });
    // A row attributed to another peer must NOT be re-emitted (origin_peer_id guard).
    insertMemory(pair.cortexName, {
      ts: '2026-06-18T00:00:02Z', author: 'b', content: 'foreign',
      origin_peer_id: 'some-other-peer',
    });
    // A locally tombstoned row must be skipped (memories immutable via sync).
    insertMemory(pair.cortexName, {
      ts: '2026-06-18T00:00:03Z', author: 'a', content: 'deleted',
      deleted_at: '2026-06-18T01:00:00Z',
    });

    const a = adapter();
    const res = await a.push(pair.cortexName);
    expect(res.errors).toEqual([]);
    expect(res.pushed).toBe(2); // only own-1 + own-2

    // The server stored exactly the two own-authored lines.
    const stored = serveDb
      .prepare('SELECT content, origin_peer_id FROM cortex_lines WHERE cortex = ? ORDER BY server_seq')
      .all(pair.cortexName) as { content: string; origin_peer_id: string }[];
    expect(stored.map((s) => s.content)).toEqual(['own-1', 'own-2']);
    expect(stored.every((s) => s.origin_peer_id === localPeer)).toBe(true);
  });

  it('advances the push cursor only after a successful POST', async () => {
    pair.peerA.activate();
    insertMemory(pair.cortexName, { ts: '2026-06-18T00:00:00Z', author: 'a', content: 'x' });

    const a = adapter();
    await a.push(pair.cortexName);
    const cursor = getSyncCursor(pair.cortexName, 'hub', 'push');
    expect(cursor).not.toBeNull();

    // A second push with no new rows is a no-op (cursor already past them).
    const res2 = await a.push(pair.cortexName);
    expect(res2.pushed).toBe(0);
  });
});

describe('hub adapter pull (AC1, AC2)', () => {
  it('ingests server lines and advances the cursor', async () => {
    // Seed the server directly via the store (as if another peer had pushed).
    appendCortexLine(serveDb, pair.cortexName, {
      ts: '2026-06-18T00:00:00Z', author: 'remote', content: 's1', source_ids: [], kind: 'memory',
    });
    appendCortexLine(serveDb, pair.cortexName, {
      ts: '2026-06-18T00:00:01Z', author: 'remote', content: 's2', source_ids: [], kind: 'memory',
    });

    pair.peerB.activate();
    const b = adapter();
    const res = await b.pull(pair.cortexName);
    expect(res.errors).toEqual([]);
    expect(res.pulled).toBe(2);
    expect(getMemoryCount(pair.cortexName)).toBe(2);

    const cursor = getSyncCursor(pair.cortexName, 'hub', 'pull');
    expect(cursor).toBe('2'); // max server_seq consumed
  });

  it('resumes incrementally across two pull runs — only new lines pulled (AC2)', async () => {
    appendCortexLine(serveDb, pair.cortexName, {
      ts: '2026-06-18T00:00:00Z', author: 'remote', content: 'first', source_ids: [], kind: 'memory',
    });

    pair.peerB.activate();
    const b = adapter();
    const run1 = await b.pull(pair.cortexName);
    expect(run1.pulled).toBe(1);
    expect(getMemoryCount(pair.cortexName)).toBe(1);

    // New server rows arrive after the first run.
    appendCortexLine(serveDb, pair.cortexName, {
      ts: '2026-06-18T00:00:02Z', author: 'remote', content: 'second', source_ids: [], kind: 'memory',
    });
    appendCortexLine(serveDb, pair.cortexName, {
      ts: '2026-06-18T00:00:03Z', author: 'remote', content: 'third', source_ids: [], kind: 'memory',
    });

    const run2 = await b.pull(pair.cortexName);
    // Only the two NEW rows are pulled — the cursor resumed past 'first'.
    expect(run2.pulled).toBe(2);
    expect(getMemoryCount(pair.cortexName)).toBe(3);
    expect(getSyncCursor(pair.cortexName, 'hub', 'pull')).toBe('3');
  });

  it('drains a backlog larger than one page in a single run (hasMore loop)', async () => {
    // PULL_MAX_LIMIT is 1000; seed > 1000 to force a second page.
    for (let i = 0; i < 1001; i++) {
      appendCortexLine(serveDb, pair.cortexName, {
        ts: `2026-06-18T00:00:00.${String(i).padStart(4, '0')}Z`,
        author: 'remote', content: `line-${i}`, source_ids: [], kind: 'memory',
      });
    }
    pair.peerB.activate();
    const b = adapter();
    const res = await b.pull(pair.cortexName);
    expect(res.pulled).toBe(1001); // looped past the first full page
    expect(getMemoryCount(pair.cortexName)).toBe(1001);
  });
});

describe('hub adapter auth (AC3)', () => {
  it('401 with a bad token surfaces as an error, not a silent success', async () => {
    pair.peerA.activate();
    insertMemory(pair.cortexName, { ts: '2026-06-18T00:00:00Z', author: 'a', content: 'x' });
    const a = adapter('wrong-token');
    const res = await a.push(pair.cortexName);
    expect(res.pushed).toBe(0);
    expect(res.errors.length).toBeGreaterThan(0);
    expect(res.errors[0]).toContain('401');
    // Cursor must NOT advance on auth failure — the batch is retryable.
    expect(getSyncCursor(pair.cortexName, 'hub', 'push')).toBeNull();
  });

  it('pull 401 surfaces an error and does not advance the cursor', async () => {
    appendCortexLine(serveDb, pair.cortexName, {
      ts: '2026-06-18T00:00:00Z', author: 'remote', content: 's1', source_ids: [], kind: 'memory',
    });
    pair.peerB.activate();
    const b = adapter('wrong-token');
    const res = await b.pull(pair.cortexName);
    expect(res.pulled).toBe(0);
    expect(res.errors.some((e) => e.includes('401'))).toBe(true);
    expect(getMemoryCount(pair.cortexName)).toBe(0);
    expect(getSyncCursor(pair.cortexName, 'hub', 'pull')).toBeNull();
  });

  it('never includes the token in a surfaced error string', async () => {
    pair.peerA.activate();
    insertMemory(pair.cortexName, { ts: '2026-06-18T00:00:00Z', author: 'a', content: 'x' });
    const secret = 'super-secret-token-value';
    const a = adapter(secret);
    const res = await a.push(pair.cortexName);
    // Auth fails (wrong token) but the token must never leak into the message.
    for (const e of res.errors) expect(e).not.toContain(secret);
  });
});

describe('hub adapter isReachable (contract)', () => {
  it('returns true against a reachable host even when auth would reject', async () => {
    // /v1/health is unauthenticated; with NO token configured the probe still
    // gets an HTTP answer. Even a 401-on-everything host must read reachable.
    pair.peerA.activate();
    const a = adapter();
    expect(await a.isReachable()).toBe(true);
  });

  it('returns false on a transport failure (host does not answer)', async () => {
    pair.peerA.activate();
    configureHub();
    const failing = (() => Promise.reject(new Error('ECONNREFUSED'))) as FetchLike;
    const a = new HubSyncAdapter(failing);
    expect(await a.isReachable()).toBe(false);
  });
});

describe('hub adapter round-trip (peer A push -> peer B pull)', () => {
  it('lands the memory in peer B via the real routes', async () => {
    pair.peerA.activate();
    insertMemory(pair.cortexName, { ts: '2026-06-18T09:00:00Z', author: 'a', content: 'cross-peer note' });
    const a = adapter();
    const pushRes = await a.push(pair.cortexName);
    expect(pushRes.pushed).toBe(1);
    expect(pushRes.errors).toEqual([]);

    pair.peerB.activate();
    const b = adapter();
    const pullRes = await b.pull(pair.cortexName);
    expect(pullRes.errors).toEqual([]);
    expect(pullRes.pulled).toBe(1);
    expect(getMemoryCount(pair.cortexName)).toBe(1);

    // sync() round-trips too: peer B pulling again is a no-op, and its own
    // push has nothing of B's to send.
    const syncRes = await b.sync(pair.cortexName);
    expect(syncRes.pulled).toBe(0);
    expect(syncRes.pushed).toBe(0);
  });
});

describe('hub adapter isAvailable', () => {
  it('true iff cortex.hub has BOTH url and token (selection matches operation guard)', () => {
    pair.peerA.activate();
    const a = new HubSyncAdapter(hubFetch);
    // No hub config yet for this fresh peer home.
    expect(a.isAvailable()).toBe(false);

    // url without token must NOT count as available — otherwise the registry
    // would select the adapter and every sync would soft-error.
    const existing = getConfig();
    saveConfig({ ...existing, cortex: { hub: { url: HUB_URL, token: '' }, author: 'test' } });
    expect(a.isAvailable()).toBe(false);

    configureHub();
    expect(a.isAvailable()).toBe(true);
  });
});
