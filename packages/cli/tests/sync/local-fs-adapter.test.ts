import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSyncAdapterContractTests, type AdapterFactory } from './contract.js';
import { LocalFsSyncAdapter } from '../../src/sync/local-fs-adapter.js';
import { saveConfig, getConfig } from '../../src/lib/config.js';
import type { TestPeer } from '../fixtures/peer-pair.js';

interface FsRemote {
  rootPath: string;
}

const factory: AdapterFactory<FsRemote> = {
  label: 'local-fs',

  setupRemote(_cortexName: string): FsRemote {
    const rootPath = mkdtempSync(join(tmpdir(), 'think-fs-remote-'));
    return { rootPath };
  },

  configurePeer(peer: TestPeer, _cortexName: string, remote: FsRemote): void {
    peer.activate();
    const existing = getConfig();
    saveConfig({
      ...existing,
      cortex: {
        fs: { path: remote.rootPath },
        author: `test-peer-${peer.thinkHome.split('/').pop()}`,
      },
    });
  },

  createAdapter() {
    return new LocalFsSyncAdapter();
  },

  teardownRemote(remote: FsRemote): void {
    rmSync(remote.rootPath, { recursive: true, force: true });
  },
};

// The local-fs adapter is the canonical v2 backend — it never propagates
// memory tombstones (clean adapter, no pre-BLOOM-122 emitter to keep
// happy) and its wire format always carries `origin_peer_id` (with
// filename-fallback for external writers that omit it). Both invariants
// are part of the design.
runSyncAdapterContractTests(factory, { enforceImmutableMemories: true, enforceOriginPeerId: true });

// Long-term events ride a parallel codepath in the adapter (separate
// per-peer file, separate cursor, no bucketing) and aren't covered by
// the memory-focused contract suite. This block locks in the round-trip
// + tombstone behaviour, mirroring the http adapter's BLOOM-139 block.
describe('local-fs long-term-event sync', () => {
  let pair: ReturnType<typeof import('../fixtures/peer-pair.js').createPeerPair> | null = null;
  let remote: FsRemote | null = null;

  afterAll(() => {
    if (remote) factory.teardownRemote!(remote);
    pair?.cleanup();
  });

  it('round-trips LT events between two peers (incl. tombstone)', async () => {
    const { createPeerPair } = await import('../fixtures/peer-pair.js');
    const { insertLongTermEvent, tombstoneLongTermEvent, getLongTermEvents } =
      await import('../../src/db/long-term-queries.js');

    pair = createPeerPair();
    remote = factory.setupRemote(pair.cortexName) as FsRemote;
    pair.peerA.activate();
    factory.configurePeer(pair.peerA, pair.cortexName, remote);
    pair.peerB.activate();
    factory.configurePeer(pair.peerB, pair.cortexName, remote);
    const adapter = factory.createAdapter();

    pair.peerA.activate();
    const inserted = insertLongTermEvent(pair.cortexName, {
      ts: '2026-04-30T12:00:00Z',
      author: 'a',
      kind: 'decision',
      title: 'Adopt local-fs',
      content: 'we will use the local-fs backend',
      topics: ['arch'],
    });
    const eventId = inserted.row.id;

    pair.peerA.activate();
    await adapter.sync(pair.cortexName);
    pair.peerB.activate();
    await adapter.sync(pair.cortexName);

    const onB = getLongTermEvents(pair.cortexName);
    expect(onB).toHaveLength(1);
    expect(onB[0].id).toBe(eventId);
    expect(onB[0].title).toBe('Adopt local-fs');

    pair.peerA.activate();
    tombstoneLongTermEvent(pair.cortexName, eventId);

    pair.peerA.activate();
    await adapter.sync(pair.cortexName);
    pair.peerB.activate();
    await adapter.sync(pair.cortexName);

    const liveOnB = getLongTermEvents(pair.cortexName);
    expect(liveOnB).toHaveLength(0);
  });
});

// Retro push/pull rides a parallel codepath (per-peer single JSONL file,
// separate cursors, no bucketing). Tests cover: round-trip, idempotent
// re-run, own-file-excluded, all-fields-preserved, tombstone propagation,
// and two-peers-converge.
describe('local-fs retro sync', () => {
  let pair: ReturnType<typeof import('../fixtures/peer-pair.js').createPeerPair> | null = null;
  let remote: FsRemote | null = null;

  afterEach(() => {
    if (remote) factory.teardownRemote!(remote);
    pair?.cleanup();
    pair = null;
    remote = null;
  });

  it('pushes retros to a per-peer JSONL file and pulls on the other peer', async () => {
    const { createPeerPair } = await import('../fixtures/peer-pair.js');
    const { insertRetro } = await import('../../src/db/retro-queries.js');
    const { existsSync, readdirSync } = await import('node:fs');

    pair = createPeerPair();
    remote = factory.setupRemote(pair.cortexName) as FsRemote;
    pair.peerA.activate();
    factory.configurePeer(pair.peerA, pair.cortexName, remote);
    pair.peerB.activate();
    factory.configurePeer(pair.peerB, pair.cortexName, remote);
    const adapter = factory.createAdapter();

    pair.peerA.activate();
    const r = insertRetro(pair.cortexName, { content: 'always test with real data' });

    await adapter.sync(pair.cortexName);

    // Verify a -retros.jsonl file was written to the shared root.
    const { join } = await import('node:path');
    const cortexDir = join(remote.rootPath, pair.cortexName);
    const files = readdirSync(cortexDir);
    const retroFiles = files.filter(f => f.endsWith('-retros.jsonl'));
    expect(retroFiles).toHaveLength(1);

    // Pull on peer B — the retro should appear in peer B's DB.
    pair.peerB.activate();
    await adapter.sync(pair.cortexName);

    const { getCortexDb } = await import('../../src/db/engrams.js');
    const dbB = getCortexDb(pair.cortexName);
    const row = dbB.prepare('SELECT id, content FROM retros WHERE id = ?').get(r.id) as { id: string; content: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.content).toBe('always test with real data');
  });

  it('preserves all wire-format fields across the round-trip', async () => {
    const { createPeerPair } = await import('../fixtures/peer-pair.js');
    const { insertRetro } = await import('../../src/db/retro-queries.js');

    pair = createPeerPair();
    remote = factory.setupRemote(pair.cortexName) as FsRemote;
    pair.peerA.activate();
    factory.configurePeer(pair.peerA, pair.cortexName, remote);
    pair.peerB.activate();
    factory.configurePeer(pair.peerB, pair.cortexName, remote);
    const adapter = factory.createAdapter();

    pair.peerA.activate();
    const peerAId = (await import('../../src/lib/config.js')).getPeerId();
    const r = insertRetro(pair.cortexName, {
      content: 'use explicit cortex names in all DB calls',
      kind: 'convention',
    });
    expect(r.origin_peer_id).toBe(peerAId);

    pair.peerA.activate();
    await adapter.sync(pair.cortexName);
    pair.peerB.activate();
    await adapter.sync(pair.cortexName);

    const { getCortexDb } = await import('../../src/db/engrams.js');
    const dbB = getCortexDb(pair.cortexName);
    const row = dbB.prepare('SELECT * FROM retros WHERE id = ?').get(r.id) as {
      id: string; content: string; kind: string; created_at: string;
      occurrences: number; origin_peer_id: string;
    } | undefined;
    expect(row).toBeDefined();
    expect(row!.kind).toBe('convention');
    expect(row!.occurrences).toBe(1);
    expect(row!.origin_peer_id).toBe(peerAId);
    expect(row!.created_at).toBe(r.created_at);
  });

  it('idempotent — re-syncing does not duplicate rows', async () => {
    const { createPeerPair } = await import('../fixtures/peer-pair.js');
    const { insertRetro } = await import('../../src/db/retro-queries.js');

    pair = createPeerPair();
    remote = factory.setupRemote(pair.cortexName) as FsRemote;
    pair.peerA.activate();
    factory.configurePeer(pair.peerA, pair.cortexName, remote);
    pair.peerB.activate();
    factory.configurePeer(pair.peerB, pair.cortexName, remote);
    const adapter = factory.createAdapter();

    pair.peerA.activate();
    insertRetro(pair.cortexName, { content: 'idempotent push test' });

    pair.peerA.activate();
    await adapter.sync(pair.cortexName);
    pair.peerB.activate();
    await adapter.sync(pair.cortexName);
    // Pull again — cursor should prevent re-ingestion.
    await adapter.sync(pair.cortexName);

    const { getCortexDb } = await import('../../src/db/engrams.js');
    const dbB = getCortexDb(pair.cortexName);
    const count = (dbB.prepare('SELECT COUNT(*) as c FROM retros').get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('own peer file is excluded from pull', async () => {
    const { createPeerPair } = await import('../fixtures/peer-pair.js');
    const { insertRetro } = await import('../../src/db/retro-queries.js');

    pair = createPeerPair();
    remote = factory.setupRemote(pair.cortexName) as FsRemote;
    pair.peerA.activate();
    factory.configurePeer(pair.peerA, pair.cortexName, remote);
    const adapter = factory.createAdapter();

    pair.peerA.activate();
    insertRetro(pair.cortexName, { content: 'peer A retro' });
    await adapter.sync(pair.cortexName); // push writes own file

    // Sync again — own file must not cause duplicate ingestion.
    const result = await adapter.sync(pair.cortexName);
    expect(result.errors).toHaveLength(0);

    const { getCortexDb } = await import('../../src/db/engrams.js');
    const dbA = getCortexDb(pair.cortexName);
    const count = (dbA.prepare('SELECT COUNT(*) as c FROM retros').get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('propagates tombstones (curator merge) across peers', async () => {
    const { createPeerPair } = await import('../fixtures/peer-pair.js');
    const { insertRetro, mergeRetro } = await import('../../src/db/retro-queries.js');

    pair = createPeerPair();
    remote = factory.setupRemote(pair.cortexName) as FsRemote;
    pair.peerA.activate();
    factory.configurePeer(pair.peerA, pair.cortexName, remote);
    pair.peerB.activate();
    factory.configurePeer(pair.peerB, pair.cortexName, remote);
    const adapter = factory.createAdapter();

    // Seed both peers with two retros.
    pair.peerA.activate();
    const r1 = insertRetro(pair.cortexName, { content: 'canonical retro' });
    const r2 = insertRetro(pair.cortexName, { content: 'duplicate retro' });

    pair.peerA.activate();
    await adapter.sync(pair.cortexName);
    pair.peerB.activate();
    await adapter.sync(pair.cortexName);

    // Curator on peer A merges r2 into r1 (tombstones r2).
    pair.peerA.activate();
    mergeRetro(pair.cortexName, r1.id, r2.id);

    pair.peerA.activate();
    await adapter.sync(pair.cortexName);
    pair.peerB.activate();
    await adapter.sync(pair.cortexName);

    const { getCortexDb } = await import('../../src/db/engrams.js');
    const dbB = getCortexDb(pair.cortexName);
    const r2Row = dbB.prepare('SELECT tombstoned_at, tombstone_reason FROM retros WHERE id = ?').get(r2.id) as {
      tombstoned_at: string | null;
      tombstone_reason: string | null;
    } | undefined;
    expect(r2Row).toBeDefined();
    expect(r2Row!.tombstoned_at).toBeTruthy();
    expect(r2Row!.tombstone_reason).toBe(`merged_into:${r1.id}`);
  });

  it('two peers converge when both write retros', async () => {
    const { createPeerPair } = await import('../fixtures/peer-pair.js');
    const { insertRetro } = await import('../../src/db/retro-queries.js');

    pair = createPeerPair();
    remote = factory.setupRemote(pair.cortexName) as FsRemote;
    pair.peerA.activate();
    factory.configurePeer(pair.peerA, pair.cortexName, remote);
    pair.peerB.activate();
    factory.configurePeer(pair.peerB, pair.cortexName, remote);
    const adapter = factory.createAdapter();

    pair.peerA.activate();
    const rA = insertRetro(pair.cortexName, { content: 'peer A insight' });
    pair.peerB.activate();
    const rB = insertRetro(pair.cortexName, { content: 'peer B insight' });

    // Each peer pushes its own retro.
    pair.peerA.activate();
    await adapter.sync(pair.cortexName);
    pair.peerB.activate();
    await adapter.sync(pair.cortexName);
    // Second round to pull what the other peer pushed.
    pair.peerA.activate();
    await adapter.sync(pair.cortexName);

    const { getCortexDb } = await import('../../src/db/engrams.js');
    const dbA = getCortexDb(pair.cortexName);
    const idsOnA = (dbA.prepare('SELECT id FROM retros').all() as { id: string }[]).map(r => r.id);
    expect(idsOnA).toContain(rA.id);
    expect(idsOnA).toContain(rB.id);

    pair.peerB.activate();
    const dbB = getCortexDb(pair.cortexName);
    const idsOnB = (dbB.prepare('SELECT id FROM retros').all() as { id: string }[]).map(r => r.id);
    expect(idsOnB).toContain(rA.id);
    expect(idsOnB).toContain(rB.id);
  });

  it('cursor advances correctly — second push sends only new retros', async () => {
    const { createPeerPair } = await import('../fixtures/peer-pair.js');
    const { insertRetro } = await import('../../src/db/retro-queries.js');
    const { existsSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');

    pair = createPeerPair();
    remote = factory.setupRemote(pair.cortexName) as FsRemote;
    pair.peerA.activate();
    factory.configurePeer(pair.peerA, pair.cortexName, remote);
    const adapter = factory.createAdapter();

    pair.peerA.activate();
    insertRetro(pair.cortexName, { content: 'first retro' });
    await adapter.sync(pair.cortexName);

    const peerId = (await import('../../src/lib/config.js')).getPeerId();
    const retroFile = join(remote.rootPath, pair.cortexName, `${peerId}-retros.jsonl`);
    const contentAfterFirst = readFileSync(retroFile, 'utf-8');
    const lineCountAfterFirst = contentAfterFirst.split('\n').filter(l => l.length > 0).length;
    expect(lineCountAfterFirst).toBe(1);

    pair.peerA.activate();
    insertRetro(pair.cortexName, { content: 'second retro' });
    await adapter.sync(pair.cortexName);

    const contentAfterSecond = readFileSync(retroFile, 'utf-8');
    const linesAfterSecond = contentAfterSecond.split('\n').filter(l => l.length > 0).length;
    expect(linesAfterSecond).toBe(2);
  });
});
