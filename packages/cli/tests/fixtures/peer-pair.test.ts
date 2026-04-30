import { describe, it, expect, afterEach } from 'vitest';
import { createPeerPair } from './peer-pair.js';
import { insertMemory, getMemoriesBySyncVersion } from '../../src/db/memory-queries.js';

describe('createPeerPair', () => {
  let pair: ReturnType<typeof createPeerPair> | null = null;

  afterEach(() => {
    pair?.cleanup();
    pair = null;
  });

  it('isolates state between the two peers', () => {
    pair = createPeerPair();
    const { cortexName, peerA, peerB } = pair;

    peerA.activate();
    insertMemory(cortexName, {
      ts: '2026-04-29T12:00:00Z',
      author: 'a',
      content: 'written on peer A',
    });

    peerA.activate();
    const aMems = getMemoriesBySyncVersion(cortexName, 0);
    expect(aMems).toHaveLength(1);

    peerB.activate();
    const bMems = getMemoriesBySyncVersion(cortexName, 0);
    expect(bMems).toHaveLength(0);
  });

  it('uses distinct THINK_HOMEs for each peer', () => {
    pair = createPeerPair();
    expect(pair.peerA.thinkHome).not.toBe(pair.peerB.thinkHome);
  });
});
