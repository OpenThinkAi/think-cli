/**
 * Tests for federated recall across multiple cortexes — AGT-306
 *
 * Strategy:
 *   - Create two isolated cortex DBs (cortex-a, cortex-b) in a tmp THINK_HOME.
 *   - Populate cortex-a with 10 entries pointing at axis(0).
 *   - Populate cortex-b with 10 entries: 9 pointing at axis(1), 1 pointing at
 *     axis(0) (the "target" — the entry that should surface for an axis(0) query).
 *   - Mock embed() to return axis(0) (query closest to cortex-b's target entry).
 *   - Mock listRemoteBranches() to return ['cortex-a', 'cortex-b'].
 *   - Call handleRecall({ query: 'test' }) — default scope is "accessible".
 *   - Assert: results include at least one entry from cortex-b with cortex='cortex-b'.
 *
 * This validates AC5 (parallel queries), AC6 (cortex name on each result), and
 * AC8 (results from cortex B rank correctly with cortex name attached).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
import { insertMemory } from '../../src/db/memory-queries.js';
import { handleRecall } from '../../src/daemon/recall.js';
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

const CORTEX_A = 'cortex-a';
const CORTEX_B = 'cortex-b';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('handleRecall — federated recall (AGT-306)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-federated-'));
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

  // ── AC8: query present only in cortex-b ranks correctly ─────────────────

  it('surfaces results from cortex-b when query is only present in cortex-b, with correct cortex name', async () => {
    // cortex-a: 10 entries pointing at axis(0) — these are the "noisy" matches
    // for a query vector of axis(0) that we don't want to crowd out cortex-b.
    // We'll query with axis(1) so cortex-b's target (axis(1)) rises to the top.
    const dbA = getCortexDb(CORTEX_A);
    for (let i = 0; i < 10; i++) {
      const row = insertMemory(CORTEX_A, {
        ts: new Date().toISOString(),
        author: 'test',
        content: `cortex-a entry ${i}`,
      });
      // cortex-a entries point at axis(0); query vector will be axis(1)
      dbA.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
        .run(toBlob(axis(0)), row.id);
    }

    // cortex-b: 9 entries pointing at axis(2) + 1 "target" pointing at axis(1)
    // Query vector will be axis(1), so the target is the closest entry in cortex-b.
    const dbB = getCortexDb(CORTEX_B);
    let targetId: string | undefined;
    for (let i = 0; i < 10; i++) {
      const row = insertMemory(CORTEX_B, {
        ts: new Date().toISOString(),
        author: 'test',
        content: i === 0 ? 'target-only-in-cortex-b' : `cortex-b filler ${i}`,
      });
      // The first entry is the "target" — closest to query vector axis(1).
      const vec = i === 0 ? axis(1) : axis(2);
      dbB.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
        .run(toBlob(vec), row.id);
      if (i === 0) targetId = row.id;
    }

    // Mock: embed() returns axis(1) — matches the target in cortex-b
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(1));

    // Mock: listRemoteBranches() returns our two test cortexes
    vi.spyOn(gitModule, 'listRemoteBranches').mockReturnValue([CORTEX_A, CORTEX_B]);

    // Default scope is "accessible" — should fan out to both cortexes
    const results = await handleRecall({ query: 'target-only-in-cortex-b', limit: 20 });

    expect(results.length).toBeGreaterThan(0);

    // The results must contain the target entry from cortex-b
    const targetResult = results.find((r) => r.id === targetId);
    expect(targetResult).toBeDefined();
    expect(targetResult!.cortex).toBe(CORTEX_B);
    expect(targetResult!.content).toBe('target-only-in-cortex-b');

    // The target should rank #1 — it has cosine=1.0 (axis(1) vs axis(1))
    // while all cortex-a entries have cosine=0 (axis(0) vs axis(1))
    expect(results[0].id).toBe(targetId);
    expect(results[0].cortex).toBe(CORTEX_B);
    expect(results[0].similarity).toBeCloseTo(1.0, 4);
  });

  // ── AC5: per-cortex results carry cortex name ────────────────────────────

  it('every result entry carries the cortex name it came from', async () => {
    const dbA = getCortexDb(CORTEX_A);
    for (let i = 0; i < 5; i++) {
      const row = insertMemory(CORTEX_A, {
        ts: new Date().toISOString(),
        author: 'test',
        content: `cortex-a entry ${i}`,
      });
      dbA.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
        .run(toBlob(axis(0)), row.id);
    }

    const dbB = getCortexDb(CORTEX_B);
    for (let i = 0; i < 5; i++) {
      const row = insertMemory(CORTEX_B, {
        ts: new Date().toISOString(),
        author: 'test',
        content: `cortex-b entry ${i}`,
      });
      dbB.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
        .run(toBlob(axis(1)), row.id);
    }

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    vi.spyOn(gitModule, 'listRemoteBranches').mockReturnValue([CORTEX_A, CORTEX_B]);

    const results = await handleRecall({ query: 'test', limit: 20 });

    // Every result must have a non-empty cortex field
    for (const r of results) {
      expect(typeof r.cortex).toBe('string');
      expect(r.cortex.length).toBeGreaterThan(0);
      expect([CORTEX_A, CORTEX_B]).toContain(r.cortex);
    }
  });

  // ── scope="accessible" is the default ───────────────────────────────────

  it('default scope fans out to all enumerated cortexes', async () => {
    const dbA = getCortexDb(CORTEX_A);
    const rowA = insertMemory(CORTEX_A, {
      ts: new Date().toISOString(),
      author: 'test',
      content: 'from cortex-a',
    });
    dbA.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
      .run(toBlob(axis(0)), rowA.id);

    const dbB = getCortexDb(CORTEX_B);
    const rowB = insertMemory(CORTEX_B, {
      ts: new Date().toISOString(),
      author: 'test',
      content: 'from cortex-b',
    });
    dbB.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
      .run(toBlob(axis(0)), rowB.id);

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    vi.spyOn(gitModule, 'listRemoteBranches').mockReturnValue([CORTEX_A, CORTEX_B]);

    // No scope param → defaults to "accessible"
    const results = await handleRecall({ query: 'test', limit: 10 });

    const cortexNames = new Set(results.map((r) => r.cortex));
    expect(cortexNames.has(CORTEX_A)).toBe(true);
    expect(cortexNames.has(CORTEX_B)).toBe(true);
  });

  // ── scope="all" behaves same as "accessible" in alpha ───────────────────

  it('scope="all" returns the same results as scope="accessible" (alpha behavior)', async () => {
    const dbA = getCortexDb(CORTEX_A);
    const rowA = insertMemory(CORTEX_A, {
      ts: new Date().toISOString(),
      author: 'test',
      content: 'from cortex-a',
    });
    dbA.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
      .run(toBlob(axis(0)), rowA.id);

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    vi.spyOn(gitModule, 'listRemoteBranches').mockReturnValue([CORTEX_A]);

    const accessibleResults = await handleRecall({ query: 'test', scope: 'accessible' });
    const allResults = await handleRecall({ query: 'test', scope: 'all' });

    // Both must return the same entry ids (order may differ, but here just 1 entry)
    const accessibleIds = accessibleResults.map((r) => r.id).sort();
    const allIds = allResults.map((r) => r.id).sort();
    expect(allIds).toEqual(accessibleIds);
  });

  // ── scope="active" with cortex param skips federation ───────────────────

  it('scope="active" with explicit cortex param queries only that cortex', async () => {
    const dbA = getCortexDb(CORTEX_A);
    const rowA = insertMemory(CORTEX_A, {
      ts: new Date().toISOString(),
      author: 'test',
      content: 'from cortex-a',
    });
    dbA.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
      .run(toBlob(axis(0)), rowA.id);

    const dbB = getCortexDb(CORTEX_B);
    const rowB = insertMemory(CORTEX_B, {
      ts: new Date().toISOString(),
      author: 'test',
      content: 'from cortex-b',
    });
    dbB.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
      .run(toBlob(axis(0)), rowB.id);

    // listRemoteBranches should NOT be called for scope="active"
    const branchSpy = vi.spyOn(gitModule, 'listRemoteBranches');
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    const results = await handleRecall({
      query: 'test',
      cortex: CORTEX_A,
      scope: 'active',
    });

    // Only cortex-a results — cortex-b entries must not appear
    for (const r of results) {
      expect(r.cortex).toBe(CORTEX_A);
    }
    expect(results.some((r) => r.id === rowA.id)).toBe(true);
    expect(results.some((r) => r.id === rowB.id)).toBe(false);

    // listRemoteBranches must not have been called
    expect(branchSpy).not.toHaveBeenCalled();
  });

  // ── explicit cortex with default scope short-circuits federation ─────────

  it('explicit cortex param with default scope (accessible) queries only that cortex', async () => {
    const dbA = getCortexDb(CORTEX_A);
    const rowA = insertMemory(CORTEX_A, {
      ts: new Date().toISOString(),
      author: 'test',
      content: 'from cortex-a',
    });
    dbA.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
      .run(toBlob(axis(0)), rowA.id);

    const dbB = getCortexDb(CORTEX_B);
    const rowB = insertMemory(CORTEX_B, {
      ts: new Date().toISOString(),
      author: 'test',
      content: 'from cortex-b',
    });
    dbB.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
      .run(toBlob(axis(0)), rowB.id);

    const branchSpy = vi.spyOn(gitModule, 'listRemoteBranches');
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    // Explicit cortex + default scope → single cortex, no federation
    const results = await handleRecall({ query: 'test', cortex: CORTEX_A });

    for (const r of results) {
      expect(r.cortex).toBe(CORTEX_A);
    }
    expect(branchSpy).not.toHaveBeenCalled();
  });

  // ── one failing cortex doesn't abort the whole federated query ──────────

  it('partial failure: a broken cortex contributes zero results, others still return', async () => {
    const dbA = getCortexDb(CORTEX_A);
    const rowA = insertMemory(CORTEX_A, {
      ts: new Date().toISOString(),
      author: 'test',
      content: 'from cortex-a',
    });
    dbA.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
      .run(toBlob(axis(0)), rowA.id);

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    // List includes a broken cortex (no DB file) and a healthy one.
    vi.spyOn(gitModule, 'listRemoteBranches').mockReturnValue([
      CORTEX_A,
      'nonexistent-broken-cortex',
    ]);

    // Must not throw — broken cortex is silently ignored.
    const results = await handleRecall({ query: 'test', limit: 10 });

    // Results from cortex-a should still be present.
    expect(results.some((r) => r.cortex === CORTEX_A)).toBe(true);
    expect(results.some((r) => r.cortex === 'nonexistent-broken-cortex')).toBe(false);
  });

  // ── limit is applied globally after merge ────────────────────────────────

  it('global limit is applied after merging results from all cortexes', async () => {
    const dbA = getCortexDb(CORTEX_A);
    for (let i = 0; i < 10; i++) {
      const row = insertMemory(CORTEX_A, {
        ts: new Date().toISOString(),
        author: 'test',
        content: `cortex-a entry ${i}`,
      });
      dbA.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
        .run(toBlob(axis(0)), row.id);
    }

    const dbB = getCortexDb(CORTEX_B);
    for (let i = 0; i < 10; i++) {
      const row = insertMemory(CORTEX_B, {
        ts: new Date().toISOString(),
        author: 'test',
        content: `cortex-b entry ${i}`,
      });
      dbB.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
        .run(toBlob(axis(0)), row.id);
    }

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    vi.spyOn(gitModule, 'listRemoteBranches').mockReturnValue([CORTEX_A, CORTEX_B]);

    // 20 total candidates across 2 cortexes, limit=7
    const results = await handleRecall({ query: 'test', limit: 7 });
    expect(results.length).toBe(7);
  });
});
