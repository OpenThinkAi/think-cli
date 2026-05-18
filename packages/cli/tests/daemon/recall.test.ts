/**
 * Tests for the daemon `recall` endpoint (AGT-285).
 *
 * Strategy: mock embed() via vi.spyOn so tests never trigger a model download.
 * Fixture entries are inserted directly into a tmp-dir cortex DB with known
 * embedding vectors. The query vector is chosen to be closest to fixture[0],
 * verifying that the correct entry ranks first.
 *
 * Five fixture entries cover the AC requirement of "5 entries with known content".
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
// Fixture vectors — 3-d unit vectors, orthogonal pairs.
// ---------------------------------------------------------------------------

const DIM = 3;

function axis(pos: number): Float32Array {
  const v = new Float32Array(DIM);
  v[pos % DIM] = 1.0;
  return v;
}

function toBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer);
}

const FIXTURES: Array<{ content: string; vec: Float32Array }> = [
  { content: 'apple orchards in the mountains',  vec: axis(0) }, // [1,0,0]
  { content: 'blue ocean waves at sunset',        vec: axis(1) }, // [0,1,0]
  { content: 'cherry blossoms in spring',         vec: axis(2) }, // [0,0,1]
  { content: 'dark storm clouds gathering fast',  vec: new Float32Array([-1, 0, 0]) },
  { content: 'electric eels in the deep sea',     vec: new Float32Array([0, -1, 0]) },
];

const CORTEX = 'recall-test';

describe('handleRecall (AGT-285)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;
  const fixtureIds: string[] = [];

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-recall-'));
    process.env.THINK_HOME = tmpHome;
    closeAllCortexDbs();

    const db = getCortexDb(CORTEX);
    fixtureIds.length = 0;

    for (const { content, vec } of FIXTURES) {
      const row = insertMemory(CORTEX, {
        ts: new Date().toISOString(),
        author: 'test',
        content,
      });
      db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(toBlob(vec), row.id);
      fixtureIds.push(row.id);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeAllCortexDbs();
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  // ── AC 6: correct top-1 ranking ──────────────────────────────────────────

  it('returns fixture[0] as top-1 when query vector is axis(0)', async () => {
    // Mock embed so no model download occurs; return axis(0) = [1, 0, 0].
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    const results = await handleRecall({ cortex: CORTEX, query: 'apple orchards' });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe(fixtureIds[0]);
    expect(results[0].similarity).toBeCloseTo(1.0, 4);
    expect(results[0].cortex).toBe(CORTEX);
    expect(results[0].content).toBe(FIXTURES[0].content);
  });

  it('returns fixture[1] as top-1 when query vector is axis(1)', async () => {
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(1));

    const results = await handleRecall({ cortex: CORTEX, query: 'ocean waves' });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe(fixtureIds[1]);
    expect(results[0].similarity).toBeCloseTo(1.0, 4);
  });

  // ── limit param ──────────────────────────────────────────────────────────

  it('respects the limit param', async () => {
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    const results = await handleRecall({ cortex: CORTEX, query: 'test', limit: 2 });
    expect(results.length).toBe(2);
  });

  it('defaults to limit=20 when limit is not provided', async () => {
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    // 5 fixtures — all should come back (5 < 20)
    const results = await handleRecall({ cortex: CORTEX, query: 'test' });
    expect(results.length).toBe(5);
  });

  // ── result shape ─────────────────────────────────────────────────────────

  it('result entries have the expected shape', async () => {
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    const results = await handleRecall({ cortex: CORTEX, query: 'apple' });
    const top = results[0];

    expect(typeof top.id).toBe('string');
    expect(typeof top.ts).toBe('string');
    expect(top.kind === null || typeof top.kind === 'string').toBe(true);
    expect(Array.isArray(top.topics)).toBe(true);
    expect(typeof top.content).toBe('string');
    expect(typeof top.similarity).toBe('number');
    expect(top.cortex).toBe(CORTEX);
  });

  // ── kind/topic filter happy paths ─────────────────────────────────────────

  it('kind filter: returns only entries with matching kind', async () => {
    // Ensure kind column exists (migration 14 adds it; this is a no-op guard for
    // test isolation when running against an already-migrated DB).
    const db = getCortexDb(CORTEX);
    const cols = (db.prepare('PRAGMA table_info(memories)').all() as { name: string }[]).map(c => c.name);
    if (!cols.includes('kind')) {
      db.exec('ALTER TABLE memories ADD COLUMN kind TEXT');
    }
    // Invalidate the column cache so handleRecall re-reads schema.
    closeAllCortexDbs();
    const db2 = getCortexDb(CORTEX);
    db2.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
      .run(toBlob(axis(0)), fixtureIds[0]); // re-apply embeddings after reopen
    // Tag fixture[0] as 'note', fixture[1] as 'decision'.
    db2.prepare("UPDATE memories SET kind = 'note' WHERE id = ?").run(fixtureIds[0]);
    db2.prepare("UPDATE memories SET kind = 'decision' WHERE id = ?").run(fixtureIds[1]);
    // Restore embeddings for the remaining fixtures.
    for (let i = 1; i < FIXTURES.length; i++) {
      db2.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
        .run(toBlob(FIXTURES[i].vec), fixtureIds[i]);
    }

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(1)); // query ≈ fixture[1]

    const results = await handleRecall({ cortex: CORTEX, query: 'ocean', kind: 'decision' });
    expect(results.length).toBeGreaterThan(0);
    // Every result must have kind='decision'.
    for (const r of results) {
      expect(r.kind).toBe('decision');
    }
    // fixture[1] (kind=decision, top cosine match) should be first.
    expect(results[0].id).toBe(fixtureIds[1]);
  });

  it('topic filter: returns only entries whose topics contain the requested value', async () => {
    // Add topics column to the test DB.
    const db = getCortexDb(CORTEX);
    db.exec('ALTER TABLE memories ADD COLUMN topics TEXT NOT NULL DEFAULT \'[]\'');
    closeAllCortexDbs();
    const db2 = getCortexDb(CORTEX);
    // Restore embeddings; tag fixture[0] with topic 'nature', fixture[1] with 'ocean'.
    for (let i = 0; i < FIXTURES.length; i++) {
      db2.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
        .run(toBlob(FIXTURES[i].vec), fixtureIds[i]);
    }
    db2.prepare("UPDATE memories SET topics = ? WHERE id = ?")
      .run(JSON.stringify(['nature', 'fruit']), fixtureIds[0]);
    db2.prepare("UPDATE memories SET topics = ? WHERE id = ?")
      .run(JSON.stringify(['ocean', 'nature']), fixtureIds[1]);

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0)); // query ≈ fixture[0]

    // Query for 'ocean' — only fixture[1] has that topic.
    const results = await handleRecall({ cortex: CORTEX, query: 'apple', topic: 'ocean' });
    expect(results.length).toBe(1);
    expect(results[0].id).toBe(fixtureIds[1]);
  });

  // ── error cases ──────────────────────────────────────────────────────────

  it('scope="active" throws when cortex param absent and no active cortex configured', async () => {
    // Without a cortex param AND scope="active", the handler must throw.
    // The default scope is "accessible" (federated), so we explicitly set active.
    await expect(
      handleRecall({ query: 'test', scope: 'active' }),
    ).rejects.toThrow(/recall:.*scope.*active.*cortex/i);
  });

  it('scope="active" throws when cortex param is empty string and no active cortex in config', async () => {
    // Empty string with scope="active" falls back to config; config has no active
    // cortex in the test environment → must throw.
    await expect(
      handleRecall({ cortex: '', query: 'test', scope: 'active' }),
    ).rejects.toThrow(/recall:.*scope.*active.*cortex/i);
  });

  it('throws on invalid scope value', async () => {
    await expect(
      handleRecall({ cortex: CORTEX, query: 'test', scope: 'bogus' }),
    ).rejects.toThrow(/recall:.*scope/i);
  });

  it('throws on missing query param', async () => {
    await expect(
      handleRecall({ cortex: CORTEX }),
    ).rejects.toThrow(/recall:.*query/i);
  });

  it('throws on empty query param', async () => {
    await expect(
      handleRecall({ cortex: CORTEX, query: '' }),
    ).rejects.toThrow(/recall:.*query/i);
  });

  it('throws on invalid limit (zero)', async () => {
    await expect(
      handleRecall({ cortex: CORTEX, query: 'test', limit: 0 }),
    ).rejects.toThrow(/recall:.*limit/i);
  });

  it('throws on invalid limit (negative)', async () => {
    await expect(
      handleRecall({ cortex: CORTEX, query: 'test', limit: -5 }),
    ).rejects.toThrow(/recall:.*limit/i);
  });

  it('throws on limit exceeding MAX_LIMIT (500)', async () => {
    await expect(
      handleRecall({ cortex: CORTEX, query: 'test', limit: 501 }),
    ).rejects.toThrow(/recall:.*limit.*exceed/i);
  });

  it('throws on non-ISO-8601 since value', async () => {
    await expect(
      handleRecall({ cortex: CORTEX, query: 'test', since: 'last week' }),
    ).rejects.toThrow(/recall:.*since/i);
  });

  it('throws on path-traversal cortex name (sanitizeName guard)', async () => {
    await expect(
      handleRecall({ cortex: '../../../etc/passwd', query: 'test' }),
    ).rejects.toThrow();
  });

  // ── since filter ─────────────────────────────────────────────────────────

  it('returns empty array when `since` is far in the future', async () => {
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    const results = await handleRecall({
      cortex: CORTEX,
      query: 'apple',
      since: '9999-01-01T00:00:00.000Z',
    });

    expect(results).toHaveLength(0);
  });
});
