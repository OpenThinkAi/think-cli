/**
 * Tests for the CurationLoop — AGT-462 (iterative-learning-v2 §5 M6)
 *
 * Coverage:
 * 1. Scheduled path triggers curation: with a short injected interval and a
 *    stub curate function, the loop fires after the interval and curates every
 *    local cortex except the personal work-log cortex (config.cortex.active).
 * 2. Disabled cadence (curationIntervalHours = 0): start() is a no-op — no
 *    cycle ever fires.
 * 3. stop() prevents further scheduled cycles.
 * 4. A per-cortex curation failure does not abort the others or crash the loop.
 *
 * The interval and the per-cortex curation runner are both injected (the
 * `_intervalMsOverride` / `_curateOverride` seams) so no real sleep, LLM call,
 * or DB access occurs — mirroring the PullLoop / CompactionQueue test pattern.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// listLocalBranches → controllable list of cortex/branch names.
const localBranches: string[] = [];
vi.mock('../../src/lib/git.js', () => ({
  listLocalBranches: vi.fn(() => localBranches.slice()),
}));

// getConfig → controllable active cortex + cadence.
let mockConfig: { cortex?: { active?: string; curationIntervalHours?: number } } = {};
vi.mock('../../src/lib/config.js', () => ({
  getConfig: vi.fn(() => mockConfig),
}));

// daemonLog → swallow (assert nothing, just avoid stderr / fs writes).
vi.mock('../../src/daemon/log.js', () => ({
  daemonLog: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function tick(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CurationLoop', () => {
  beforeEach(() => {
    localBranches.length = 0;
    mockConfig = {};
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('scheduled path triggers curation for repo cortexes, excluding the active cortex', async () => {
    const { CurationLoop } = await import('../../src/daemon/curation-loop.js');

    mockConfig = { cortex: { active: 'personal' } };
    localBranches.push('personal', 'think-cli', 'stamp-cli');

    const curated: string[] = [];
    const loop = new CurationLoop();
    (loop as unknown as { _intervalMsOverride: number })._intervalMsOverride = 10;
    (loop as unknown as { _curateOverride: (c: string) => Promise<void> })._curateOverride =
      async (cortex: string) => { curated.push(cortex); };

    const handle = loop.start();
    // Wait long enough for at least one scheduled cycle (interval=10ms) to fire.
    await tick(60);
    handle.stop();

    // Both repo cortexes curated; the personal work-log cortex is excluded.
    // (The loop reschedules, so a cortex may appear more than once — assert on
    // the unique set, not the call count.)
    const uniqueCurated = [...new Set(curated)].sort();
    expect(uniqueCurated).toEqual(['stamp-cli', 'think-cli']);
    expect(curated).not.toContain('personal');
  });

  it('does not fire on start() and waits at least one interval', async () => {
    const { CurationLoop } = await import('../../src/daemon/curation-loop.js');

    mockConfig = { cortex: { active: 'personal' } };
    localBranches.push('personal', 'think-cli');

    const curated: string[] = [];
    const loop = new CurationLoop();
    (loop as unknown as { _intervalMsOverride: number })._intervalMsOverride = 1000;
    (loop as unknown as { _curateOverride: (c: string) => Promise<void> })._curateOverride =
      async (cortex: string) => { curated.push(cortex); };

    const handle = loop.start();
    // Far less than the 1000ms interval — nothing should have run yet.
    await tick(30);
    handle.stop();

    expect(curated).toEqual([]);
  });

  it('disabled cadence (curationIntervalHours = 0) never fires', async () => {
    const { CurationLoop } = await import('../../src/daemon/curation-loop.js');

    mockConfig = { cortex: { active: 'personal', curationIntervalHours: 0 } };
    localBranches.push('personal', 'think-cli');

    const curated: string[] = [];
    const loop = new CurationLoop();
    // No interval override here — disable semantic must come from config 0.
    (loop as unknown as { _curateOverride: (c: string) => Promise<void> })._curateOverride =
      async (cortex: string) => { curated.push(cortex); };

    const handle = loop.start();
    await tick(60);
    handle.stop();

    expect(curated).toEqual([]);
  });

  it('stop() prevents further scheduled cycles', async () => {
    const { CurationLoop } = await import('../../src/daemon/curation-loop.js');

    mockConfig = { cortex: { active: 'personal' } };
    localBranches.push('personal', 'think-cli');

    let callCount = 0;
    const loop = new CurationLoop();
    (loop as unknown as { _intervalMsOverride: number })._intervalMsOverride = 10;
    (loop as unknown as { _curateOverride: (c: string) => Promise<void> })._curateOverride =
      async () => { callCount++; };

    const handle = loop.start();
    await tick(25); // one or more cycles fire
    handle.stop();
    const countAtStop = callCount;
    await tick(50); // no further cycles should be scheduled

    expect(callCount).toBe(countAtStop);
  });

  it('a per-cortex curation failure does not abort the others or crash the loop', async () => {
    const { CurationLoop } = await import('../../src/daemon/curation-loop.js');

    mockConfig = { cortex: { active: 'personal' } };
    localBranches.push('personal', 'broken', 'think-cli');

    const curated: string[] = [];
    const loop = new CurationLoop();
    (loop as unknown as { _intervalMsOverride: number })._intervalMsOverride = 10;
    (loop as unknown as { _curateOverride: (c: string) => Promise<void> })._curateOverride =
      async (cortex: string) => {
        if (cortex === 'broken') throw new Error('boom');
        curated.push(cortex);
      };

    const handle = loop.start();
    await tick(60);
    handle.stop();

    // 'think-cli' is still curated despite 'broken' throwing.
    expect(curated).toContain('think-cli');
  });
});
