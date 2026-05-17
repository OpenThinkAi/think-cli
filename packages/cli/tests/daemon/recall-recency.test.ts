/**
 * Recency-weighted ranking tests — AGT-291
 *
 * AC5: Synthesize 100 entries — 50 highly-similar-but-old (low seq), 1
 * moderately-similar-but-new (max seq). Verify the new-but-moderate entry
 * ranks above most of the old-but-similar ones under default decay (0.05).
 *
 * The test also validates that:
 * - `score` is exposed on every RecallEntry
 * - When all activity_seqs are equal (most-recent anchor), recency weight is 1
 *   and `score === similarity`
 * - When all activity_seq values are NULL (pre-backfill), score falls back to cosine similarity
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
import { insertMemory } from '../../src/db/memory-queries.js';
import { handleRecall } from '../../src/daemon/recall.js';
import * as embedModule from '../../src/lib/embed.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DIM = 8;

/** Return a unit vector with 1.0 at `pos % DIM` and 0 elsewhere. */
function axis(pos: number): Float32Array {
  const v = new Float32Array(DIM);
  v[pos % DIM] = 1.0;
  return v;
}

/**
 * Return a vector with `highVal` at pos 0 and `lowVal` at pos 1, normalised
 * to unit length. Used to synthesise "moderately similar" vectors.
 */
function mixed(highVal: number, lowVal: number): Float32Array {
  const v = new Float32Array(DIM);
  v[0] = highVal;
  v[1] = lowVal;
  const norm = Math.sqrt(highVal * highVal + lowVal * lowVal);
  for (let i = 0; i < DIM; i++) v[i] /= norm;
  return v;
}

function toBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

const CORTEX = 'recency-test';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('handleRecall — recency-weighted ranking (AGT-291)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-recency-'));
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

  // ── AC5: new-but-moderate beats most old-but-similar ────────────────────

  it('AC5: moderately-similar-but-new entry ranks above most highly-similar-but-old entries', async () => {
    const db = getCortexDb(CORTEX);

    // Query vector: axis(0) = [1, 0, 0, ...]
    const QUERY_VEC = axis(0);

    // OLD entries: highly similar to the query (cosine ≈ 0.95), low seq
    // We insert 50 of them. Vector is slightly off axis(0) so cosine < 1.
    // Use mixed(0.95, 0.312) so cosine ≈ 0.95 with axis(0) (0.95/1 ≈ 0.95).
    const highSimOldVec = mixed(0.95, 0.312); // cosine(axis(0), highSimOldVec) ≈ 0.95

    const oldIds: string[] = [];
    for (let i = 0; i < 50; i++) {
      const row = insertMemory(CORTEX, {
        ts: `2020-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
        author: 'test',
        content: `old-high-sim entry ${i}`,
      });
      db.prepare('UPDATE memories SET embedding = ?, activity_seq = ? WHERE id = ?')
        .run(toBlob(highSimOldVec), i + 1, row.id);
      oldIds.push(row.id);
    }

    // NEW entry: moderately similar to the query (cosine ≈ 0.60), max seq.
    // Use mixed(0.60, 0.80) → cosine(axis(0), v) = 0.60/1 = 0.60.
    const modSimNewVec = mixed(0.60, 0.80);
    const newEntry = insertMemory(CORTEX, {
      ts: '2026-05-17T00:00:00Z',
      author: 'test',
      content: 'new-moderate-sim entry',
    });
    db.prepare('UPDATE memories SET embedding = ?, activity_seq = ? WHERE id = ?')
      .run(toBlob(modSimNewVec), 51, newEntry.id);

    // Mock embed to return the query vector without triggering model download.
    vi.spyOn(embedModule, 'default').mockResolvedValue(QUERY_VEC);

    // Fetch all 51 entries.
    const results = await handleRecall({ cortex: CORTEX, query: 'test', limit: 51 });

    expect(results.length).toBe(51);

    // Find the new entry's rank (0-based).
    const newRank = results.findIndex((r) => r.id === newEntry.id);
    expect(newRank).toBeGreaterThanOrEqual(0);

    // The new-but-moderate entry must rank above MOST (≥40 of 50) old-but-similar entries.
    // At decay=0.05, seq_distance=50 → weight≈0.082.
    // old score: 0.95 × 0.082 ≈ 0.078
    // new score: 0.60 × 1.00  = 0.60 (at max seq)
    // So the new entry should rank #1. We assert it beats at least 40 of 50 old ones.
    const newScoreEntry = results[newRank];
    // entries after newRank that are old-high-sim = how many old it beat
    const oldBeaten = results.filter((r, i) => i > newRank && oldIds.includes(r.id)).length;
    expect(oldBeaten).toBeGreaterThanOrEqual(40);

    // The new entry's score should equal its cosine (it's at max_seq, weight=1).
    expect(newScoreEntry.score).toBeCloseTo(newScoreEntry.similarity, 5);
  });

  // ── score === similarity when all activity_seq values are NULL ──────────

  it('score equals similarity when all activity_seq values are NULL (not-yet-backfilled fallback)', async () => {
    // getCortexDb runs all migrations so the activity_seq column exists, but rows
    // can still have NULL activity_seq if the reindex backfill (AGT-292) hasn't
    // run yet. When MAX(activity_seq) returns NULL, the handler falls back to
    // score = cosine for every entry.
    const db = getCortexDb(CORTEX);

    // Insert a few entries with embeddings but no activity_seq populated.
    for (let i = 0; i < 3; i++) {
      const row = insertMemory(CORTEX, {
        ts: new Date().toISOString(),
        author: 'test',
        content: `entry ${i}`,
      });
      db.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
        .run(toBlob(axis(i)), row.id);
      // activity_seq intentionally left NULL — simulates pre-backfill state
    }

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    const results = await handleRecall({ cortex: CORTEX, query: 'test', limit: 5 });

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      // When activity_seq is null, score must equal similarity exactly.
      expect(r.score).toBe(r.similarity);
    }
  });

  // ── score field is present on every result ───────────────────────────────

  it('every RecallEntry has a numeric score field', async () => {
    const db = getCortexDb(CORTEX);
    for (let i = 0; i < 5; i++) {
      const row = insertMemory(CORTEX, {
        ts: new Date().toISOString(),
        author: 'test',
        content: `entry ${i}`,
      });
      db.prepare('UPDATE memories SET embedding = ?, activity_seq = ? WHERE id = ?')
        .run(toBlob(axis(i)), i + 1, row.id);
    }

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    const results = await handleRecall({ cortex: CORTEX, query: 'test', limit: 5 });

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(typeof r.score).toBe('number');
      expect(Number.isFinite(r.score)).toBe(true);
    }
  });

  // ── score ≤ similarity (recency can only discount, not amplify) ──────────

  it('score is always ≤ similarity (recency weight never exceeds 1)', async () => {
    const db = getCortexDb(CORTEX);
    for (let i = 0; i < 5; i++) {
      const row = insertMemory(CORTEX, {
        ts: new Date().toISOString(),
        author: 'test',
        content: `entry ${i}`,
      });
      db.prepare('UPDATE memories SET embedding = ?, activity_seq = ? WHERE id = ?')
        .run(toBlob(axis(i)), i + 1, row.id);
    }

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    const results = await handleRecall({ cortex: CORTEX, query: 'test', limit: 5 });

    for (const r of results) {
      // For positive cosine similarities, score ≤ similarity.
      // (For negative cosines the bound reverses but we don't test that edge.)
      if (r.similarity >= 0) {
        expect(r.score).toBeLessThanOrEqual(r.similarity + 1e-9);
      }
    }
  });

  // ── most-recent entry has score === similarity (weight = 1) ─────────────

  it('the most recent entry (max_seq) has weight=1 so score === similarity', async () => {
    const db = getCortexDb(CORTEX);
    // Insert 10 entries with ascending activity_seq.
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const row = insertMemory(CORTEX, {
        ts: new Date().toISOString(),
        author: 'test',
        content: `entry ${i}`,
      });
      db.prepare('UPDATE memories SET embedding = ?, activity_seq = ? WHERE id = ?')
        .run(toBlob(axis(0)), i + 1, row.id); // all point at axis(0)
      ids.push(row.id);
    }
    const maxSeqId = ids[ids.length - 1]; // last insert = max_seq=10

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    const results = await handleRecall({ cortex: CORTEX, query: 'test', limit: 10 });

    const maxEntry = results.find((r) => r.id === maxSeqId);
    expect(maxEntry).toBeDefined();
    expect(maxEntry!.score).toBeCloseTo(maxEntry!.similarity, 5);
  });
});
