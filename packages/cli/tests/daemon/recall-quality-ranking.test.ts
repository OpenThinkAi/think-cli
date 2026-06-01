/**
 * Quality-aware recall ranking tests — AGT-459 (iterative-learning-v2 §5 M4).
 *
 * The recall score is cosine × recency PLUS an additive curator-quality term:
 *   - a promoted retro (retros.promoted=1)            → +config.recall.qualityBoost
 *   - a relegated retro (promoted=0, recalled_count>0) → −config.recall.qualityPenalty
 * Candidates with no matching retros row (memories, un-curated cortexes) get no
 * term, so ranking degrades gracefully to the prior cosine × recency order.
 *
 * A retro lives in BOTH the memories table (kind='retro', what recall surfaces)
 * and the curator `retros` table (which carries promoted/relegation state),
 * sharing one id. Fixtures populate both, matching the AGT-457 write-back test.
 *
 * Coverage:
 *   - AC3: a promoted retro outranks an equal-similarity un-promoted one.
 *   - AC3: a relegated retro (promoted=0, recalled_count>0) is deprioritised.
 *   - AC1: the boost is additive — it does not invert a clearly stronger cosine.
 *   - AC2: graceful degradation — no quality state ⇒ ordering matches pure
 *     cosine × recency (no regression for un-curated cortexes).
 *   - AC2: the terms are config-tunable; setting both to 0 disables them.
 *   - validation: a negative boost/penalty is rejected.
 *
 * Strategy mirrors recall-relevance-floor.test.ts / recall-surfacing-writeback.ts:
 * mock embed() via vi.spyOn, insert fixtures with hand-built embedding vectors
 * (cosToAxis0 gives an exact cosine to the query axis), drive handleRecall.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
import { insertMemory } from '../../src/db/memory-queries.js';
import { insertRetro } from '../../src/db/retro-queries.js';
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
 * Unit vector whose cosine with axis(0) is exactly `cos`: `cos` on axis 0 and
 * sqrt(1-cos^2) on axis 1, so the result is unit-length and dot===cos.
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

const CORTEX = 'quality-rank-test';

describe('handleRecall — quality-aware ranking (AGT-459)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-quality-rank-'));
    process.env.THINK_HOME = tmpHome;
    closeAllCortexDbs();
    // Floor off so hand-built sub-0.6 fixtures aren't dropped before ranking.
    saveConfig({ ...getConfig(), recall: { relevanceFloor: -1 } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeAllCortexDbs();
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  /**
   * Insert a retro into BOTH tables with a shared id (matching production:
   * the memories row is surfaced, the retros row carries curator state).
   * `seq` keeps recency equal across fixtures so quality is the only variable.
   */
  function insertRetroFixture(
    cos: number,
    seq: number,
    content: string,
    curator: { promoted?: 0 | 1; recalledCount?: number } = {},
  ): string {
    const db = getCortexDb(CORTEX);
    const mem = insertMemory(CORTEX, {
      ts: '2026-05-01T00:00:00Z',
      author: 'test',
      content,
    });
    db.prepare('UPDATE memories SET embedding = ?, activity_seq = ?, kind = ? WHERE id = ?')
      .run(toBlob(cosToAxis0(cos)), seq, 'retro', mem.id);

    insertRetro(CORTEX, { id: mem.id, content, promoted: curator.promoted ?? 0 });
    if (curator.recalledCount !== undefined) {
      db.prepare('UPDATE retros SET recalled_count = ? WHERE id = ?')
        .run(curator.recalledCount, mem.id);
    }
    return mem.id;
  }

  /** Index of `id` in the ranked result array; -1 if absent. */
  function rankOf(results: { id: string }[], id: string): number {
    return results.findIndex((r) => r.id === id);
  }

  // ── AC3: promoted outranks an equal-similarity un-promoted retro ─────────

  it('AC3: a promoted retro outranks an equal-similarity un-promoted one', async () => {
    const promoted = insertRetroFixture(0.7, 5, 'promoted lesson', { promoted: 1 });
    const plain = insertRetroFixture(0.7, 5, 'un-promoted lesson', { promoted: 0 });

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    const results = await handleRecall({ cortex: CORTEX, query: 'q', limit: 50 });

    expect(rankOf(results, promoted)).toBeGreaterThanOrEqual(0);
    expect(rankOf(results, plain)).toBeGreaterThanOrEqual(0);
    // Promoted appears earlier (lower index) than the equal-similarity plain one.
    expect(rankOf(results, promoted)).toBeLessThan(rankOf(results, plain));
  });

  // ── AC3: a relegated retro is deprioritised ──────────────────────────────

  it('AC3: a relegated retro (promoted=0, recalled_count>0) is deprioritised below an equal-similarity un-curated one', async () => {
    const relegated = insertRetroFixture(0.7, 5, 'relegated lesson', {
      promoted: 0,
      recalledCount: 3,
    });
    const uncurated = insertRetroFixture(0.7, 5, 'never-curated lesson', {
      promoted: 0,
      recalledCount: 0,
    });

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    const results = await handleRecall({ cortex: CORTEX, query: 'q', limit: 50 });

    // The relegated retro carries a penalty; the un-curated one is neutral, so
    // it ranks above the relegated one despite identical cosine + recency.
    expect(rankOf(results, uncurated)).toBeLessThan(rankOf(results, relegated));
  });

  it('AC3: a promoted retro outranks a relegated one (boost vs penalty)', async () => {
    const promoted = insertRetroFixture(0.7, 5, 'promoted lesson', { promoted: 1 });
    const relegated = insertRetroFixture(0.7, 5, 'relegated lesson', {
      promoted: 0,
      recalledCount: 4,
    });

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    const results = await handleRecall({ cortex: CORTEX, query: 'q', limit: 50 });

    expect(rankOf(results, promoted)).toBeLessThan(rankOf(results, relegated));
  });

  // ── AC1: the boost is additive, not a re-rank — it doesn't invert a clearly
  //         stronger cosine match ───────────────────────────────────────────

  it('AC1: the boost is small/additive — a clearly stronger cosine still outranks a weak promoted one', async () => {
    // Default boost is 0.1; a 0.95-vs-0.5 cosine gap (0.45) dwarfs it, so the
    // strong un-promoted match must stay on top.
    const strongPlain = insertRetroFixture(0.95, 5, 'strong exact match', { promoted: 0 });
    const weakPromoted = insertRetroFixture(0.5, 5, 'weak but promoted', { promoted: 1 });

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    const results = await handleRecall({ cortex: CORTEX, query: 'q', limit: 50 });

    expect(rankOf(results, strongPlain)).toBeLessThan(rankOf(results, weakPromoted));
  });

  // ── AC2: graceful degradation — no curator state ⇒ pure cosine × recency ──

  it('AC2: with no curator state, ordering matches pure cosine (no regression)', async () => {
    // Memories only (no retros rows) — ranking must be by cosine alone.
    const db = getCortexDb(CORTEX);
    function insertMemOnly(cos: number, content: string): string {
      const m = insertMemory(CORTEX, { ts: '2026-05-01T00:00:00Z', author: 'test', content });
      db.prepare('UPDATE memories SET embedding = ?, activity_seq = ? WHERE id = ?')
        .run(toBlob(cosToAxis0(cos)), 5, m.id);
      return m.id;
    }
    const high = insertMemOnly(0.9, 'high cosine');
    const low = insertMemOnly(0.6, 'low cosine');

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    const results = await handleRecall({ cortex: CORTEX, query: 'q', limit: 50 });

    expect(rankOf(results, high)).toBeLessThan(rankOf(results, low));
  });

  // ── AC2: terms are config-tunable; both at 0 disables quality weighting ───

  it('AC2: qualityBoost=0 and qualityPenalty=0 disable the term (pure cosine ranking restored)', async () => {
    // Equal cosine + recency. With quality disabled, the two are tied on score;
    // a promoted retro must NOT jump ahead of the plain one.
    const promoted = insertRetroFixture(0.7, 5, 'promoted lesson', { promoted: 1 });
    const plain = insertRetroFixture(0.7, 5, 'un-promoted lesson', { promoted: 0 });

    saveConfig({ ...getConfig(), recall: { relevanceFloor: -1, qualityBoost: 0, qualityPenalty: 0 } });

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    const results = await handleRecall({ cortex: CORTEX, query: 'q', limit: 50 });

    // Both surface; with the term off their scores are equal, so the promoted
    // one does NOT strictly outrank the plain one (no boost applied).
    const pScore = results.find((r) => r.id === promoted)!.score;
    const plScore = results.find((r) => r.id === plain)!.score;
    expect(pScore).toBeCloseTo(plScore, 10);
  });

  it('AC2: a larger configured qualityBoost lifts a weaker promoted retro above a stronger plain one', async () => {
    // Mirror of the AC1 additivity test, but with the boost raised past the
    // cosine gap (0.5 → 0.95 is a 0.45 gap; a 0.6 boost overcomes it).
    const strongPlain = insertRetroFixture(0.95, 5, 'strong exact match', { promoted: 0 });
    const weakPromoted = insertRetroFixture(0.5, 5, 'weak but promoted', { promoted: 1 });

    saveConfig({ ...getConfig(), recall: { relevanceFloor: -1, qualityBoost: 0.6 } });

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    const results = await handleRecall({ cortex: CORTEX, query: 'q', limit: 50 });

    expect(rankOf(results, weakPromoted)).toBeLessThan(rankOf(results, strongPlain));
  });

  // ── validation: negative knobs are rejected (would invert curator intent) ─

  it('rejects a negative qualityBoost', async () => {
    insertRetroFixture(0.8, 5, 'entry', { promoted: 1 });
    saveConfig({ ...getConfig(), recall: { relevanceFloor: -1, qualityBoost: -0.5 } });

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    await expect(handleRecall({ cortex: CORTEX, query: 'q' })).rejects.toThrow(
      /qualityBoost must be a non-negative number/,
    );
  });

  it('rejects a negative qualityPenalty', async () => {
    insertRetroFixture(0.8, 5, 'entry', { promoted: 0, recalledCount: 2 });
    saveConfig({ ...getConfig(), recall: { relevanceFloor: -1, qualityPenalty: -0.5 } });

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    await expect(handleRecall({ cortex: CORTEX, query: 'q' })).rejects.toThrow(
      /qualityPenalty must be a non-negative number/,
    );
  });
});
