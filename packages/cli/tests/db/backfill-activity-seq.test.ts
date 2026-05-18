import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
import {
  backfillActivitySeqIfNeeded,
} from '../../src/db/activity-seq.js';

/**
 * Tests for daemon startup backfill of activity_seq (AGT-292 AC #2, #4).
 *
 * Verifies:
 *   1. backfillActivitySeqIfNeeded populates NULL activity_seq rows.
 *   2. It is a no-op when all rows already have a seq.
 *   3. The logger is called when backfilling is needed.
 *   4. The logger is NOT called when no backfill is required.
 *   5. Deleted rows with NULL seq are excluded from the null-count check.
 *   6. Performance: 10K-row backfill completes in <1s (AC #5).
 */

function insertRow(
  cortex: string,
  opts: {
    id: string;
    ts: string;
    activitySeq?: number | null;
    deletedAt?: string | null;
  },
): void {
  const db = getCortexDb(cortex);
  db.prepare(
    `INSERT INTO memories (id, ts, author, content, source_ids, created_at, sync_version, activity_seq, deleted_at)
     VALUES (?, ?, 'test', 'content', '[]', ?, 1, ?, ?)`
  ).run(opts.id, opts.ts, new Date().toISOString(), opts.activitySeq ?? null, opts.deletedAt ?? null);
}

describe('backfillActivitySeqIfNeeded (AGT-292)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;
  const cortex = 'backfill-test';

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-backfill-test-'));
    process.env.THINK_HOME = tmpHome;
    closeAllCortexDbs();
    getCortexDb(cortex);
  });

  afterEach(() => {
    closeAllCortexDbs();
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('populates NULL activity_seq for rows inserted without a seq (AC #4)', () => {
    insertRow(cortex, { id: 'row-a', ts: '2026-01-01T00:00:00Z' });
    insertRow(cortex, { id: 'row-b', ts: '2026-01-02T00:00:00Z' });
    insertRow(cortex, { id: 'row-c', ts: '2026-01-03T00:00:00Z' });

    const db = getCortexDb(cortex);
    const nullBefore = (db.prepare('SELECT COUNT(*) AS n FROM memories WHERE activity_seq IS NULL').get() as { n: number }).n;
    expect(nullBefore).toBe(3);

    backfillActivitySeqIfNeeded(cortex);

    const nullAfter = (db.prepare('SELECT COUNT(*) AS n FROM memories WHERE activity_seq IS NULL').get() as { n: number }).n;
    expect(nullAfter).toBe(0);

    // Verify correct seq assignment: row-a is oldest -> seq 1
    const rows = db.prepare('SELECT id, activity_seq FROM memories ORDER BY activity_seq').all() as { id: string; activity_seq: number }[];
    expect(rows[0].id).toBe('row-a');
    expect(rows[0].activity_seq).toBe(1);
    expect(rows[2].id).toBe('row-c');
    expect(rows[2].activity_seq).toBe(3);
  });

  it('is a no-op when all rows already have activity_seq', () => {
    insertRow(cortex, { id: 'row-a', ts: '2026-02-01T00:00:00Z', activitySeq: 1 });
    insertRow(cortex, { id: 'row-b', ts: '2026-02-02T00:00:00Z', activitySeq: 2 });

    backfillActivitySeqIfNeeded(cortex);

    const db = getCortexDb(cortex);
    const rows = db.prepare('SELECT id, activity_seq FROM memories ORDER BY activity_seq').all() as { id: string; activity_seq: number }[];
    expect(rows[0].activity_seq).toBe(1);
    expect(rows[1].activity_seq).toBe(2);
  });

  it('calls the logger when backfill is needed', () => {
    insertRow(cortex, { id: 'row-a', ts: '2026-03-01T00:00:00Z' });

    const logLines: string[] = [];
    backfillActivitySeqIfNeeded(cortex, (msg) => logLines.push(msg));

    expect(logLines.length).toBe(1);
    expect(logLines[0]).toContain('backfilling activity_seq');
    expect(logLines[0]).toContain(cortex);
  });

  it('does not call the logger when no backfill is required', () => {
    insertRow(cortex, { id: 'row-a', ts: '2026-04-01T00:00:00Z', activitySeq: 1 });

    const logLines: string[] = [];
    backfillActivitySeqIfNeeded(cortex, (msg) => logLines.push(msg));

    expect(logLines.length).toBe(0);
  });

  it('does not count deleted rows as needing backfill', () => {
    // One live row with seq, one deleted row with NULL seq (tombstones are expected to have NULL seq)
    insertRow(cortex, { id: 'row-live', ts: '2026-05-01T00:00:00Z', activitySeq: 1 });
    insertRow(cortex, { id: 'row-dead', ts: '2026-05-02T00:00:00Z', activitySeq: null, deletedAt: '2026-05-03T00:00:00Z' });

    const logLines: string[] = [];
    backfillActivitySeqIfNeeded(cortex, (msg) => logLines.push(msg));

    // No backfill needed -- deleted row with NULL seq is excluded from the count
    expect(logLines.length).toBe(0);
  });
});

describe('backfillActivitySeqIfNeeded -- performance (AGT-292 AC #5)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;
  const cortex = 'backfill-perf-test';

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-backfill-perf-'));
    process.env.THINK_HOME = tmpHome;
    closeAllCortexDbs();
    getCortexDb(cortex);
  });

  afterEach(() => {
    closeAllCortexDbs();
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('backfills 10K rows with NULL activity_seq in <1s', () => {
    const db = getCortexDb(cortex);
    const baseTs = new Date('2026-01-01T00:00:00Z').getTime();

    // Batch-insert 10K rows without activity_seq using a single transaction
    db.exec('BEGIN');
    const stmt = db.prepare(
      `INSERT INTO memories (id, ts, author, content, source_ids, created_at, sync_version)
       VALUES (?, ?, 'perf-test', 'content', '[]', '2026-01-01T00:00:00Z', 1)`
    );
    for (let i = 0; i < 10_000; i++) {
      const ts = new Date(baseTs + i * 1000).toISOString();
      const id = `00000000-0000-0000-${String(i).padStart(4, '0')}-000000000001`;
      stmt.run(id, ts);
    }
    db.exec('COMMIT');

    const start = performance.now();
    backfillActivitySeqIfNeeded(cortex);
    const elapsed = performance.now() - start;

    // AC #5: <1000ms on first call to the affected cortex
    expect(elapsed).toBeLessThan(1000);

    // Verify all rows were stamped
    const nullCount = (db.prepare('SELECT COUNT(*) AS n FROM memories WHERE activity_seq IS NULL').get() as { n: number }).n;
    expect(nullCount).toBe(0);
  });
});
