/**
 * Tests for applyCompaction (AGT-301)
 *
 * AC coverage:
 *   1. Compacted entry is enqueued to l1_outbox with the correct fields (the
 *      push-debouncer's plumbing drain appends it to the cortex branch — #70
 *      Option B / AGT-458 — so applyCompaction no longer writes the worktree).
 *   2. Compacted entry is inserted into L2 (memories table) with embedding +
 *      activity_seq.
 *   3. compaction_links row (raw_id, compacted_id) is inserted.
 *   4. Entries in llmResult.supersedes get superseded_at + superseded_by set.
 *   5. Idempotent supersession: second call with same superseded ID does not
 *      change the superseded_at timestamp.
 *   6. Empty supersedes list: no rows updated, compaction link and entry still
 *      written correctly.
 *   7. Atomicity: if the L2 transaction fails (COMMIT throws), none of the three
 *      mutations (memories INSERT, compaction_links INSERT, superseded_at UPDATE)
 *      are persisted.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Mock @huggingface/transformers before any module under test loads it.
// ---------------------------------------------------------------------------

import { vi } from 'vitest';

const MOCK_EMBEDDING = Float32Array.from({ length: 384 }, (_, i) => i / 384);

vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn().mockResolvedValue(
    vi.fn().mockResolvedValue({ data: MOCK_EMBEDDING }),
  ),
}));

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const CORTEX = 'compaction-apply-test';

let thinkHome: string;
let originalHome: string | undefined;

beforeEach(async () => {
  originalHome = process.env.THINK_HOME;
  thinkHome = mkdtempSync(join(tmpdir(), 'think-compaction-apply-'));
  process.env.THINK_HOME = thinkHome;

  // Write minimal config so getConfig() and getPeerId() work.
  const configDir = join(thinkHome, 'config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({ peerId: 'test-peer', syncPort: 9999, cortex: { author: 'test-author' } }) + '\n',
    { mode: 0o600 },
  );

  const { getCortexDb, closeAllCortexDbs } = await import('../../src/db/engrams.js');
  closeAllCortexDbs();
  // Trigger migrations so all tables (including superseded_at, compaction_links) exist.
  getCortexDb(CORTEX);
  closeAllCortexDbs();

  // applyCompaction enqueues the compacted line and calls
  // `pushDebouncer.notify()` (the singleton), which schedules a debounced
  // drain that would otherwise spawn a real `git` subprocess against this
  // test's torn-down THINK_HOME after the test returns — a leftover child +
  // timer that can wedge the vitest fork-pool worker. Stub the git seam to a
  // no-op so the scheduled drain stays in-process and harmless.
  const { pushDebouncer } = await import('../../src/daemon/push-debouncer.js');
  pushDebouncer._gitOverride = async () => '';
});

afterEach(async () => {
  const { pushDebouncer } = await import('../../src/daemon/push-debouncer.js');
  pushDebouncer._gitOverride = undefined;
  const { closeAllCortexDbs } = await import('../../src/db/engrams.js');
  closeAllCortexDbs();
  if (originalHome === undefined) delete process.env.THINK_HOME;
  else process.env.THINK_HOME = originalHome;
  rmSync(thinkHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertRawEntry(id: string, content: string): Promise<void> {
  const { getCortexDb } = await import('../../src/db/engrams.js');
  const db = getCortexDb(CORTEX);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO memories
      (id, ts, author, content, source_ids, created_at, deleted_at,
       sync_version, origin_peer_id, embedding, embedding_model, activity_seq, kind)
    VALUES (?, ?, 'test-author', ?, '[]', ?, NULL, 1, 'test-peer', NULL, NULL, 1, 'memory')
  `).run(id, now, content, now);
}

async function getMemoryRow(id: string): Promise<Record<string, unknown> | undefined> {
  const { getCortexDb } = await import('../../src/db/engrams.js');
  const db = getCortexDb(CORTEX);
  return db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;
}

async function getCompactionLink(rawId: string, compactedId: string): Promise<boolean> {
  const { getCortexDb } = await import('../../src/db/engrams.js');
  const db = getCortexDb(CORTEX);
  const row = db.prepare(
    'SELECT 1 FROM compaction_links WHERE raw_id = ? AND compacted_id = ?',
  ).get(rawId, compactedId);
  return row !== undefined;
}

/** Read the enqueued l1_outbox lines (FIFO) for the cortex, parsed. */
async function readOutboxLines(): Promise<Record<string, unknown>[]> {
  const { getCortexDb } = await import('../../src/db/engrams.js');
  const db = getCortexDb(CORTEX);
  const rows = db.prepare('SELECT line FROM l1_outbox ORDER BY id ASC').all() as
    { line: string }[];
  return rows.map((r) => JSON.parse(r.line) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('applyCompaction (AGT-301)', () => {
  it('enqueues the compacted entry to l1_outbox with correct fields', async () => {
    const rawId = 'raw-l1-001';
    await insertRawEntry(rawId, 'Initial thought on sqlite.');

    const { applyCompaction } = await import('../../src/daemon/compaction/apply.js');
    await applyCompaction(
      { id: rawId, ts: new Date().toISOString(), content: 'Initial thought on sqlite.' },
      {
        status: 'ok',
        compacted_text: 'sqlite: chosen for local storage after indexedDb perf issues.',
        supersedes: [],
        topics: ['sqlite', 'storage'],
      },
      CORTEX,
    );

    const lines = await readOutboxLines();
    // Only the compacted entry is enqueued (the raw entry is not re-enqueued).
    expect(lines.length).toBe(1);
    const compacted = lines[0];
    expect(compacted['kind']).toBe('memory');
    expect(compacted['content']).toBe('sqlite: chosen for local storage after indexedDb perf issues.');
    expect(compacted['compacted_from']).toEqual([rawId]);
    expect(compacted['supersedes']).toEqual([]);
    expect(compacted['topics']).toEqual(['sqlite', 'storage']);
    expect(compacted['deleted_at']).toBeNull();
  });

  it('inserts the compacted entry into L2 with activity_seq and kind', async () => {
    const rawId = 'raw-l2-001';
    await insertRawEntry(rawId, 'Auth uses JWT.');

    const { applyCompaction } = await import('../../src/daemon/compaction/apply.js');
    const rawTs = new Date().toISOString();
    await applyCompaction(
      { id: rawId, ts: rawTs, content: 'Auth uses JWT.' },
      {
        status: 'ok',
        compacted_text: 'Auth gateway JWT: Ed25519 since March after key-rotation pain.',
        supersedes: [],
        topics: ['auth', 'jwt'],
      },
      CORTEX,
    );

    // Find the compacted row in L2 (it has compacted_from = rawId in L1;
    // the easiest way to find it is to look for the non-rawId row in memories).
    const { getCortexDb } = await import('../../src/db/engrams.js');
    const db = getCortexDb(CORTEX);
    const rows = db.prepare(
      `SELECT * FROM memories WHERE id != ? AND content = ?`,
    ).all(rawId, 'Auth gateway JWT: Ed25519 since March after key-rotation pain.') as
      Record<string, unknown>[];

    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row['kind']).toBe('memory');
    expect(row['activity_seq']).not.toBeNull();
    expect(row['deleted_at']).toBeNull();
    expect(row['superseded_at']).toBeNull();
    // Embedding bytes written
    expect((row['embedding'] as Uint8Array | null)).not.toBeNull();
  });

  it('inserts a compaction_links row', async () => {
    const rawId = 'raw-link-001';
    await insertRawEntry(rawId, 'pnpm is the package manager.');

    const { applyCompaction } = await import('../../src/daemon/compaction/apply.js');
    await applyCompaction(
      { id: rawId, ts: new Date().toISOString(), content: 'pnpm is the package manager.' },
      {
        status: 'ok',
        compacted_text: 'pnpm: chosen package manager (switched from npm in 2025).',
        supersedes: [],
        topics: ['pnpm'],
      },
      CORTEX,
    );

    // Find the compacted id from the outbox
    const lines = await readOutboxLines();
    const compacted = lines.find(l => Array.isArray(l['compacted_from']) && (l['compacted_from'] as string[]).includes(rawId));
    expect(compacted).toBeDefined();
    const compactedId = compacted!['id'] as string;

    const linked = await getCompactionLink(rawId, compactedId);
    expect(linked).toBe(true);
  });

  it('marks superseded entries in L2 with superseded_at and superseded_by', async () => {
    const rawId = 'raw-supersede-001';
    const oldId = 'old-supersede-001';
    await insertRawEntry(rawId, 'indexedDb has perf problems.');
    await insertRawEntry(oldId, 'indexedDb is the chosen storage.');

    const { applyCompaction } = await import('../../src/daemon/compaction/apply.js');
    await applyCompaction(
      { id: rawId, ts: new Date().toISOString(), content: 'indexedDb has perf problems.' },
      {
        status: 'ok',
        compacted_text: 'Storage: sqlite (returned after indexedDb perf issues).',
        supersedes: [oldId],
        topics: ['storage', 'sqlite'],
      },
      CORTEX,
    );

    const oldRow = await getMemoryRow(oldId);
    expect(oldRow).toBeDefined();
    expect(oldRow!['superseded_at']).not.toBeNull();

    // Find compacted entry id to verify superseded_by
    const lines = await readOutboxLines();
    const compacted = lines.find(l => Array.isArray(l['supersedes']) && (l['supersedes'] as string[]).includes(oldId));
    expect(compacted).toBeDefined();
    expect(oldRow!['superseded_by']).toBe(compacted!['id']);
  });

  it('is idempotent: applying supersession twice does not change superseded_at', async () => {
    const rawId = 'raw-idempotent-001';
    const oldId = 'old-idempotent-001';
    await insertRawEntry(rawId, 'new approach.');
    await insertRawEntry(oldId, 'old approach.');

    const { applyCompaction } = await import('../../src/daemon/compaction/apply.js');
    const llmResult = {
      status: 'ok' as const,
      compacted_text: 'approach: new (replaced old).',
      supersedes: [oldId],
      topics: ['approach'],
    };
    await applyCompaction(
      { id: rawId, ts: new Date().toISOString(), content: 'new approach.' },
      llmResult,
      CORTEX,
    );
    const firstTs = (await getMemoryRow(oldId))!['superseded_at'] as string;

    // Insert a second raw entry to use as the new rawEntry (can't re-use rawId
    // since INSERT OR IGNORE on L2; we just need the supersedes side to stay stable).
    const rawId2 = 'raw-idempotent-002';
    await insertRawEntry(rawId2, 'another update.');
    await applyCompaction(
      { id: rawId2, ts: new Date().toISOString(), content: 'another update.' },
      { ...llmResult, compacted_text: 'approach: second compaction.' },
      CORTEX,
    );

    const secondTs = (await getMemoryRow(oldId))!['superseded_at'] as string;
    // superseded_at IS NOT NULL guard means it should not be overwritten
    expect(secondTs).toBe(firstTs);
  });

  it('handles empty supersedes list without errors', async () => {
    const rawId = 'raw-empty-sup-001';
    await insertRawEntry(rawId, 'standalone note.');

    const { applyCompaction } = await import('../../src/daemon/compaction/apply.js');
    await expect(
      applyCompaction(
        { id: rawId, ts: new Date().toISOString(), content: 'standalone note.' },
        {
          status: 'ok',
          compacted_text: 'standalone note: no related entries found.',
          supersedes: [],
          topics: ['notes'],
        },
        CORTEX,
      ),
    ).resolves.toBeUndefined();

    // The compacted line was enqueued to the outbox.
    const lines = await readOutboxLines();
    const compacted = lines.find(l => Array.isArray(l['compacted_from']));
    expect(compacted).toBeDefined();
  });

  it('atomicity: transaction rollback leaves L2 untouched', async () => {
    // Verify that all three L2 mutations (memories INSERT, compaction_links INSERT,
    // superseded_at UPDATE) are executed atomically. We simulate a mid-transaction
    // failure by preparing a broken statement before calling applyCompaction, which
    // causes the COMMIT to never happen and the transaction to roll back.
    //
    // Technique: corrupt the DB state so the memories INSERT throws (UNIQUE
    // constraint — the compacted id already exists). Because the id is a uuidv7
    // generated inside applyCompaction we can't predict it, so instead we
    // monkeypatch db.exec to throw on COMMIT after the first successful BEGIN.
    const rawId = 'raw-atomic-001';
    const oldId = 'old-atomic-001';
    await insertRawEntry(rawId, 'should roll back.');
    await insertRawEntry(oldId, 'supersede target.');

    const { getCortexDb } = await import('../../src/db/engrams.js');
    const db = getCortexDb(CORTEX);

    // Intercept db.exec so that COMMIT throws, causing applyCompaction's catch
    // block to call ROLLBACK — exercising the atomicity guarantee. We do NOT
    // call ROLLBACK ourselves here; the catch block in apply.ts does that.
    const originalExec = db.exec.bind(db);
    let commitIntercepted = false;
    (db as unknown as Record<string, unknown>)['exec'] = (sql: string) => {
      if (sql === 'COMMIT' && !commitIntercepted) {
        commitIntercepted = true;
        throw new Error('simulated commit failure');
      }
      return originalExec(sql);
    };

    const { applyCompaction } = await import('../../src/daemon/compaction/apply.js');
    await expect(
      applyCompaction(
        { id: rawId, ts: new Date().toISOString(), content: 'should roll back.' },
        {
          status: 'ok',
          compacted_text: 'rolled-back compaction.',
          supersedes: [oldId],
          topics: ['rollback'],
        },
        CORTEX,
      ),
    ).rejects.toThrow('simulated commit failure');

    // Restore original exec
    (db as unknown as Record<string, unknown>)['exec'] = originalExec;

    // L2: no compacted entry should have been inserted
    const compactedRows = db.prepare(
      `SELECT id FROM memories WHERE content = ?`,
    ).all('rolled-back compaction.') as { id: string }[];
    expect(compactedRows.length).toBe(0);

    // L2: no compaction_links row
    const linkRows = db.prepare(
      `SELECT raw_id FROM compaction_links WHERE raw_id = ?`,
    ).all(rawId) as { raw_id: string }[];
    expect(linkRows.length).toBe(0);

    // L2: oldId should NOT have been marked superseded
    const oldRow = await getMemoryRow(oldId);
    expect(oldRow!['superseded_at']).toBeNull();

    // l1_outbox: the compacted line is enqueued INSIDE the transaction, so a
    // rollback must leave no outbox row either (atomic with the L2 writes).
    const outboxRows = db.prepare('SELECT id FROM l1_outbox').all() as { id: number }[];
    expect(outboxRows.length).toBe(0);
  });
});
