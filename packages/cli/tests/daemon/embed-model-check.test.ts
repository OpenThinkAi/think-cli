/**
 * Tests for the daemon startup embedding-model version check — AGT-277.
 *
 * Covers:
 *   1. Up-to-date cortex: no reindex triggered.
 *   2. Model mismatch: reindex triggered, busy flag set then cleared.
 *   3. Null stored model (first-time v3 startup): reindex triggered.
 *   4. While reindexing, recall returns a transient busy error for that cortex
 *      but succeeds for other cortexes.
 *   5. Rows are re-embedded (embedding_model updated) after reindex.
 *   6. DB error during sampleEmbeddingModel: skip that cortex gracefully.
 *   7. sanitizeForLog strips newlines from model names in log output.
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
  listLocalBranches: vi.fn().mockReturnValue([]),
}));

import * as gitLib from '../../src/lib/git.js';
import { EMBEDDING_MODEL_NAME } from '../../src/lib/embed.js';
import { runEmbedModelChecks, reindexingCortexes } from '../../src/daemon/embed-model-check.js';

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
    return;
  }
  const fileNames = pages.map((_, i) => String(i + 1).padStart(6, '0') + '.jsonl');
  vi.mocked(gitLib.listBranchFiles).mockReturnValue(fileNames);
  vi.mocked(gitLib.readFileFromBranch).mockImplementation(
    (_cortex: string, file: string) => {
      const idx = fileNames.indexOf(file);
      return idx >= 0 ? pages[idx] : null;
    }
  );
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
    // Ensure the busy set is clean before each test.
    reindexingCortexes.clear();
  });

  afterEach(() => {
    closeAllCortexDbs();
    reindexingCortexes.clear();
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

    expect(logs.some(l => l.includes('Embedding model changed') && l.includes('old-model') && l.includes(EMBEDDING_MODEL_NAME))).toBe(true);
    expect(logs.some(l => l.includes('reindex complete'))).toBe(true);
    // After reindex, embedding_model should be the current model
    expect(getEmbeddingModel(cortex, id)).toBe(EMBEDDING_MODEL_NAME);
  });

  it('triggers reindex when no embeddings exist yet (null stored model)', async () => {
    const cortex = 'no-embeddings';
    getCortexDb(cortex);
    // Insert a row without embedding_model (v2 data)
    const ts = '2025-02-01T00:00:00Z';
    const content = 'v2 content';
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

  it('busy flag is set during reindex and cleared after completion', async () => {
    const cortex = 'busy-flag';
    getCortexDb(cortex);
    seedRowWithModel(cortex, 'old-model');
    mockL1Pages([makeL1Line('2025-01-01T00:00:00Z', 'alice', 'test content')]);

    // We cannot observe mid-reindex state directly in a unit test because
    // reindexOneCortex is awaited serially. Instead, verify the flag is clear
    // both before and after the call, which ensures finally {} runs correctly.
    expect(reindexingCortexes.has(cortex)).toBe(false);
    await runEmbedModelChecks([cortex], writeLine);
    expect(reindexingCortexes.has(cortex)).toBe(false);
  });

  it('clears busy flag even when reindex throws', async () => {
    const cortex = 'reindex-fail';
    getCortexDb(cortex);
    seedRowWithModel(cortex, 'old-model');
    // Git mock throws so reindexOneCortex fails
    vi.mocked(gitLib.fetchBranch).mockImplementation(() => {
      throw new Error('git fetch failed');
    });

    await runEmbedModelChecks([cortex], writeLine);

    expect(reindexingCortexes.has(cortex)).toBe(false);
    expect(logs.some(l => l.includes('reindex failed'))).toBe(true);
  });

  it('skips cortex gracefully when DB throws during sampling', async () => {
    // Simulate a DB-level error during sampleEmbeddingModel by providing
    // a cortex name that would cause getCortexDb to fail. We achieve this
    // by temporarily pointing THINK_HOME to a file (not a directory) so
    // that mkdirSync throws when the index dir is opened.
    const badHome = join(tmpHome, 'not-a-dir');
    // Create a file at the index path to trigger a dir-creation error
    const { writeFileSync, mkdirSync: mkdirSyncNode } = await import('node:fs');
    mkdirSyncNode(badHome, { recursive: true });
    // Write a file where the index dir would be — causes mkdirSync to fail
    writeFileSync(join(badHome, 'index'), 'this-is-a-file-not-a-dir');
    const oldHome = process.env.THINK_HOME;
    process.env.THINK_HOME = badHome;
    closeAllCortexDbs();

    const cortex = 'fail-cortex';
    try {
      await runEmbedModelChecks([cortex], writeLine);
    } finally {
      process.env.THINK_HOME = oldHome ?? tmpHome;
      closeAllCortexDbs();
    }

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

  it('sanitizes newlines in model names before logging', async () => {
    const cortex = 'log-inject';
    getCortexDb(cortex);
    // Seed a model name with a newline — simulates a crafted DB write
    seedRowWithModel(cortex, 'evil\ninjected-line');
    mockL1Pages([makeL1Line('2025-01-01T00:00:00Z', 'alice', 'test content')]);

    await runEmbedModelChecks([cortex], writeLine);

    // No log line should contain a literal newline inside the model name position
    const modelChangedLog = logs.find(l => l.includes('Embedding model changed'));
    expect(modelChangedLog).toBeDefined();
    // The old= value should not contain \n
    expect(modelChangedLog).not.toContain('\n');
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
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeAllCortexDbs();
    reindexingCortexes.clear();
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('recallOneCortexWithVec throws a busy error when the cortex is in reindexingCortexes', async () => {
    // We test this via handleRecall at the public API level, with the busy flag set.
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
});
