/**
 * Context-aware recall ranking tests — iterative-learning v3 (retro locality).
 *
 * When recall is given a `context` (the repo basename the caller is in), retros
 * whose topics include the reserved `repo:<context>` tag get an additive
 * contextBoost (default config.recall.contextBoost = 0.1) applied AFTER recency
 * weighting — like the M4 quality term. It is a boost, NOT a hard filter:
 * retros for other contexts (and memories/events) still surface, just lower.
 *
 * Coverage:
 *   - a context-tagged retro outranks an equal-similarity untagged one.
 *   - a retro tagged for a DIFFERENT context gets no boost.
 *   - additive: a clearly stronger cosine still outranks a weak boosted one.
 *   - no context param ⇒ no boost (pure cosine × recency preserved).
 *   - contextBoost=0 disables the term.
 *   - a larger configured contextBoost lifts a weaker tagged retro.
 *   - validation: a negative contextBoost is rejected.
 *
 * Strategy mirrors recall-quality-ranking.test.ts.
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

function axis(pos: number): Float32Array {
  const v = new Float32Array(DIM);
  v[pos % DIM] = 1.0;
  return v;
}

function cosToAxis0(cos: number): Float32Array {
  const v = new Float32Array(DIM);
  v[0] = cos;
  v[1] = Math.sqrt(Math.max(0, 1 - cos * cos));
  return v;
}

function toBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

const CORTEX = 'context-boost-test';

describe('handleRecall — context-aware ranking (v3 locality)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-ctx-boost-'));
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

  /** Insert a retro memory row with cosine `cos`, recency `seq`, and topics. */
  function insertRetroFixture(cos: number, seq: number, content: string, topics: string[]): string {
    const db = getCortexDb(CORTEX);
    const mem = insertMemory(CORTEX, { ts: '2026-05-01T00:00:00Z', author: 'test', content });
    db.prepare('UPDATE memories SET embedding = ?, activity_seq = ?, kind = ?, topics_json = ? WHERE id = ?')
      .run(toBlob(cosToAxis0(cos)), seq, 'retro', JSON.stringify(topics), mem.id);
    return mem.id;
  }

  function rankOf(results: { id: string }[], id: string): number {
    return results.findIndex((r) => r.id === id);
  }

  it('a context-tagged retro outranks an equal-similarity untagged one', async () => {
    const tagged = insertRetroFixture(0.7, 5, 'stamp lesson', ['repo:stamp-cli']);
    const untagged = insertRetroFixture(0.7, 5, 'generic lesson', []);

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    const results = await handleRecall({ cortex: CORTEX, query: 'q', limit: 50, context: 'stamp-cli' });

    expect(rankOf(results, tagged)).toBeGreaterThanOrEqual(0);
    expect(rankOf(results, untagged)).toBeGreaterThanOrEqual(0);
    expect(rankOf(results, tagged)).toBeLessThan(rankOf(results, untagged));
  });

  it('matches the context case-insensitively', async () => {
    const tagged = insertRetroFixture(0.7, 5, 'stamp lesson', ['repo:stamp-cli']);
    const untagged = insertRetroFixture(0.7, 5, 'generic lesson', []);

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    const results = await handleRecall({ cortex: CORTEX, query: 'q', limit: 50, context: 'Stamp-CLI' });

    expect(rankOf(results, tagged)).toBeLessThan(rankOf(results, untagged));
  });

  it('a retro tagged for a different context gets no boost', async () => {
    const other = insertRetroFixture(0.7, 5, 'other-repo lesson', ['repo:fx-tracker']);
    const untagged = insertRetroFixture(0.7, 5, 'generic lesson', []);

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    const results = await handleRecall({ cortex: CORTEX, query: 'q', limit: 50, context: 'stamp-cli' });

    // Equal cosine+recency, neither matches the active context → equal scores.
    const oScore = results.find((r) => r.id === other)!.score;
    const uScore = results.find((r) => r.id === untagged)!.score;
    expect(oScore).toBeCloseTo(uScore, 10);
  });

  it('is additive — a clearly stronger cosine still outranks a weak boosted retro', async () => {
    const strongUntagged = insertRetroFixture(0.95, 5, 'strong match', []);
    const weakTagged = insertRetroFixture(0.5, 5, 'weak but in-context', ['repo:stamp-cli']);

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    const results = await handleRecall({ cortex: CORTEX, query: 'q', limit: 50, context: 'stamp-cli' });

    expect(rankOf(results, strongUntagged)).toBeLessThan(rankOf(results, weakTagged));
  });

  it('no context param ⇒ no boost (pure cosine × recency preserved)', async () => {
    const tagged = insertRetroFixture(0.7, 5, 'stamp lesson', ['repo:stamp-cli']);
    const untagged = insertRetroFixture(0.7, 5, 'generic lesson', []);

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    const results = await handleRecall({ cortex: CORTEX, query: 'q', limit: 50 });

    const tScore = results.find((r) => r.id === tagged)!.score;
    const uScore = results.find((r) => r.id === untagged)!.score;
    expect(tScore).toBeCloseTo(uScore, 10);
  });

  it('contextBoost=0 disables the term', async () => {
    const tagged = insertRetroFixture(0.7, 5, 'stamp lesson', ['repo:stamp-cli']);
    const untagged = insertRetroFixture(0.7, 5, 'generic lesson', []);
    saveConfig({ ...getConfig(), recall: { relevanceFloor: -1, contextBoost: 0 } });

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    const results = await handleRecall({ cortex: CORTEX, query: 'q', limit: 50, context: 'stamp-cli' });

    const tScore = results.find((r) => r.id === tagged)!.score;
    const uScore = results.find((r) => r.id === untagged)!.score;
    expect(tScore).toBeCloseTo(uScore, 10);
  });

  it('a larger configured contextBoost lifts a weaker tagged retro above a stronger untagged one', async () => {
    const strongUntagged = insertRetroFixture(0.95, 5, 'strong match', []);
    const weakTagged = insertRetroFixture(0.5, 5, 'weak but in-context', ['repo:stamp-cli']);
    saveConfig({ ...getConfig(), recall: { relevanceFloor: -1, contextBoost: 0.6 } });

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    const results = await handleRecall({ cortex: CORTEX, query: 'q', limit: 50, context: 'stamp-cli' });

    expect(rankOf(results, weakTagged)).toBeLessThan(rankOf(results, strongUntagged));
  });

  it('rejects a negative contextBoost', async () => {
    insertRetroFixture(0.8, 5, 'entry', ['repo:stamp-cli']);
    saveConfig({ ...getConfig(), recall: { relevanceFloor: -1, contextBoost: -0.5 } });

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    await expect(handleRecall({ cortex: CORTEX, query: 'q', context: 'stamp-cli' })).rejects.toThrow(
      /contextBoost must be a non-negative number/,
    );
  });
});
