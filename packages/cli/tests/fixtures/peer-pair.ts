import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';

export interface TestPeer {
  /** Absolute path used as THINK_HOME when this peer is active. */
  thinkHome: string;
  /** Switches global state (THINK_HOME + DB cache) so subsequent calls operate as this peer. */
  activate(): void;
  /** Activates the peer and returns its cortex DB handle. */
  getDb(): DatabaseSync;
}

export interface PeerPair {
  cortexName: string;
  peerA: TestPeer;
  peerB: TestPeer;
  cleanup: () => void;
}

/**
 * Creates two isolated peers (separate THINK_HOMEs) sharing a cortex name.
 * Tests call `peerA.activate()` / `peerB.activate()` to switch which peer is "current"
 * for subsequent in-process operations. This models two machines syncing the same
 * cortex without leaking state between them.
 */
export function createPeerPair(opts: { cortexName?: string } = {}): PeerPair {
  const cortexName = opts.cortexName ?? `test-${randomBytes(4).toString('hex')}`;
  const homeA = mkdtempSync(join(tmpdir(), 'think-peerA-'));
  const homeB = mkdtempSync(join(tmpdir(), 'think-peerB-'));

  const makePeer = (thinkHome: string): TestPeer => ({
    thinkHome,
    activate(): void {
      process.env.THINK_HOME = thinkHome;
      closeAllCortexDbs();
    },
    getDb(): DatabaseSync {
      this.activate();
      return getCortexDb(cortexName);
    },
  });

  const peerA = makePeer(homeA);
  const peerB = makePeer(homeB);

  // Eagerly create both DBs so migrations run once up front.
  peerA.getDb();
  peerB.getDb();

  return {
    cortexName,
    peerA,
    peerB,
    cleanup: () => {
      closeAllCortexDbs();
      rmSync(homeA, { recursive: true, force: true });
      rmSync(homeB, { recursive: true, force: true });
      delete process.env.THINK_HOME;
    },
  };
}
