import { describe, it, expect, afterAll } from 'vitest';
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
