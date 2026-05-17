/**
 * Tests for searchVectors (AGT-275).
 *
 * Fixture: 5 unit vectors in 3-d space, all L2-normalized. Query with the
 * vector closest to fixture[0] — both engines must return fixture[0] as top-1.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
import { insertMemory } from '../../src/db/memory-queries.js';
import { searchVectors } from '../../src/lib/search-vectors.js';
import { getConfig, saveConfig } from '../../src/lib/config.js';

// Five 3-d L2-normalized vectors. Each is a unit vector pointing in a
// distinct direction — cosine similarities between distinct fixtures are 0.
const DIM = 3;

// Returns a Float32Array unit vector with 1.0 at `axis`, zeros elsewhere.
function axis(i: number): Float32Array {
  const v = new Float32Array(DIM);
  v[i % DIM] = 1.0;
  return v;
}

// Returns a 384-byte BLOB for the given 3-d vector padded with zeros.
// The memory table expects 384-dim embeddings (1536 bytes), but for the
// test we work with 3-d to keep fixture data trivial. Both engines operate
// on whatever dimension the stored BLOBs have; the only constraint is that
// query and stored vectors share the same length.
function toBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer);
}

const FIXTURES: Array<{ content: string; vec: Float32Array }> = [
  { content: 'fixture-a (x-axis)', vec: axis(0) }, // [1,0,0]
  { content: 'fixture-b (y-axis)', vec: axis(1) }, // [0,1,0]
  { content: 'fixture-c (z-axis)', vec: axis(2) }, // [0,0,1]
  { content: 'fixture-d (neg-x)', vec: new Float32Array([-1, 0, 0]) },
  { content: 'fixture-e (neg-y)', vec: new Float32Array([0, -1, 0]) },
];

describe('searchVectors (AGT-275)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;
  const cortex = 'search-vec-test';
  const fixtureIds: string[] = [];

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-search-vec-'));
    process.env.THINK_HOME = tmpHome;
    closeAllCortexDbs();

    const db = getCortexDb(cortex);

    // Insert 5 fixture rows with embeddings.
    fixtureIds.length = 0;
    for (const { content, vec } of FIXTURES) {
      const blob = toBlob(vec);
      const row = insertMemory(cortex, {
        ts: new Date().toISOString(),
        author: 'test',
        content,
      });
      // Manually set the embedding since insertMemory doesn't accept it yet.
      db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(blob, row.id);
      fixtureIds.push(row.id);
    }
  });

  afterEach(() => {
    closeAllCortexDbs();
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('brute-force: returns top-1 with highest cosine similarity', () => {
    // Reset to default engine.
    const cfg = getConfig();
    if (cfg.search) cfg.search.engine = 'brute-force';
    saveConfig(cfg);

    // Query with [1, 0, 0] — should match fixture-a (id[0]) with sim=1.0.
    const results = searchVectors(cortex, axis(0), 3);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe(fixtureIds[0]);
    expect(results[0].similarity).toBeCloseTo(1.0, 5);
  });

  it('brute-force: top-1 for y-axis query is fixture-b', () => {
    const cfg = getConfig();
    if (cfg.search) cfg.search.engine = 'brute-force';
    saveConfig(cfg);

    const results = searchVectors(cortex, axis(1), 1);
    expect(results[0].id).toBe(fixtureIds[1]);
    expect(results[0].similarity).toBeCloseTo(1.0, 5);
  });

  it('brute-force: returns at most `limit` results', () => {
    const results = searchVectors(cortex, axis(0), 2);
    expect(results.length).toBe(2);
  });

  it('brute-force vs sqlite-vec: same top-1 for x-axis query', () => {
    // Brute-force baseline.
    const cfg = getConfig();
    cfg.search = { engine: 'brute-force' };
    saveConfig(cfg);
    const bfResults = searchVectors(cortex, axis(0), 1);

    // sqlite-vec (may fall back to brute-force if extension unavailable —
    // that's fine; the contract is "same top-1 result regardless of engine").
    cfg.search = { engine: 'sqlite-vec' };
    saveConfig(cfg);
    const svResults = searchVectors(cortex, axis(0), 1);

    expect(svResults[0].id).toBe(bfResults[0].id);
  });
});
