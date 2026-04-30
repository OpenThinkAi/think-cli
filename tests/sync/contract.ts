import { describe, it, expect, afterEach } from 'vitest';
import { createPeerPair, type TestPeer, type PeerPair } from '../fixtures/peer-pair.js';
import {
  insertMemory,
  insertMemoryIfNotExists,
  tombstoneMemory,
  getMemoriesBySyncVersion,
  getMemoryCount,
  getSyncCursor,
} from '../../src/db/memory-queries.js';
import { deterministicId } from '../../src/lib/deterministic-id.js';
import type { SyncAdapter } from '../../src/sync/types.js';

/**
 * Adapter-specific glue that the contract suite uses to set up a shared
 * "remote" between two peers and to instantiate the adapter for whichever
 * peer is currently active (active = its THINK_HOME is set as the env var).
 *
 * The factory is intentionally minimal: the contract suite owns peer
 * activation, memory creation, and assertion. Adapter authors only need to
 * make the right config visible to `getConfig()` for the active peer.
 */
export interface AdapterFactory<TRemote = unknown> {
  /** Human label for the describe block (e.g. "git", "http"). */
  readonly label: string;

  /** Spin up shared remote infra for one cortex (e.g. tmp bare git repo). */
  setupRemote(cortexName: string): Promise<TRemote> | TRemote;

  /**
   * Make `getConfig()` return a config that points the currently-active peer
   * at the shared remote. Called once per peer after they've been activated.
   */
  configurePeer(peer: TestPeer, cortexName: string, remote: TRemote): Promise<void> | void;

  /** Returns an adapter instance reading from the active peer's config. */
  createAdapter(): SyncAdapter;

  /** Optional teardown of remote-side resources. */
  teardownRemote?(remote: TRemote): Promise<void> | void;
}

interface SuiteOptions {
  /**
   * If true, the suite includes tests that lock in the BLOOM-122 invariants
   * (memories never delete via sync). Today's git adapter still propagates
   * memory tombstones, so it sets this to false; HTTP and relay adapters
   * (which respect the invariant from day one) set it to true.
   */
  enforceImmutableMemories?: boolean;
}

/**
 * Black-box test suite that every SyncAdapter must pass.
 *
 * Run from a per-adapter test file:
 *   runSyncAdapterContractTests({ label: "git", ... });
 */
export function runSyncAdapterContractTests<TRemote>(
  factory: AdapterFactory<TRemote>,
  options: SuiteOptions = {},
): void {
  const enforceImmutableMemories = options.enforceImmutableMemories ?? false;

  describe(`SyncAdapter contract — ${factory.label}`, () => {
    let pair: PeerPair | null = null;
    let remote: TRemote | null = null;

    afterEach(async () => {
      if (remote && factory.teardownRemote) {
        await factory.teardownRemote(remote);
      }
      pair?.cleanup();
      pair = null;
      remote = null;
    });

    async function setup(): Promise<{
      pair: PeerPair;
      remote: TRemote;
      adapter: SyncAdapter;
    }> {
      const newPair = createPeerPair();
      const newRemote = await factory.setupRemote(newPair.cortexName);

      newPair.peerA.activate();
      await factory.configurePeer(newPair.peerA, newPair.cortexName, newRemote);

      newPair.peerB.activate();
      await factory.configurePeer(newPair.peerB, newPair.cortexName, newRemote);

      pair = newPair;
      remote = newRemote;

      return { pair: newPair, remote: newRemote, adapter: factory.createAdapter() };
    }

    function asPeer<T>(peer: TestPeer, fn: () => T): T {
      peer.activate();
      return fn();
    }

    it('propagates an inserted memory from peer A to peer B', async () => {
      const { pair: p, adapter } = await setup();

      asPeer(p.peerA, () => {
        insertMemory(p.cortexName, {
          id: deterministicId('2026-04-29T12:00:00Z', 'a', 'hello from A'),
          ts: '2026-04-29T12:00:00Z',
          author: 'a',
          content: 'hello from A',
        });
      });

      p.peerA.activate();
      const pushResult = await adapter.push(p.cortexName);
      expect(pushResult.errors).toEqual([]);
      expect(pushResult.pushed).toBe(1);

      p.peerB.activate();
      const pullResult = await adapter.pull(p.cortexName);
      expect(pullResult.errors).toEqual([]);
      expect(pullResult.pulled).toBe(1);

      const bMems = asPeer(p.peerB, () => getMemoriesBySyncVersion(p.cortexName, 0));
      expect(bMems).toHaveLength(1);
      expect(bMems[0].content).toBe('hello from A');
    });

    it('idempotent re-pull is a no-op', async () => {
      const { pair: p, adapter } = await setup();

      asPeer(p.peerA, () => {
        insertMemory(p.cortexName, {
          id: deterministicId('2026-04-29T12:00:00Z', 'a', 'one'),
          ts: '2026-04-29T12:00:00Z',
          author: 'a',
          content: 'one',
        });
      });

      p.peerA.activate();
      await adapter.push(p.cortexName);

      p.peerB.activate();
      const first = await adapter.pull(p.cortexName);
      const second = await adapter.pull(p.cortexName);

      expect(first.pulled).toBe(1);
      expect(second.pulled).toBe(0);
      expect(asPeer(p.peerB, () => getMemoryCount(p.cortexName))).toBe(1);
    });

    it('two peers writing disjoint memories converge to the union', async () => {
      const { pair: p, adapter } = await setup();

      asPeer(p.peerA, () => {
        insertMemory(p.cortexName, {
          id: deterministicId('2026-04-29T12:00:00Z', 'a', 'from A'),
          ts: '2026-04-29T12:00:00Z',
          author: 'a',
          content: 'from A',
        });
      });
      asPeer(p.peerB, () => {
        insertMemory(p.cortexName, {
          id: deterministicId('2026-04-29T12:01:00Z', 'b', 'from B'),
          ts: '2026-04-29T12:01:00Z',
          author: 'b',
          content: 'from B',
        });
      });

      p.peerA.activate();
      await adapter.sync(p.cortexName);
      p.peerB.activate();
      await adapter.sync(p.cortexName);
      p.peerA.activate();
      await adapter.sync(p.cortexName);

      const aCount = asPeer(p.peerA, () => getMemoryCount(p.cortexName));
      const bCount = asPeer(p.peerB, () => getMemoryCount(p.cortexName));
      expect(aCount).toBe(2);
      expect(bCount).toBe(2);
    });

    it('content-addressed dedup: same content from two peers becomes one row', async () => {
      const { pair: p, adapter } = await setup();

      // Both peers independently produce a memory with the same (ts, author, content).
      // The deterministic id collapses them into the same row after sync.
      const ts = '2026-04-29T12:00:00Z';
      const author = 'shared';
      const content = 'identical content from two peers';
      const id = deterministicId(ts, author, content);

      asPeer(p.peerA, () => {
        insertMemoryIfNotExists(p.cortexName, { id, ts, author, content });
      });
      asPeer(p.peerB, () => {
        insertMemoryIfNotExists(p.cortexName, { id, ts, author, content });
      });

      p.peerA.activate();
      await adapter.sync(p.cortexName);
      p.peerB.activate();
      await adapter.sync(p.cortexName);
      p.peerA.activate();
      await adapter.sync(p.cortexName);

      expect(asPeer(p.peerA, () => getMemoryCount(p.cortexName))).toBe(1);
      expect(asPeer(p.peerB, () => getMemoryCount(p.cortexName))).toBe(1);
    });

    it('push cursor advances on success', async () => {
      const { pair: p, adapter } = await setup();

      asPeer(p.peerA, () => {
        insertMemory(p.cortexName, {
          id: deterministicId('2026-04-29T12:00:00Z', 'a', 'cursor-test'),
          ts: '2026-04-29T12:00:00Z',
          author: 'a',
          content: 'cursor-test',
        });
      });

      p.peerA.activate();
      const before = getSyncCursor(p.cortexName, factory.label, 'push');
      await adapter.push(p.cortexName);
      const after = getSyncCursor(p.cortexName, factory.label, 'push');

      // We don't assert a specific value (each adapter chooses its cursor format),
      // only that something advanced. Adapters that do not use sync_cursors with
      // their label should override this test in adapter-specific suites.
      expect(after).not.toBe(before);
    });

    it('engrams never propagate to the other peer', async () => {
      const { pair: p, adapter } = await setup();

      asPeer(p.peerA, () => {
        const db = p.peerA.getDb();
        db.prepare(
          `INSERT INTO engrams (id, content, created_at, expires_at)
           VALUES (?, ?, ?, ?)`,
        ).run('eng-1', 'private engram on A', '2026-04-29T12:00:00Z', '2026-05-29T12:00:00Z');
      });

      p.peerA.activate();
      await adapter.sync(p.cortexName);
      p.peerB.activate();
      await adapter.sync(p.cortexName);

      const bEngrams = asPeer(p.peerB, () => {
        const db = p.peerB.getDb();
        return db.prepare('SELECT id FROM engrams').all() as { id: string }[];
      });
      expect(bEngrams).toHaveLength(0);
    });

    (enforceImmutableMemories ? it : it.skip)(
      'memory tombstones do NOT propagate (memories are immutable via sync)',
      async () => {
        const { pair: p, adapter } = await setup();

        const id = deterministicId('2026-04-29T12:00:00Z', 'a', 'will be tombstoned');
        asPeer(p.peerA, () => {
          insertMemory(p.cortexName, {
            id,
            ts: '2026-04-29T12:00:00Z',
            author: 'a',
            content: 'will be tombstoned',
          });
        });

        // Sync the insert to peer B first.
        p.peerA.activate();
        await adapter.push(p.cortexName);
        p.peerB.activate();
        await adapter.pull(p.cortexName);
        expect(asPeer(p.peerB, () => getMemoryCount(p.cortexName))).toBe(1);

        // Now A tombstones locally — this must NOT propagate.
        asPeer(p.peerA, () => tombstoneMemory(p.cortexName, id));

        p.peerA.activate();
        await adapter.sync(p.cortexName);
        p.peerB.activate();
        await adapter.sync(p.cortexName);

        // B's copy is still intact.
        expect(asPeer(p.peerB, () => getMemoryCount(p.cortexName))).toBe(1);
      },
    );
  });
}
