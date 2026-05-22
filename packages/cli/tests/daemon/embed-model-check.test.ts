/**
 * Tests for the daemon startup embedding-model version check — AGT-277.
 *
 * Covers:
 *   1. Up-to-date cortex: no reindex triggered.
 *   2. Model mismatch: reindex triggered, busy flag set then cleared.
 *   3. Null stored model (no embeddings yet): reindex triggered.
 *   4. While reindexing, recall returns a transient busy error for that cortex
 *      but succeeds for other cortexes.
 *   5. Rows are re-embedded (embedding_model updated) after reindex.
 *   6. DB error during sampleEmbeddingModel: skip that cortex gracefully.
 *   7. sanitizeForLog strips newlines from model names and cortex names in log output.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
import { deterministicId } from '../../src/lib/deterministic-id.js';

// ─── mocks ────────────────────────────────────────────────────────────────────

// Mock the HuggingFace transformers pipeline so no model download occurs.
vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn().mockResolvedValue(
    vi.fn().mockResolvedValue({ data: new Float32Array(384).fill(0.2) })
  ),
}));

// Mock git helpers used by reindexOneCortex so we can inject L1 data.
vi.mock('../../src/lib/git.js', () => ({
  ensureRepoCloned: vi.fn(),
  fetchBranch: vi.fn(),
  listBranchFiles: vi.fn().mockReturnValue([]),
  readFileFromBranch: vi.fn().mockReturnValue(null),
  readCortexFile: vi.fn().mockReturnValue(null),
  listLocalBranches: vi.fn().mockReturnValue([]),
}));

import * as gitLib from '../../src/lib/git.js';
import { EMBEDDING_MODEL_NAME } from '../../src/lib/embed.js';
import { runEmbedModelChecks, reindexingCortexes, reindexFailedCortexes } from '../../src/daemon/embed-model-check.js';

// ─── test-fixture helpers ─────────────────────────────────────────────────────

function makeL1Line(ts: string, author: string, content: string): string {
  return JSON.stringify({ ts, author, content, source_ids: [] });
}

/**
 * Configure the git mock to serve the given JSONL pages as numbered bucket files.
 */
function mockL1Pages(pages: string[]): void {
  if (pages.length === 0) {
    vi.mocked(gitLib.listBranchFiles).mockReturnValue([]);
    vi.mocked(gitLib.readFileFromBranch).mockReturnValue(null);
    vi.mocked(gitLib.readCortexFile).mockReturnValue(null);
    return;
  }
  const fileNames = pages.map((_, i) => String(i + 1).padStart(6, '0') + '.jsonl');
  vi.mocked(gitLib.listBranchFiles).mockReturnValue(fileNames);
  // reindexOneCortex → readAllL1Pages reads via readCortexFile in the nested
  // layout; readFileFromBranch is still mocked to null so the legacy
  // memories.jsonl fallback path doesn't fire here.
  vi.mocked(gitLib.readCortexFile).mockImplementation(
    (_cortex: string, file: string) => {
      const idx = fileNames.indexOf(file);
      return idx >= 0 ? pages[idx] : null;
    }
  );
  vi.mocked(gitLib.readFileFromBranch).mockReturnValue(null);
}

/**
 * Seed a row with a specific embedding_model into the cortex L2 DB.
 */
function seedRowWithModel(cortex: string, model: string): string {
  const ts = '2025-01-01T00:00:00Z';
  const author = 'alice';
  const content = 'test content';
  const id = deterministicId(ts, author, content);
  const db = getCortexDb(cortex);
  db.prepare(
    `INSERT OR REPLACE INTO memories
       (id, ts, author, content, source_ids, created_at, sync_version, embedding_model)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
  ).run(id, ts, author, content, '[]', ts, model);
  return id;
}

function getEmbeddingModel(cortex: string, id: string): string | null {
  const db = getCortexDb(cortex);
  const row = db.prepare('SELECT embedding_model FROM memories WHERE id = ?').get(id) as
    | { embedding_model: string | null }
    | undefined;
  return row?.embedding_model ?? null;
}

// ─── suite ────────────────────────────────────────────────────────────────────

describe('runEmbedModelChecks (AGT-277)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;
  const logs: string[] = [];
  const writeLine = (msg: string): void => { logs.push(msg); };

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-embed-check-'));
    process.env.THINK_HOME = tmpHome;
    closeAllCortexDbs();
    logs.length = 0;
    vi.clearAllMocks();
    vi.mocked(gitLib.ensureRepoCloned).mockReturnValue(undefined);
    vi.mocked(gitLib.fetchBranch).mockReturnValue(undefined);
    vi.mocked(gitLib.listBranchFiles).mockReturnValue([]);
    vi.mocked(gitLib.readFileFromBranch).mockReturnValue(null);
    // Ensure the state sets are clean before each test.
    reindexingCortexes.clear();
    reindexFailedCortexes.clear();
  });

  afterEach(() => {
    closeAllCortexDbs();
    reindexingCortexes.clear();
    reindexFailedCortexes.clear();
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('logs "up to date" and does not reindex when model matches', async () => {
    const cortex = 'up-to-date';
    getCortexDb(cortex); // initialise schema
    seedRowWithModel(cortex, EMBEDDING_MODEL_NAME);

    await runEmbedModelChecks([cortex], writeLine);

    expect(logs.some(l => l.includes('up to date'))).toBe(true);
    // No reindex log lines expected
    expect(logs.some(l => l.includes('reindexing'))).toBe(false);
    expect(logs.some(l => l.includes('reindex complete'))).toBe(false);
  });

  it('triggers reindex when stored model differs from current model', async () => {
    const cortex = 'mismatch';
    getCortexDb(cortex);
    const id = seedRowWithModel(cortex, 'old-model');
    // Provide L1 data so reindexOneCortex can re-embed
    mockL1Pages([makeL1Line('2025-01-01T00:00:00Z', 'alice', 'test content')]);

    await runEmbedModelChecks([cortex], writeLine);

    expect(logs.some(l => l.includes('embedding model changed') && l.includes('old-model') && l.includes(EMBEDDING_MODEL_NAME))).toBe(true);
    expect(logs.some(l => l.includes('reindex complete'))).toBe(true);
    // After reindex, embedding_model should be the current model
    expect(getEmbeddingModel(cortex, id)).toBe(EMBEDDING_MODEL_NAME);
  });

  it('triggers reindex when no embeddings exist yet (null stored model)', async () => {
    const cortex = 'no-embeddings';
    getCortexDb(cortex);
    // Insert a row without embedding_model (legacy data with no embeddings)
    const ts = '2025-02-01T00:00:00Z';
    const content = 'legacy content';
    const id = deterministicId(ts, 'bob', content);
    const db = getCortexDb(cortex);
    db.prepare(
      `INSERT INTO memories (id, ts, author, content, source_ids, created_at, sync_version)
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    ).run(id, ts, 'bob', content, '[]', ts);

    mockL1Pages([makeL1Line(ts, 'bob', content)]);

    await runEmbedModelChecks([cortex], writeLine);

    expect(logs.some(l => l.includes('no embeddings yet') || l.includes('reindexing'))).toBe(true);
    expect(logs.some(l => l.includes('reindex complete'))).toBe(true);
    expect(getEmbeddingModel(cortex, id)).toBe(EMBEDDING_MODEL_NAME);
  });

  it('busy flag is cleared after reindex completes', async () => {
    const cortex = 'busy-flag';
    getCortexDb(cortex);
    seedRowWithModel(cortex, 'old-model');
    mockL1Pages([makeL1Line('2025-01-01T00:00:00Z', 'alice', 'test content')]);

    expect(reindexingCortexes.has(cortex)).toBe(false);
    await runEmbedModelChecks([cortex], writeLine);
    // Verify the finally block cleared the flag correctly
    expect(reindexingCortexes.has(cortex)).toBe(false);
  });

  it('clears busy flag and sets failed flag when reindex throws', async () => {
    const cortex = 'reindex-fail';
    getCortexDb(cortex);
    seedRowWithModel(cortex, 'old-model');
    // Git mock throws so reindexOneCortex fails
    vi.mocked(gitLib.fetchBranch).mockImplementation(() => {
      throw new Error('git fetch failed');
    });

    await runEmbedModelChecks([cortex], writeLine);

    expect(reindexingCortexes.has(cortex)).toBe(false);
    expect(reindexFailedCortexes.has(cortex)).toBe(true);
    expect(logs.some(l => l.includes('reindex failed'))).toBe(true);
    expect(logs.some(l => l.includes('may reflect an older embedding model'))).toBe(true);
  });

  it('clears failed flag when reindex succeeds after a prior failure', async () => {
    const cortex = 'reindex-recover';
    getCortexDb(cortex);
    seedRowWithModel(cortex, 'old-model');
    // First run: fail
    vi.mocked(gitLib.fetchBranch).mockImplementationOnce(() => {
      throw new Error('git fetch failed');
    });
    await runEmbedModelChecks([cortex], writeLine);
    expect(reindexFailedCortexes.has(cortex)).toBe(true);

    // Second run: succeed (model now matches after reindex)
    // Re-seed with old model so the mismatch is detected again
    seedRowWithModel(cortex, 'old-model');
    vi.mocked(gitLib.fetchBranch).mockReturnValue(undefined);
    mockL1Pages([makeL1Line('2025-01-01T00:00:00Z', 'alice', 'test content')]);
    logs.length = 0;
    await runEmbedModelChecks([cortex], writeLine);
    expect(reindexFailedCortexes.has(cortex)).toBe(false);
  });

  it('skips cortex gracefully when sampleEmbeddingModel throws', async () => {
    // Mock getCortexDb at the module level to throw for this specific cortex name.
    // This tests the catch block in runEmbedModelChecks without relying on
    // filesystem layout details.
    const engrams = await import('../../src/db/engrams.js');
    const spy = vi.spyOn(engrams, 'getCortexDb').mockImplementationOnce(() => {
      throw new Error('simulated DB open failure');
    });

    const cortex = 'fail-cortex';
    await runEmbedModelChecks([cortex], writeLine);

    spy.mockRestore();

    // Should log a skip message; must NOT throw
    expect(logs.some(l => l.includes('skipping') || l.includes('could not sample'))).toBe(true);
    expect(reindexingCortexes.has(cortex)).toBe(false);
  });

  it('does not affect other cortexes while reindexing one', async () => {
    const cortex1 = 'primary';
    const cortex2 = 'secondary';
    getCortexDb(cortex1);
    getCortexDb(cortex2);
    seedRowWithModel(cortex1, 'old-model');
    seedRowWithModel(cortex2, EMBEDDING_MODEL_NAME); // already up to date

    mockL1Pages([makeL1Line('2025-01-01T00:00:00Z', 'alice', 'test content')]);

    await runEmbedModelChecks([cortex1, cortex2], writeLine);

    expect(logs.some(l => l.includes(`cortex "${cortex2}"`) && l.includes('up to date'))).toBe(true);
    expect(logs.some(l => l.includes(`cortex "${cortex1}"`) && l.includes('reindex complete'))).toBe(true);
    expect(reindexingCortexes.has(cortex1)).toBe(false);
    expect(reindexingCortexes.has(cortex2)).toBe(false);
  });

  it('sanitizes newlines in model names and cortex names before logging', async () => {
    const cortex = 'log-inject';
    getCortexDb(cortex);
    // Seed a model name with a newline — simulates a crafted DB write
    seedRowWithModel(cortex, 'evil\ninjected-line');
    mockL1Pages([makeL1Line('2025-01-01T00:00:00Z', 'alice', 'test content')]);

    await runEmbedModelChecks([cortex], writeLine);

    // No log line should contain a literal newline from the model name position
    const modelChangedLog = logs.find(l => l.includes('embedding model changed'));
    expect(modelChangedLog).toBeDefined();
    expect(modelChangedLog).not.toContain('\n');

    // All log lines should be free of injected newlines
    for (const line of logs) {
      expect(line).not.toMatch(/\n.*\n/); // no embedded newline creating a second line
    }
  });

  it('sanitizes newlines in cortex name before logging (log injection via cortex name)', async () => {
    // This tests the safeCortex = sanitizeForLog(cortexName) path.
    // We mock getCortexDb to throw so we hit the catch/skip path with the cortex name in the log.
    const engrams = await import('../../src/db/engrams.js');
    const spy = vi.spyOn(engrams, 'getCortexDb').mockImplementationOnce(() => {
      throw new Error('simulated failure');
    });

    const maliciousCortex = 'cortex\ninjected-second-line';
    await runEmbedModelChecks([maliciousCortex], writeLine);

    spy.mockRestore();

    // The skip log line must not contain a literal embedded newline
    const skipLog = logs.find(l => l.includes('skipping'));
    expect(skipLog).toBeDefined();
    expect(skipLog).not.toContain('\n');
  });
});

// ─── recall busy-state integration ───────────────────────────────────────────

describe('recall returns transient error when cortex is reindexing (AGT-277)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-recall-busy-'));
    process.env.THINK_HOME = tmpHome;
    closeAllCortexDbs();
    reindexingCortexes.clear();
    reindexFailedCortexes.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeAllCortexDbs();
    reindexingCortexes.clear();
    reindexFailedCortexes.clear();
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('recall throws a busy error when the cortex is in reindexingCortexes', async () => {
    const { handleRecall } = await import('../../src/daemon/recall.js');
    const cortex = 'busy-cortex';
    getCortexDb(cortex);

    // Simulate the model check marking this cortex as busy
    reindexingCortexes.add(cortex);

    await expect(
      handleRecall({ cortex, query: 'test query', scope: 'active' })
    ).rejects.toThrow(/reindexed due to an embedding model version change/);

    reindexingCortexes.delete(cortex);
  });

  it('recall succeeds for an unaffected cortex while another is busy', async () => {
    const { handleRecall } = await import('../../src/daemon/recall.js');
    const busyCortex = 'busy-one';
    const readyCortex = 'ready-one';
    getCortexDb(busyCortex);
    getCortexDb(readyCortex);

    reindexingCortexes.add(busyCortex);

    // Busy cortex throws
    await expect(
      handleRecall({ cortex: busyCortex, query: 'hello', scope: 'active' })
    ).rejects.toThrow(/reindexed due to an embedding model version change/);

    // Ready cortex returns normally (empty result — no entries in test DB)
    const result = await handleRecall({ cortex: readyCortex, query: 'hello', scope: 'active' });
    expect(Array.isArray(result)).toBe(true);

    reindexingCortexes.delete(busyCortex);
  });

  it('busy error message mentions "up to several minutes" and daemon log', async () => {
    const { handleRecall } = await import('../../src/daemon/recall.js');
    const cortex = 'msg-check';
    getCortexDb(cortex);
    reindexingCortexes.add(cortex);

    await expect(
      handleRecall({ cortex, query: 'test', scope: 'active' })
    ).rejects.toThrow(/several minutes|retry shortly|daemon log/);

    reindexingCortexes.delete(cortex);
  });

  it('recall returns results (not an error) when the last reindex for that cortex failed', async () => {
    // reindexFailedCortexes → warn via stderr, proceed with recall rather than throwing.
    const { handleRecall } = await import('../../src/daemon/recall.js');
    const cortex = 'failed-reindex-cortex';
    getCortexDb(cortex);

    reindexFailedCortexes.add(cortex);

    // Must resolve (not reject) — stale results are better than no results.
    const result = await handleRecall({ cortex, query: 'test', scope: 'active' });
    expect(Array.isArray(result)).toBe(true);

    reindexFailedCortexes.delete(cortex);
  });

  it('recall succeeds normally when cortex is neither busy nor failed', async () => {
    const { handleRecall } = await import('../../src/daemon/recall.js');
    const cortex = 'normal-cortex';
    getCortexDb(cortex);

    // Neither set contains this cortex
    const result = await handleRecall({ cortex, query: 'hello', scope: 'active' });
    expect(Array.isArray(result)).toBe(true);
  });
});
