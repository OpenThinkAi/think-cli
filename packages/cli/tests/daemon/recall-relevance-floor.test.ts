/**
 * Recall relevance floor tests — AGT-456 (iterative-learning-v2 design §5 M2).
 *
 * The floor is an absolute cosine-similarity cutoff applied to the RAW cosine
 * BEFORE recency reweighting. Candidates below the floor are excluded entirely,
 * so a sparse cortex returns zero entries rather than a top-K of garbage-tier
 * "best of a bad bunch" matches.
 *
 * Coverage:
 *   - AC1/AC3: sub-floor candidates are dropped; a query with no above-floor
 *     match returns zero entries (not low-similarity junk).
 *   - AC1: above-floor candidates pass; at-floor (==) candidates pass.
 *   - AC2: the floor is config-tunable via config.recall.relevanceFloor, and
 *     setting it ≤ -1 disables filtering.
 *   - AC2: the floor does NOT apply to the FTS-fallback path (no_embed) — those
 *     results carry similarity=0 and must still surface.
 *   - The floor cuts on the raw cosine, not the recency-weighted score: a recent
 *     above-floor entry survives even when its weighted score is small.
 *
 * Strategy mirrors recall-recency.test.ts: mock embed() via vi.spyOn, insert
 * fixtures with hand-built embedding vectors, drive handleRecall.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
import { insertMemory } from '../../src/db/memory-queries.js';
import { handleRecall } from '../../src/daemon/recall.js';
import { saveConfig, getConfig } from '../../src/lib/config.js';
import * as embedModule from '../../src/lib/embed.js';

const DIM = 8;

/** Unit vector with 1.0 at `pos % DIM`. */
function axis(pos: number): Float32Array {
  const v = new Float32Array(DIM);
  v[pos % DIM] = 1.0;
  return v;
}

/**
 * Unit vector whose cosine with axis(0) is exactly `cos`. Puts `cos` on axis 0
 * and sqrt(1-cos^2) on axis 1, so the result is unit-length and
 * dot(axis(0), v) === cos.
 */
function cosToAxis0(cos: number): Float32Array {
  const v = new Float32Array(DIM);
  v[0] = cos;
  v[1] = Math.sqrt(Math.max(0, 1 - cos * cos));
  return v;
}

function toBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

const CORTEX = 'floor-test';

describe('handleRecall — relevance floor (AGT-456)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-floor-'));
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

  /** Insert one entry with the given cosine-to-axis(0) and activity_seq. */
  function insertAt(cos: number, seq: number, content: string): string {
    const db = getCortexDb(CORTEX);
    const row = insertMemory(CORTEX, {
      ts: '2026-05-01T00:00:00Z',
      author: 'test',
      content,
    });
    db.prepare('UPDATE memories SET embedding = ?, activity_seq = ? WHERE id = ?')
      .run(toBlob(cosToAxis0(cos)), seq, row.id);
    return row.id;
  }

  // ── AC1: sub-floor candidates are excluded, above-floor survive ──────────

  it('AC1: excludes candidates below the default 0.6 floor, keeps those at/above', async () => {
    const above = insertAt(0.8, 3, 'high-similarity hit');
    const atFloor = insertAt(0.6, 2, 'exactly at the floor');
    const below = insertAt(0.4, 1, 'sub-floor junk');

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    const results = await handleRecall({ cortex: CORTEX, query: 'q', limit: 50 });

    const ids = results.map((r) => r.id);
    expect(ids).toContain(above);
    expect(ids).toContain(atFloor); // == floor passes (>=)
    expect(ids).not.toContain(below);
  });

  // ── AC3: no above-floor match → zero results, not low-sim junk ───────────

  it('AC3: a query with no above-floor match returns zero entries (not a junk top-K)', async () => {
    // Every entry is well below 0.6 — the classic sparse-cortex junk case.
    insertAt(0.3, 1, 'trigger A');
    insertAt(0.25, 2, 'trigger B');
    insertAt(0.1, 3, 'repro stamp-cli');

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    const results = await handleRecall({ cortex: CORTEX, query: 'q', limit: 50 });

    expect(results.length).toBe(0);
  });

  // ── AC2: config override raises the floor ────────────────────────────────

  it('AC2: config.recall.relevanceFloor override changes the cutoff', async () => {
    const high = insertAt(0.9, 2, 'very similar');
    const mid = insertAt(0.7, 1, 'moderately similar');

    // Raise the floor above 0.7 — only the 0.9 entry should survive.
    saveConfig({ ...getConfig(), recall: { relevanceFloor: 0.85 } });

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    const results = await handleRecall({ cortex: CORTEX, query: 'q', limit: 50 });

    const ids = results.map((r) => r.id);
    expect(ids).toContain(high);
    expect(ids).not.toContain(mid);
  });

  // ── AC2: floor disabled (≤ -1) returns everything ────────────────────────

  it('AC2: relevanceFloor = -1 disables the floor (all matches returned)', async () => {
    const a = insertAt(0.5, 3, 'sub-default-floor a');
    const b = insertAt(0.2, 2, 'sub-default-floor b');
    const c = insertAt(0.05, 1, 'sub-default-floor c');

    saveConfig({ ...getConfig(), recall: { relevanceFloor: -1 } });

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    const results = await handleRecall({ cortex: CORTEX, query: 'q', limit: 50 });

    const ids = results.map((r) => r.id);
    expect(ids).toContain(a);
    expect(ids).toContain(b);
    expect(ids).toContain(c);
    expect(results.length).toBe(3);
  });

  // ── Floor cuts the RAW cosine, not the recency-weighted score ────────────

  it('cuts on the raw cosine, not the recency-weighted score (a recent above-floor entry survives)', async () => {
    // An above-floor (0.65) but very OLD entry has a small weighted score, yet
    // must survive — the floor is applied to the raw cosine before reweighting.
    // A below-floor (0.4) but newest entry must be dropped despite weight=1.
    const oldButAboveFloor = insertAt(0.65, 1, 'old above-floor');
    const newButBelowFloor = insertAt(0.4, 200, 'new below-floor');

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    const results = await handleRecall({ cortex: CORTEX, query: 'q', limit: 50 });

    const ids = results.map((r) => r.id);
    expect(ids).toContain(oldButAboveFloor);
    expect(ids).not.toContain(newButBelowFloor);
  });

  // ── AC2: FTS fallback (no_embed) is exempt — similarity=0 still surfaces ──

  it('AC2: the floor does NOT apply to the FTS-fallback path (no_embed)', async () => {
    // FTS results carry similarity=0, which is below the default 0.6 floor.
    // The floor must NOT prune them — FTS ranking is the engine of record there.
    insertAt(0.0, 1, 'apple orchards in the mountains');
    insertAt(0.0, 2, 'blue ocean waves at sunset');

    // no_embed bypasses embed() entirely and uses FTS5 keyword ranking.
    const results = await handleRecall({
      cortex: CORTEX,
      query: 'apple',
      no_embed: true,
      scope: 'active',
    });

    // FTS keyword match on "apple" must surface despite similarity=0 < floor.
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.fts_fallback).toBe(true);
      expect(r.similarity).toBe(0);
    }
  });
});
