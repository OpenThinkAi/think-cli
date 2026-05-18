/**
 * Tests for AGT-324: recall fallback when embedding model unavailable + --no-embed flag.
 *
 * Three ACs tested here:
 *   (a) successful embedding => semantic ranking path (fts_fallback absent)
 *   (b) embedding-load failure => FTS fallback (fts_fallback: true on results)
 *   (c) no_embed: true => FTS fallback (fts_fallback: true on results)
 *
 * Strategy: mock embed() via vi.spyOn. For (a), return a valid vector. For (b),
 * throw a realistic "failed to load embedding model" error. Constructor injection
 * is used (vi.spyOn on the module export) -- no env-var poisoning that could bleed
 * into other tests.
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

const DIM = 3;
function axis(pos: number): Float32Array {
  const v = new Float32Array(DIM);
  v[pos % DIM] = 1.0;
  return v;
}
function toBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}
const CORTEX = 'embed-fallback-test';

describe('handleRecall -- embed fallback (AGT-324)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;
  const fixtureIds: string[] = [];

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-embed-fallback-'));
    process.env.THINK_HOME = tmpHome;
    closeAllCortexDbs();

    const db = getCortexDb(CORTEX);
    fixtureIds.length = 0;
    const fixtures = [
      { content: 'apple orchards in spring', vec: axis(0) },
      { content: 'blue ocean waves', vec: axis(1) },
      { content: 'cherry blossom festival', vec: axis(2) },
    ];
    for (const { content, vec } of fixtures) {
      const row = insertMemory(CORTEX, { ts: new Date().toISOString(), author: 'test', content });
      db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(toBlob(vec), row.id);
      fixtureIds.push(row.id);
    }
    vi.spyOn(gitModule, 'listLocalBranches').mockReturnValue([CORTEX]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeAllCortexDbs();
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('(a) successful embed => semantic results without fts_fallback', async () => {
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    const results = await handleRecall({ cortex: CORTEX, query: 'apple orchards', scope: 'active' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe(fixtureIds[0]);
    for (const r of results) {
      expect(r.fts_fallback).toBeUndefined();
    }
  });

  it('(b) embed throws network error => FTS fallback with fts_fallback flag', async () => {
    vi.spyOn(embedModule, 'default').mockRejectedValue(
      new Error('think: failed to load embedding model Xenova/bge-small-en-v1.5: network error'),
    );
    const results = await handleRecall({ cortex: CORTEX, query: 'apple', scope: 'active' });
    for (const r of results) {
      expect(r.fts_fallback).toBe(true);
      expect(r.similarity).toBe(0);
      expect(r.score).toBe(0);
    }
  });

  it('(b) embed throws missing-dep error => FTS fallback', async () => {
    vi.spyOn(embedModule, 'default').mockRejectedValue(
      new Error('@huggingface/transformers is an optional dependency. Install it to enable semantic features'),
    );
    const results = await handleRecall({ cortex: CORTEX, query: 'apple', scope: 'active' });
    for (const r of results) {
      expect(r.fts_fallback).toBe(true);
    }
  });

  it('(b) embed throws timeout error => FTS fallback', async () => {
    vi.spyOn(embedModule, 'default').mockRejectedValue(
      new Error('think: embedding model download timed out after 300s'),
    );
    const results = await handleRecall({ cortex: CORTEX, query: 'apple', scope: 'active' });
    for (const r of results) {
      expect(r.fts_fallback).toBe(true);
    }
  });

  it('(c) no_embed: true => FTS fallback, embed() not called', async () => {
    const embedSpy = vi.spyOn(embedModule, 'default');
    const results = await handleRecall({ cortex: CORTEX, query: 'apple', no_embed: true, scope: 'active' });
    expect(embedSpy).not.toHaveBeenCalled();
    for (const r of results) {
      expect(r.fts_fallback).toBe(true);
      expect(r.similarity).toBe(0);
      expect(r.score).toBe(0);
    }
  });

  it('(c) no_embed via federated scope also skips embed()', async () => {
    const embedSpy = vi.spyOn(embedModule, 'default');
    await handleRecall({ query: 'apple', no_embed: true });
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it('fts_fallback results carry non-empty cortex field', async () => {
    vi.spyOn(embedModule, 'default').mockRejectedValue(
      new Error('think: failed to load embedding model Xenova/bge-small-en-v1.5: network error'),
    );
    insertMemory(CORTEX, { ts: new Date().toISOString(), author: 'test', content: 'orchard farming techniques' });
    const results = await handleRecall({ cortex: CORTEX, query: 'orchard', scope: 'active' });
    for (const r of results) {
      expect(typeof r.cortex).toBe('string');
      expect(r.cortex.length).toBeGreaterThan(0);
    }
  });
});
