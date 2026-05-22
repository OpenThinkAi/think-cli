/**
 * Unit tests for `think reindex` — AGT-276.
 *
 * All tests call `reindexOneCortex` directly (exported from reindex.ts) so
 * they exercise the production code, not a reimplementation. The embed module
 * is mocked via vi.spyOn / vi.mock so no model download is required. The git
 * helpers are mocked to supply L1 JSONL from in-memory fixtures.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
import { deterministicId } from '../../src/lib/deterministic-id.js';

// ─── mocks ────────────────────────────────────────────────────────────────────

// Mock @huggingface/transformers so the embed module never tries to load a
// real model.
vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn().mockResolvedValue(
    vi.fn().mockResolvedValue({ data: new Float32Array(384).fill(0.1) })
  ),
}));

// Mock git helpers that reindexOneCortex calls to provide L1 data from
// fixtures rather than touching a real git repo.
vi.mock('../../src/lib/git.js', () => ({
  ensureRepoCloned: vi.fn(),
  fetchBranch: vi.fn(),
  listBranchFiles: vi.fn().mockReturnValue([]),
  readFileFromBranch: vi.fn().mockReturnValue(null),
  readCortexFile: vi.fn().mockReturnValue(null),
}));

import * as gitLib from '../../src/lib/git.js';
import { EMBEDDING_MODEL_NAME } from '../../src/lib/embed.js';
import { reindexOneCortex } from '../../src/commands/reindex.js';

// ─── test-fixture helpers ─────────────────────────────────────────────────────

/**
 * Build a minimal JSONL line for an L1 memory entry.
 */
function makeL1Line(ts: string, author: string, content: string): string {
  return JSON.stringify({ ts, author, content, source_ids: [] });
}

/**
 * Configure the git mock to serve `jsonlContent` as a single legacy
 * `memories.jsonl` page (no numbered buckets).
 */
function mockL1Pages(pages: string[]): void {
  // pages maps to numbered bucket files 000001.jsonl, 000002.jsonl, …
  if (pages.length === 0) {
    vi.mocked(gitLib.listBranchFiles).mockReturnValue([]);
    vi.mocked(gitLib.readFileFromBranch).mockReturnValue(null);
    vi.mocked(gitLib.readCortexFile).mockReturnValue(null);
    return;
  }
  const fileNames = pages.map((_, i) =>
    String(i + 1).padStart(6, '0') + '.jsonl'
  );
  vi.mocked(gitLib.listBranchFiles).mockReturnValue(fileNames);
  // readCortexFile is the cortex-aware reader used by readAllL1Pages for the
  // nested layout. readFileFromBranch stays mocked for the legacy
  // `memories.jsonl` top-level fallback path.
  vi.mocked(gitLib.readCortexFile).mockImplementation(
    (_cortex: string, file: string) => {
      const idx = fileNames.indexOf(file);
      return idx >= 0 ? pages[idx] : null;
    }
  );
  vi.mocked(gitLib.readFileFromBranch).mockReturnValue(null);
}

// ─── DB query helpers ─────────────────────────────────────────────────────────

function getEmbedding(cortex: string, id: string): Uint8Array | null {
  const db = getCortexDb(cortex);
  const row = db.prepare('SELECT embedding FROM memories WHERE id = ?').get(id) as
    | { embedding: Uint8Array | null }
    | undefined;
  return row?.embedding ?? null;
}

function getActivitySeq(cortex: string, id: string): number | null {
  const db = getCortexDb(cortex);
  const row = db.prepare('SELECT activity_seq FROM memories WHERE id = ?').get(id) as
    | { activity_seq: number | null }
    | undefined;
  return row?.activity_seq ?? null;
}

function getEmbeddingModel(cortex: string, id: string): string | null {
  const db = getCortexDb(cortex);
  const row = db.prepare('SELECT embedding_model FROM memories WHERE id = ?').get(id) as
    | { embedding_model: string | null }
    | undefined;
  return row?.embedding_model ?? null;
}

function countRows(cortex: string): number {
  const db = getCortexDb(cortex);
  const row = db.prepare('SELECT COUNT(*) as n FROM memories').get() as { n: number };
  return row.n;
}

// ─── test suite ───────────────────────────────────────────────────────────────

describe('reindexOneCortex (AGT-276)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;
  const cortex = 'reindex-test';

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-reindex-'));
    process.env.THINK_HOME = tmpHome;
    closeAllCortexDbs();
    getCortexDb(cortex); // initialise schema
    vi.clearAllMocks();
    // Reset git mocks to no-op defaults before each test
    vi.mocked(gitLib.ensureRepoCloned).mockReturnValue(undefined);
    vi.mocked(gitLib.fetchBranch).mockReturnValue(undefined);
    vi.mocked(gitLib.listBranchFiles).mockReturnValue([]);
    vi.mocked(gitLib.readFileFromBranch).mockReturnValue(null);
  });

  afterEach(() => {
    closeAllCortexDbs();
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('inserts rows with embedding and embedding_model for each L1 entry', async () => {
    const page = [
      makeL1Line('2026-01-01T00:00:00Z', 'alice', 'first entry'),
      makeL1Line('2026-01-02T00:00:00Z', 'alice', 'second entry'),
    ].join('\n');
    mockL1Pages([page]);

    const { total, failures } = await reindexOneCortex(cortex, /* force= */ false);
    expect(total).toBe(2);
    expect(failures).toBe(0);

    const id1 = deterministicId('2026-01-01T00:00:00Z', 'alice', 'first entry');
    const id2 = deterministicId('2026-01-02T00:00:00Z', 'alice', 'second entry');

    expect(getEmbedding(cortex, id1)).toBeInstanceOf(Uint8Array);
    expect(getEmbedding(cortex, id2)).toBeInstanceOf(Uint8Array);
    expect(getEmbeddingModel(cortex, id1)).toBe(EMBEDDING_MODEL_NAME);
    expect(getEmbeddingModel(cortex, id2)).toBe(EMBEDDING_MODEL_NAME);
  });

  it('assigns activity_seq via recomputeActivitySeq after the embedding pass', async () => {
    const page = [
      makeL1Line('2026-01-03T00:00:00Z', 'bob', 'c'),
      makeL1Line('2026-01-01T00:00:00Z', 'bob', 'a'),
      makeL1Line('2026-01-02T00:00:00Z', 'bob', 'b'),
    ].join('\n');
    mockL1Pages([page]);

    await reindexOneCortex(cortex, false);

    const idA = deterministicId('2026-01-01T00:00:00Z', 'bob', 'a');
    const idB = deterministicId('2026-01-02T00:00:00Z', 'bob', 'b');
    const idC = deterministicId('2026-01-03T00:00:00Z', 'bob', 'c');

    expect(getActivitySeq(cortex, idA)).toBe(1);
    expect(getActivitySeq(cortex, idB)).toBe(2);
    expect(getActivitySeq(cortex, idC)).toBe(3);
  });

  it('is idempotent — two reindex runs produce identical row state', async () => {
    const page = [
      makeL1Line('2026-02-01T00:00:00Z', 'carol', 'x'),
      makeL1Line('2026-02-02T00:00:00Z', 'carol', 'y'),
    ].join('\n');
    mockL1Pages([page]);

    await reindexOneCortex(cortex, false);
    const id1 = deterministicId('2026-02-01T00:00:00Z', 'carol', 'x');
    const emb1After = Array.from(getEmbedding(cortex, id1) ?? []);
    const seq1After = getActivitySeq(cortex, id1);

    // Re-run on the same data
    mockL1Pages([page]);
    await reindexOneCortex(cortex, false);
    const emb1After2 = Array.from(getEmbedding(cortex, id1) ?? []);
    const seq1After2 = getActivitySeq(cortex, id1);

    expect(emb1After2).toEqual(emb1After);
    expect(seq1After2).toBe(seq1After);
    expect(countRows(cortex)).toBe(2); // no duplication
  });

  it('--force drops all rows and rebuilds from scratch', async () => {
    // Seed a row that is NOT in the L1 fixture
    const db = getCortexDb(cortex);
    db.prepare(
      `INSERT INTO memories (id, ts, author, content, source_ids, created_at, sync_version)
       VALUES ('stale-row', '2020-01-01T00:00:00Z', 'x', 'stale', '[]', '2020-01-01T00:00:00Z', 1)`
    ).run();
    expect(countRows(cortex)).toBe(1);

    const page = makeL1Line('2026-03-01T00:00:00Z', 'dave', 'fresh');
    mockL1Pages([page]);

    await reindexOneCortex(cortex, /* force= */ true);

    expect(countRows(cortex)).toBe(1); // stale row gone; fresh row present
    const rows = db.prepare('SELECT id FROM memories').all() as { id: string }[];
    const freshId = deterministicId('2026-03-01T00:00:00Z', 'dave', 'fresh');
    expect(rows[0].id).toBe(freshId);
  });

  it('--force with empty L1 sets forcedEmptyWipe and reports deleted count', async () => {
    // Seed rows that will be wiped
    const db = getCortexDb(cortex);
    db.prepare(
      `INSERT INTO memories (id, ts, author, content, source_ids, created_at, sync_version)
       VALUES ('row-a', '2020-01-01T00:00:00Z', 'x', 'existing', '[]', '2020-01-01T00:00:00Z', 1)`
    ).run();
    db.prepare(
      `INSERT INTO memories (id, ts, author, content, source_ids, created_at, sync_version)
       VALUES ('row-b', '2020-01-02T00:00:00Z', 'x', 'existing2', '[]', '2020-01-02T00:00:00Z', 1)`
    ).run();
    expect(countRows(cortex)).toBe(2);

    // L1 is empty — no pages
    mockL1Pages([]);

    const result = await reindexOneCortex(cortex, /* force= */ true);

    expect(result.total).toBe(0);
    expect(result.forcedEmptyWipe).toBe(2);
    expect(countRows(cortex)).toBe(0);
  });

  it('--force with non-empty L1 does NOT set forcedEmptyWipe', async () => {
    const page = makeL1Line('2026-04-01T00:00:00Z', 'erin', 'content');
    mockL1Pages([page]);

    const result = await reindexOneCortex(cortex, /* force= */ true);

    expect(result.forcedEmptyWipe).toBeUndefined();
    expect(result.total).toBe(1);
  });

  it('logs embed failure per-entry and continues; failure count is accurate', async () => {
    // We'll mock embed directly: fail on 2nd call, succeed on 1st and 3rd
    const embedMod = await import('../../src/lib/embed.js');
    const embedSpy = vi.spyOn(embedMod, 'default');
    const realVec = new Float32Array(384).fill(0.1);
    let callCount = 0;
    embedSpy.mockImplementation(async () => {
      callCount++;
      if (callCount === 2) throw new Error('model exploded');
      return realVec;
    });

    const page = [
      makeL1Line('2026-05-01T00:00:00Z', 'eve', 'ok'),
      makeL1Line('2026-05-02T00:00:00Z', 'eve', 'fail'),
      makeL1Line('2026-05-03T00:00:00Z', 'eve', 'ok2'),
    ].join('\n');
    mockL1Pages([page]);

    const { total, failures } = await reindexOneCortex(cortex, false);

    expect(total).toBe(3);
    expect(failures).toBe(1);

    const idOk = deterministicId('2026-05-01T00:00:00Z', 'eve', 'ok');
    const idFail = deterministicId('2026-05-02T00:00:00Z', 'eve', 'fail');
    const idOk2 = deterministicId('2026-05-03T00:00:00Z', 'eve', 'ok2');

    expect(getEmbedding(cortex, idOk)).toBeInstanceOf(Uint8Array);
    expect(getEmbedding(cortex, idOk2)).toBeInstanceOf(Uint8Array);
    // The failed entry was not written to L2
    expect(getEmbedding(cortex, idFail)).toBeNull();

    embedSpy.mockRestore();
  });

  it('handles multiple pages (buckets) by processing all entries', async () => {
    const page1 = makeL1Line('2026-06-01T00:00:00Z', 'fred', 'page1-entry');
    const page2 = makeL1Line('2026-06-02T00:00:00Z', 'fred', 'page2-entry');
    mockL1Pages([page1, page2]);

    const { total, failures } = await reindexOneCortex(cortex, false);
    expect(total).toBe(2);
    expect(failures).toBe(0);
    expect(countRows(cortex)).toBe(2);
  });

  it('skips malformed JSONL lines without crashing (parseMemoriesJsonl responsibility)', async () => {
    // parseMemoriesJsonl silently drops malformed and no-content lines
    const page = [
      makeL1Line('2026-07-01T00:00:00Z', 'grace', 'valid'),
      '{invalid json',
      '{"no_content": true}',
      makeL1Line('2026-07-02T00:00:00Z', 'grace', 'also valid'),
    ].join('\n');
    mockL1Pages([page]);

    const { total, failures } = await reindexOneCortex(cortex, false);
    expect(total).toBe(2);
    expect(failures).toBe(0);
    expect(countRows(cortex)).toBe(2);
  });

  it('preserves created_at and sync_version for rows that already exist (idempotent upsert)', async () => {
    // Pre-seed a row with known created_at / sync_version
    const db = getCortexDb(cortex);
    const knownCreatedAt = '2025-12-01T00:00:00Z';
    const id = deterministicId('2026-08-01T00:00:00Z', 'hank', 'memo');
    db.prepare(
      `INSERT INTO memories (id, ts, author, content, source_ids, created_at, sync_version)
       VALUES (?, '2026-08-01T00:00:00Z', 'hank', 'memo', '[]', ?, 7)`
    ).run(id, knownCreatedAt);

    const page = makeL1Line('2026-08-01T00:00:00Z', 'hank', 'memo');
    mockL1Pages([page]);

    await reindexOneCortex(cortex, false);

    const row = db.prepare(
      'SELECT created_at, sync_version FROM memories WHERE id = ?'
    ).get(id) as { created_at: string; sync_version: number };

    expect(row.created_at).toBe(knownCreatedAt); // preserved
    expect(row.sync_version).toBe(7);            // preserved
  });
});
