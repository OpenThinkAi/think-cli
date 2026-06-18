/**
 * Tests for the PruneLoop — scheduled embedding reclamation per cortex.
 *
 * The interval, first-fire delay, and per-cortex prune runner are all injected
 * (`_intervalMsOverride` / `_firstDelayMsOverride` / `_pruneOverride` seams) so
 * no real sleep, SQLite access, or VACUUM occurs — mirroring the CurationLoop
 * test pattern.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// listKnownCortexes → controllable list; getCortexDb stubbed (never called when
// the prune runner is overridden).
const knownCortexes: string[] = [];
vi.mock('../../src/db/engrams.js', () => ({
  listKnownCortexes: vi.fn(() => knownCortexes.slice()),
  getCortexDb: vi.fn(() => { throw new Error('getCortexDb should not be called with _pruneOverride'); }),
}));

// getConfig → controllable cadence + grace.
let mockConfig: { cortex?: { pruneIntervalHours?: number; pruneSupersededGraceDays?: number } } = {};
vi.mock('../../src/lib/config.js', () => ({
  getConfig: vi.fn(() => mockConfig),
}));

// reindexingCortexes → a real Set the test controls.
const reindexingCortexes = new Set<string>();
vi.mock('../../src/daemon/embed-model-check.js', () => ({ reindexingCortexes }));

// daemonLog → swallow.
vi.mock('../../src/daemon/log.js', () => ({ daemonLog: vi.fn() }));

async function tick(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

type Seams = {
  _intervalMsOverride: number;
  _firstDelayMsOverride: number;
  _pruneOverride: (cortex: string, graceDays: number) => void;
};

describe('PruneLoop', () => {
  beforeEach(() => {
    knownCortexes.length = 0;
    reindexingCortexes.clear();
    mockConfig = {};
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('scheduled path prunes every known cortex', async () => {
    const { PruneLoop } = await import('../../src/daemon/embedding-prune-loop.js');
    knownCortexes.push('personal', 'think-cli', 'stamp-cli');

    const pruned: string[] = [];
    const loop = new PruneLoop();
    const seams = loop as unknown as Seams;
    seams._intervalMsOverride = 10;
    seams._firstDelayMsOverride = 5;
    seams._pruneOverride = (cortex: string) => { pruned.push(cortex); };

    const handle = loop.start();
    await tick(60);
    handle.stop();

    expect([...new Set(pruned)].sort()).toEqual(['personal', 'stamp-cli', 'think-cli']);
  });

  it('passes the configured grace window through to the prune runner', async () => {
    const { PruneLoop } = await import('../../src/daemon/embedding-prune-loop.js');
    knownCortexes.push('personal');
    mockConfig = { cortex: { pruneSupersededGraceDays: 30 } };

    const graces: number[] = [];
    const loop = new PruneLoop();
    const seams = loop as unknown as Seams;
    seams._intervalMsOverride = 10;
    seams._firstDelayMsOverride = 5;
    seams._pruneOverride = (_cortex: string, graceDays: number) => { graces.push(graceDays); };

    const handle = loop.start();
    await tick(40);
    handle.stop();

    expect(graces.every(g => g === 30)).toBe(true);
    expect(graces.length).toBeGreaterThan(0);
  });

  it('disabled cadence (pruneIntervalHours = 0) never fires', async () => {
    const { PruneLoop } = await import('../../src/daemon/embedding-prune-loop.js');
    knownCortexes.push('personal');
    mockConfig = { cortex: { pruneIntervalHours: 0 } };

    const pruned: string[] = [];
    const loop = new PruneLoop();
    const seams = loop as unknown as Seams;
    seams._firstDelayMsOverride = 5; // no interval override → disable comes from config 0
    seams._pruneOverride = (cortex: string) => { pruned.push(cortex); };

    const handle = loop.start();
    await tick(60);
    handle.stop();

    expect(pruned).toEqual([]);
  });

  it('skips cortexes that are currently reindexing', async () => {
    const { PruneLoop } = await import('../../src/daemon/embedding-prune-loop.js');
    knownCortexes.push('personal', 'busy');
    reindexingCortexes.add('busy');

    const pruned: string[] = [];
    const loop = new PruneLoop();
    const seams = loop as unknown as Seams;
    seams._intervalMsOverride = 10;
    seams._firstDelayMsOverride = 5;
    seams._pruneOverride = (cortex: string) => { pruned.push(cortex); };

    const handle = loop.start();
    await tick(40);
    handle.stop();

    expect(pruned).not.toContain('busy');
    expect(pruned).toContain('personal');
  });

  it('a per-cortex failure does not abort the others', async () => {
    const { PruneLoop } = await import('../../src/daemon/embedding-prune-loop.js');
    knownCortexes.push('boom', 'ok');

    const pruned: string[] = [];
    const loop = new PruneLoop();
    const seams = loop as unknown as Seams;
    seams._intervalMsOverride = 10;
    seams._firstDelayMsOverride = 5;
    seams._pruneOverride = (cortex: string) => {
      if (cortex === 'boom') throw new Error('kaboom');
      pruned.push(cortex);
    };

    const handle = loop.start();
    await tick(40);
    handle.stop();

    expect(pruned).toContain('ok');
  });

  it('stop() prevents further scheduled cycles', async () => {
    const { PruneLoop } = await import('../../src/daemon/embedding-prune-loop.js');
    knownCortexes.push('personal');

    let callCount = 0;
    const loop = new PruneLoop();
    const seams = loop as unknown as Seams;
    seams._intervalMsOverride = 10;
    seams._firstDelayMsOverride = 5;
    seams._pruneOverride = () => { callCount++; };

    const handle = loop.start();
    await tick(25);
    handle.stop();
    const countAtStop = callCount;
    await tick(40);

    expect(callCount).toBe(countAtStop);
  });
});
