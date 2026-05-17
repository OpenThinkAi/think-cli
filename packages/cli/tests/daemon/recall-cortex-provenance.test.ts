/**
 * Tests for cortex provenance on every recall result — AGT-307
 *
 * Verifies the load-bearing invariant: every entry returned by the recall
 * RPC carries a non-empty `cortex` field that correctly identifies which
 * cortex produced it.
 *
 * Covers:
 *   AC1  — recall RPC return shape includes `cortex` on every entry
 *   AC5  — federated recall with results from 2 cortexes: cortex field is
 *           correct on each result
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
import { insertMemory } from '../../src/db/memory-queries.js';
import { handleRecall } from '../../src/daemon/recall.js';
import type { RecallEntry } from '../../src/daemon/recall.js';
import * as embedModule from '../../src/lib/embed.js';
import * as gitModule from '../../src/lib/git.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const DIM = 3;

function axis(pos: number): Float32Array {
  const v = new Float32Array(DIM);
  v[pos % DIM] = 1.0;
  return v;
}

function toBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

const CORTEX_A = 'provenance-cortex-a';
const CORTEX_B = 'provenance-cortex-b';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('cortex provenance on recall results (AGT-307)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-provenance-'));
    process.env.THINK_HOME = tmpHome;
    closeAllCortexDbs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeAllCortexDbs();
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  // ── AC1 + AC5: every entry from both cortexes carries the correct cortex name

  it('federated recall: every result from cortex-a carries cortex="provenance-cortex-a", every result from cortex-b carries cortex="provenance-cortex-b"', async () => {
    const dbA = getCortexDb(CORTEX_A);
    const idsA: string[] = [];
    for (let i = 0; i < 3; i++) {
      const row = insertMemory(CORTEX_A, {
        ts: new Date().toISOString(),
        author: 'test',
        content: `cortex-a entry ${i}`,
      });
      dbA.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
        .run(toBlob(axis(0)), row.id);
      idsA.push(row.id);
    }

    const dbB = getCortexDb(CORTEX_B);
    const idsB: string[] = [];
    for (let i = 0; i < 3; i++) {
      const row = insertMemory(CORTEX_B, {
        ts: new Date().toISOString(),
        author: 'test',
        content: `cortex-b entry ${i}`,
      });
      // Both cortexes point at axis(0) so both contribute results.
      dbB.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
        .run(toBlob(axis(0)), row.id);
      idsB.push(row.id);
    }

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    vi.spyOn(gitModule, 'listLocalBranches').mockReturnValue([CORTEX_A, CORTEX_B]);

    const results = await handleRecall({ query: 'test', limit: 20 });

    // Must have results from both cortexes
    const cortexAResults = results.filter((r: RecallEntry) => r.cortex === CORTEX_A);
    const cortexBResults = results.filter((r: RecallEntry) => r.cortex === CORTEX_B);
    expect(cortexAResults.length).toBeGreaterThan(0);
    expect(cortexBResults.length).toBeGreaterThan(0);

    // Every cortex-a result id must be from cortex-a, not cortex-b
    for (const r of cortexAResults) {
      expect(idsA).toContain(r.id);
      expect(idsB).not.toContain(r.id);
    }

    // Every cortex-b result id must be from cortex-b, not cortex-a
    for (const r of cortexBResults) {
      expect(idsB).toContain(r.id);
      expect(idsA).not.toContain(r.id);
    }
  });

  // ── AC1: cortex field is non-empty on every result (no entry escapes without provenance)

  it('no result entry has an empty or missing cortex field', async () => {
    const dbA = getCortexDb(CORTEX_A);
    for (let i = 0; i < 4; i++) {
      const row = insertMemory(CORTEX_A, {
        ts: new Date().toISOString(),
        author: 'test',
        content: `a${i}`,
      });
      dbA.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
        .run(toBlob(axis(0)), row.id);
    }

    const dbB = getCortexDb(CORTEX_B);
    for (let i = 0; i < 4; i++) {
      const row = insertMemory(CORTEX_B, {
        ts: new Date().toISOString(),
        author: 'test',
        content: `b${i}`,
      });
      dbB.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
        .run(toBlob(axis(1)), row.id);
    }

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    vi.spyOn(gitModule, 'listLocalBranches').mockReturnValue([CORTEX_A, CORTEX_B]);

    const results = await handleRecall({ query: 'test', limit: 20 });
    expect(results.length).toBeGreaterThan(0);

    for (const r of results) {
      expect(typeof r.cortex).toBe('string');
      expect(r.cortex.length).toBeGreaterThan(0);
    }
  });

  // ── single-cortex path: cortex field is still present when scope="active"

  it('single-cortex path (scope=active): cortex field present and correct on every result', async () => {
    const dbA = getCortexDb(CORTEX_A);
    for (let i = 0; i < 3; i++) {
      const row = insertMemory(CORTEX_A, {
        ts: new Date().toISOString(),
        author: 'test',
        content: `entry ${i}`,
      });
      dbA.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
        .run(toBlob(axis(0)), row.id);
    }

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    const results = await handleRecall({
      query: 'test',
      cortex: CORTEX_A,
      scope: 'active',
    });

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.cortex).toBe(CORTEX_A);
    }
  });
});
