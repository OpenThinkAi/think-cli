/**
 * Tests for the CompactionQueue — AGT-299
 *
 * Coverage:
 * 1. Enqueue: three memories → getDepth reflects 3 for that cortex.
 * 2. Worker drains: after start(), all three jobs are processed and depth drops to 0.
 *    (DRY_RUN=true: worker logs intent without making real LLM calls)
 * 3. Retry-with-backoff: pipeline injected via _setPipelineForTest throws once then
 *    succeeds; depth reaches 0 and pipeline was called exactly twice.
 * 4. Worker skip: entry not found in L2 — depth drops to 0 without retry.
 * 5. Backfill: scanAndEnqueueUncompacted enqueues raw kind=memory entries that
 *    have no compaction_links row, skipping compactions and capping at 100.
 *
 * No real network calls are made — DRY_RUN=true in the module means the SDK is
 * never loaded. The @huggingface/transformers mock keeps the DB layer hermetic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CompactionJob } from '../../../src/daemon/compaction/queue.js';

// ---------------------------------------------------------------------------
// Mock @huggingface/transformers (embed.js dep — used by getCortexDb migrations)
// ---------------------------------------------------------------------------

const MOCK_EMBEDDING = Float32Array.from({ length: 384 }, (_, i) => i / 384);

vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn().mockResolvedValue(
    vi.fn().mockResolvedValue({ data: MOCK_EMBEDDING }),
  ),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let thinkHome: string;

function setupThinkHome(): void {
  thinkHome = mkdtempSync(join(tmpdir(), 'think-queue-test-'));
  process.env.THINK_HOME = thinkHome;

  // Minimal config
  const configDir = join(thinkHome, 'config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({ peerId: 'test-peer-queue', cortex: { author: 'tester' } }) + '\n',
    { mode: 0o600 },
  );
}

function teardownThinkHome(): void {
  delete process.env.THINK_HOME;
  rmSync(thinkHome, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CompactionQueue', () => {
  beforeEach(() => {
    setupThinkHome();
  });

  afterEach(() => {
    vi.clearAllMocks();
    teardownThinkHome();
  });

  it('enqueue: three memories increase depth to 3 for that cortex', async () => {
    const { CompactionQueue } = await import('../../../src/daemon/compaction/queue.js');
    const queue = new CompactionQueue();

    queue.enqueue('id-1', 'my-cortex');
    queue.enqueue('id-2', 'my-cortex');
    queue.enqueue('id-3', 'my-cortex');

    expect(queue.getDepth('my-cortex')).toBe(3);
    expect(queue.getDepth('other-cortex')).toBe(0);
  });

  it('worker drains all three jobs and depth reaches 0 (dry-run mode — no LLM calls)', async () => {
    const { CompactionQueue } = await import('../../../src/daemon/compaction/queue.js');
    const { getCortexDb } = await import('../../../src/db/engrams.js');

    const cortex = 'drain-test';
    const db = getCortexDb(cortex);

    // Insert L2 rows so readEntryFromL2 succeeds for all three ids.
    const ids = ['drain-1', 'drain-2', 'drain-3'];
    const ts = new Date().toISOString();
    for (const id of ids) {
      db.prepare(`
        INSERT OR IGNORE INTO memories
          (id, ts, author, content, source_ids, created_at, deleted_at,
           sync_version, origin_peer_id)
        VALUES (?, ?, 'tester', 'test content', '[]', ?, NULL, 1, 'test-peer')
      `).run(id, ts, ts);
    }

    const queue = new CompactionQueue();
    for (const id of ids) {
      queue.enqueue(id, cortex);
    }

    expect(queue.getDepth(cortex)).toBe(3);

    // Start the queue and wait for it to drain.
    queue.start();

    // Poll until depth reaches 0 or timeout (5 s).
    const deadline = Date.now() + 5000;
    while (queue.getDepth(cortex) > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
    }

    expect(queue.getDepth(cortex)).toBe(0);
  });

  it('retry-with-backoff: pipeline throws once then succeeds; depth reaches 0, pipeline called twice', async () => {
    // This test exercises processJobWithRetry's for-loop retry logic via the
    // _setPipelineForTest injection hook — without this, the retry path has
    // zero coverage since DRY_RUN=true never triggers real errors.
    const { CompactionQueue } = await import('../../../src/daemon/compaction/queue.js');

    let callCount = 0;
    const pipeline = vi.fn(async (_job: CompactionJob) => {
      callCount++;
      if (callCount === 1) throw new Error('transient failure');
      // Second call succeeds
    });

    const cortex = 'retry-test';
    const queue = new CompactionQueue();
    queue._setPipelineForTest(pipeline as (job: CompactionJob) => Promise<void>);
    queue.enqueue('retry-id-1', cortex);
    expect(queue.getDepth(cortex)).toBe(1);

    queue.start();

    // Wait up to 4s (first retry delay is 1s; second would be 4s but we only throw once).
    const deadline = Date.now() + 4000;
    while (queue.getDepth(cortex) > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
    }

    expect(queue.getDepth(cortex)).toBe(0);
    // pipeline should have been called exactly twice: once for the initial attempt, once for retry
    expect(pipeline).toHaveBeenCalledTimes(2);
  }, 8000); // generous timeout to allow for the 1s backoff delay

  it('worker drops job and reaches depth 0 after entry not found in L2', async () => {
    // If the L2 row is missing (e.g., embed failed), the worker logs a skip
    // and decrements depth — it should not loop forever.
    const { CompactionQueue } = await import('../../../src/daemon/compaction/queue.js');

    const cortex = 'missing-entry-test';
    const queue = new CompactionQueue();
    queue.enqueue('nonexistent-id', cortex);
    expect(queue.getDepth(cortex)).toBe(1);

    queue.start();

    const deadline = Date.now() + 5000;
    while (queue.getDepth(cortex) > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
    }

    expect(queue.getDepth(cortex)).toBe(0);
  });
});

describe('scanAndEnqueueUncompacted', () => {
  beforeEach(() => {
    setupThinkHome();
  });

  afterEach(() => {
    vi.clearAllMocks();
    teardownThinkHome();
  });

  it('enqueues uncompacted raw kind=memory entries, skips compactions and already-compacted', async () => {
    const { CompactionQueue, scanAndEnqueueUncompacted } = await import('../../../src/daemon/compaction/queue.js');
    const { getCortexDb } = await import('../../../src/db/engrams.js');

    const cortex = 'scan-test';

    // Write L1 JSONL with:
    //   - raw-1: kind=memory, compacted_from=null → skipped (has compaction_links row)
    //   - raw-2: kind=memory, compacted_from=null → should be enqueued
    //   - compacted-1: kind=memory, compacted_from=[raw-1] → skip (is a compaction)
    //   - event-1: kind=event → skip (not memory)
    const repoDir = join(thinkHome, 'repo', cortex);
    mkdirSync(repoDir, { recursive: true });
    const entries = [
      { id: 'raw-1', ts: '2026-05-01T00:00:00Z', kind: 'memory', compacted_from: null, content: 'raw 1', topics: [], supersedes: [], deleted_at: null },
      { id: 'raw-2', ts: '2026-05-02T00:00:00Z', kind: 'memory', compacted_from: null, content: 'raw 2', topics: [], supersedes: [], deleted_at: null },
      { id: 'compacted-1', ts: '2026-05-03T00:00:00Z', kind: 'memory', compacted_from: ['raw-1'], content: 'compacted 1', topics: [], supersedes: ['raw-1'], deleted_at: null },
      { id: 'event-1', ts: '2026-05-04T00:00:00Z', kind: 'event', compacted_from: null, content: 'event 1', topics: [], supersedes: [], deleted_at: null },
    ];
    writeFileSync(
      join(repoDir, '000001.jsonl'),
      entries.map(e => JSON.stringify(e)).join('\n') + '\n',
      'utf-8',
    );

    // Insert compaction_link for raw-1 (simulating it already has a compaction).
    const db = getCortexDb(cortex);
    db.prepare('INSERT OR IGNORE INTO compaction_links (raw_id, compacted_id) VALUES (?, ?)').run('raw-1', 'compacted-1');

    const queue = new CompactionQueue();
    scanAndEnqueueUncompacted(queue, [cortex]);

    // raw-1 skipped (has compaction_links row), compacted-1 skipped (is compaction), event-1 skipped (kind≠memory)
    // Only raw-2 should be enqueued.
    expect(queue.getDepth(cortex)).toBe(1);
  });

  it('caps backfill at 100 entries per cortex', async () => {
    const { CompactionQueue, scanAndEnqueueUncompacted } = await import('../../../src/daemon/compaction/queue.js');

    const cortex = 'cap-test';
    const repoDir = join(thinkHome, 'repo', cortex);
    mkdirSync(repoDir, { recursive: true });

    // Write 150 raw kind=memory entries.
    const lines: string[] = [];
    for (let i = 0; i < 150; i++) {
      lines.push(JSON.stringify({
        id: `raw-${i}`,
        ts: `2026-05-01T${String(i).padStart(6, '0')}Z`,
        kind: 'memory',
        compacted_from: null,
        content: `entry ${i}`,
        topics: [],
        supersedes: [],
        deleted_at: null,
      }));
    }
    writeFileSync(join(repoDir, '000001.jsonl'), lines.join('\n') + '\n', 'utf-8');

    const queue = new CompactionQueue();
    scanAndEnqueueUncompacted(queue, [cortex]);

    expect(queue.getDepth(cortex)).toBe(100);
  });
});
