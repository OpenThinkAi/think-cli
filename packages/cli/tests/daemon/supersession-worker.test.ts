/**
 * Tests for runSupersessionWorker (AGT-304)
 *
 * These tests cover the two correctness properties that apply.test.ts cannot:
 *   1. Triage gate: worker returns early (no applySupersession call) when
 *      no above-threshold candidates exist or all are non-retro kinds.
 *   2. Prompt-injection guard: LLM-returned supersedes IDs not in the
 *      candidate set are filtered before applySupersession is called.
 *
 * `runSupersession` (the LLM call) is mocked so tests are hermetic.
 * `embed` is mocked to return a deterministic vector.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Mock @huggingface/transformers before any module under test loads it.
// ---------------------------------------------------------------------------

const MOCK_EMBEDDING = Float32Array.from({ length: 384 }, (_, i) => i / 384);

vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn().mockResolvedValue(
    vi.fn().mockResolvedValue({ data: MOCK_EMBEDDING }),
  ),
}));

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const CORTEX = 'worker-test-cortex';

let thinkHome: string;
let originalHome: string | undefined;

beforeEach(async () => {
  originalHome = process.env.THINK_HOME;
  thinkHome = mkdtempSync(join(tmpdir(), 'think-worker-test-'));
  process.env.THINK_HOME = thinkHome;

  // Write minimal config
  const configDir = join(thinkHome, 'config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({ peerId: 'test-peer', syncPort: 9999, cortex: { author: 'test' } }) + '\n',
    { mode: 0o600 },
  );

  const { getCortexDb, closeAllCortexDbs } = await import('../../src/db/engrams.js');
  closeAllCortexDbs();
  // Create and migrate the DB
  getCortexDb(CORTEX);
  closeAllCortexDbs();
});

afterEach(async () => {
  const { closeAllCortexDbs } = await import('../../src/db/engrams.js');
  closeAllCortexDbs();
  vi.resetModules();
  if (originalHome === undefined) delete process.env.THINK_HOME;
  else process.env.THINK_HOME = originalHome;
  rmSync(thinkHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert a minimal L2 row for testing. */
async function insertTestEntry(id: string, content: string, kind = 'retro'): Promise<void> {
  const { getCortexDb } = await import('../../src/db/engrams.js');
  const db = getCortexDb(CORTEX);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO memories
      (id, ts, author, content, source_ids, created_at, deleted_at,
       sync_version, origin_peer_id, embedding, embedding_model, activity_seq, kind)
    VALUES (?, ?, 'test', ?, '[]', ?, NULL, 1, 'test-peer', ?, 'mock', 1, ?)
  `).run(
    id, now, content, now,
    // Store the mock embedding so vector search can find it
    Buffer.from(MOCK_EMBEDDING.buffer, MOCK_EMBEDDING.byteOffset, MOCK_EMBEDDING.byteLength),
    kind,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runSupersessionWorker (AGT-304)', () => {
  it('does not call applySupersession when no candidates are above the similarity threshold', async () => {
    // Mock searchVectors to return empty (no above-threshold results)
    vi.doMock('../../src/lib/search-vectors.js', () => ({
      searchVectors: vi.fn().mockReturnValue([]),
    }));
    const applySpy = vi.fn();
    vi.doMock('../../src/daemon/supersession/apply.js', () => ({
      applySupersession: applySpy,
    }));
    vi.doMock('../../src/daemon/supersession/call.js', () => ({
      runSupersession: vi.fn(),
    }));

    const { runSupersessionWorker } = await import('../../src/daemon/supersession/worker.js');
    await runSupersessionWorker('new-id', new Date().toISOString(), 'some retro content', CORTEX);

    expect(applySpy).not.toHaveBeenCalled();
  });

  it('does not call applySupersession when above-threshold entries are all non-retro kind', async () => {
    const memoryId = 'memory-candidate-001';
    await insertTestEntry(memoryId, 'some memory content', 'memory');

    // Mock searchVectors to return the memory entry above threshold
    vi.doMock('../../src/lib/search-vectors.js', () => ({
      searchVectors: vi.fn().mockReturnValue([{ id: memoryId, similarity: 0.9 }]),
    }));
    const applySpy = vi.fn();
    vi.doMock('../../src/daemon/supersession/apply.js', () => ({
      applySupersession: applySpy,
    }));
    vi.doMock('../../src/daemon/supersession/call.js', () => ({
      runSupersession: vi.fn(),
    }));

    const { runSupersessionWorker } = await import('../../src/daemon/supersession/worker.js');
    await runSupersessionWorker('new-id', new Date().toISOString(), 'some retro content', CORTEX);

    // No retro candidates found — applySupersession must not be called
    expect(applySpy).not.toHaveBeenCalled();
  });

  it('prompt-injection guard: strips LLM-returned supersedes IDs not in the candidate set', async () => {
    const candidateId = 'candidate-retro-001';
    const injectedId = 'injected-unrelated-id';
    await insertTestEntry(candidateId, 'use pnpm in this repo', 'retro');

    vi.doMock('../../src/lib/search-vectors.js', () => ({
      searchVectors: vi.fn().mockReturnValue([{ id: candidateId, similarity: 0.85 }]),
    }));

    // LLM returns an ID that was never in the candidate set (injected)
    vi.doMock('../../src/daemon/supersession/call.js', () => ({
      runSupersession: vi.fn().mockResolvedValue({
        supersedes: [candidateId, injectedId],
        topics: ['package-manager'],
        isDuplicate: false,
      }),
    }));

    let capturedResult: { supersedes: string[] } | null = null;
    vi.doMock('../../src/daemon/supersession/apply.js', () => ({
      applySupersession: vi.fn((_, result: { supersedes: string[] }) => {
        capturedResult = result;
      }),
    }));

    const { runSupersessionWorker } = await import('../../src/daemon/supersession/worker.js');
    await runSupersessionWorker('new-id', new Date().toISOString(), 'use npm', CORTEX);

    // The injected ID must be stripped; only the real candidate ID survives
    expect(capturedResult).not.toBeNull();
    expect(capturedResult!.supersedes).toEqual([candidateId]);
    expect(capturedResult!.supersedes).not.toContain(injectedId);
  });

  it('calls applySupersession with the full result when all supersedes IDs are valid candidates', async () => {
    const candidateId = 'candidate-retro-002';
    await insertTestEntry(candidateId, 'run npm install', 'retro');

    vi.doMock('../../src/lib/search-vectors.js', () => ({
      searchVectors: vi.fn().mockReturnValue([{ id: candidateId, similarity: 0.8 }]),
    }));

    const mockResult = {
      supersedes: [candidateId],
      topics: ['deps'],
      isDuplicate: false,
    };
    vi.doMock('../../src/daemon/supersession/call.js', () => ({
      runSupersession: vi.fn().mockResolvedValue(mockResult),
    }));

    let capturedResult: typeof mockResult | null = null;
    vi.doMock('../../src/daemon/supersession/apply.js', () => ({
      applySupersession: vi.fn((_, result: typeof mockResult) => {
        capturedResult = result;
      }),
    }));

    const { runSupersessionWorker } = await import('../../src/daemon/supersession/worker.js');
    await runSupersessionWorker('new-id', new Date().toISOString(), 'run pnpm install', CORTEX);

    expect(capturedResult).not.toBeNull();
    expect(capturedResult!.supersedes).toEqual([candidateId]);
    expect(capturedResult!.topics).toEqual(['deps']);
  });
});
