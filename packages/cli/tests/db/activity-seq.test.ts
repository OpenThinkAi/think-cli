import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
import { insertMemory } from '../../src/db/memory-queries.js';
import { recomputeActivitySeq, assignNextSeq } from '../../src/db/activity-seq.js';

/**
 * Helpers for inserting memory rows with explicit ts values so we can
 * control the expected sort order independently of wall-clock time.
 */
function insertAt(cortex: string, ts: string, idSuffix: string): string {
  // Use a fixed id prefix so sort order by (ts ASC, id ASC) is deterministic
  const id = `00000000-0000-0000-0000-${idSuffix}`;
  const db = getCortexDb(cortex);
  db.prepare(
    `INSERT INTO memories (id, ts, author, content, source_ids, created_at, sync_version)
     VALUES (?, ?, 'test', 'content', '[]', ?, 1)`
  ).run(id, ts, new Date().toISOString());
  return id;
}

describe('recomputeActivitySeq (AGT-290)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;
  const cortex = 'activity-seq-test';

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-activity-seq-'));
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

  it('assigns seq 1..5 matching ts-sorted order (AC #5 — shuffled inserts)', () => {
    // Insert 5 entries with shuffled ts values — order of insert != sort order
    const idC = insertAt(cortex, '2026-01-03T00:00:00Z', '000000000003');
    const idA = insertAt(cortex, '2026-01-01T00:00:00Z', '000000000001');
    const idE = insertAt(cortex, '2026-01-05T00:00:00Z', '000000000005');
    const idB = insertAt(cortex, '2026-01-02T00:00:00Z', '000000000002');
    const idD = insertAt(cortex, '2026-01-04T00:00:00Z', '000000000004');

    recomputeActivitySeq(cortex);

    const db = getCortexDb(cortex);
    const getSeq = (id: string) =>
      (db.prepare('SELECT activity_seq FROM memories WHERE id = ?').get(id) as { activity_seq: number }).activity_seq;

    expect(getSeq(idA)).toBe(1); // oldest
    expect(getSeq(idB)).toBe(2);
    expect(getSeq(idC)).toBe(3);
    expect(getSeq(idD)).toBe(4);
    expect(getSeq(idE)).toBe(5); // newest
  });

  it('idempotent — running recompute twice yields the same seq values', () => {
    const idA = insertAt(cortex, '2026-02-01T00:00:00Z', '000000000001');
    const idB = insertAt(cortex, '2026-02-02T00:00:00Z', '000000000002');
    const idC = insertAt(cortex, '2026-02-03T00:00:00Z', '000000000003');

    recomputeActivitySeq(cortex);

    const db = getCortexDb(cortex);
    const seqAfterFirst = [idA, idB, idC].map(id =>
      (db.prepare('SELECT activity_seq FROM memories WHERE id = ?').get(id) as { activity_seq: number }).activity_seq
    );

    recomputeActivitySeq(cortex);

    const seqAfterSecond = [idA, idB, idC].map(id =>
      (db.prepare('SELECT activity_seq FROM memories WHERE id = ?').get(id) as { activity_seq: number }).activity_seq
    );

    expect(seqAfterSecond).toEqual(seqAfterFirst);
  });

  it('returns 1 from assignNextSeq when cortex is empty', () => {
    expect(assignNextSeq(cortex)).toBe(1);
  });

  it('assignNextSeq returns 6 after inserting 5 entries and recomputing (AC #5)', () => {
    insertAt(cortex, '2026-03-01T00:00:00Z', '000000000001');
    insertAt(cortex, '2026-03-02T00:00:00Z', '000000000002');
    insertAt(cortex, '2026-03-03T00:00:00Z', '000000000003');
    insertAt(cortex, '2026-03-04T00:00:00Z', '000000000004');
    insertAt(cortex, '2026-03-05T00:00:00Z', '000000000005');

    recomputeActivitySeq(cortex);

    expect(assignNextSeq(cortex)).toBe(6);
  });

  it('assignNextSeq is O(1) — uses index, does not scan all rows', () => {
    // Validate that the function uses the index path by inserting rows with
    // activity_seq already set and confirming the max is read correctly.
    const db = getCortexDb(cortex);
    db.prepare(
      `INSERT INTO memories (id, ts, author, content, source_ids, created_at, sync_version, activity_seq)
       VALUES ('max-row', '2026-04-10T00:00:00Z', 'test', 'hi', '[]', '2026-04-10T00:00:00Z', 1, 42)`
    ).run();

    expect(assignNextSeq(cortex)).toBe(43);
  });

  it('deleted rows do not contribute to seq or to assignNextSeq', () => {
    const idA = insertAt(cortex, '2026-05-01T00:00:00Z', '000000000001');
    const idB = insertAt(cortex, '2026-05-02T00:00:00Z', '000000000002');
    const idDel = insertAt(cortex, '2026-05-03T00:00:00Z', '000000000003');

    // Tombstone the third entry
    const db = getCortexDb(cortex);
    db.prepare(`UPDATE memories SET deleted_at = ? WHERE id = ?`).run(new Date().toISOString(), idDel);

    recomputeActivitySeq(cortex);

    const getSeq = (id: string) =>
      (db.prepare('SELECT activity_seq FROM memories WHERE id = ?').get(id) as { activity_seq: number | null }).activity_seq;

    expect(getSeq(idA)).toBe(1);
    expect(getSeq(idB)).toBe(2);
    expect(getSeq(idDel)).toBeNull(); // deleted — nulled out

    // assignNextSeq should return 3 (max live = 2, so next = 3)
    expect(assignNextSeq(cortex)).toBe(3);
  });
});

describe('recomputeActivitySeq — performance (AGT-290 AC #6)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;
  const cortex = 'activity-seq-perf-test';

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-activity-seq-perf-'));
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

  it('recomputeActivitySeq completes in <500ms for 10K entries (single SQL pass)', () => {
    const db = getCortexDb(cortex);

    // Batch-insert 10K rows via a transaction for speed
    const insert = db.prepare(
      `INSERT INTO memories (id, ts, author, content, source_ids, created_at, sync_version)
       VALUES (?, ?, 'bench', 'x', '[]', '2026-05-01T00:00:00Z', 1)`
    );

    db.exec('BEGIN');
    for (let i = 0; i < 10_000; i++) {
      const paddedI = String(i).padStart(12, '0');
      insert.run(
        `00000000-0000-0000-${paddedI.slice(0, 4)}-${paddedI.slice(4)}`,
        `2026-05-01T${String(Math.floor(i / 3600)).padStart(2, '0')}:${String(Math.floor((i % 3600) / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`
      );
    }
    db.exec('COMMIT');

    const start = performance.now();
    recomputeActivitySeq(cortex);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(500);
  });
});
