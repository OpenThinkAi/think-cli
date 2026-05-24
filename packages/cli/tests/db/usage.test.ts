import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
import { getUsageDb, closeUsageDb, recordRetroSurfacings } from '../../src/db/usage-db.js';
import { getRetroUsageReport } from '../../src/db/usage-queries.js';

const cortex = 'usage-test';

function insertRetroMemory(id: string, content: string, createdAt: string): void {
  const db = getCortexDb(cortex);
  db.prepare(
    `INSERT INTO memories (id, ts, author, content, source_ids, created_at, sync_version, kind)
     VALUES (?, ?, 'tester', ?, '[]', ?, 0, 'retro')`,
  ).run(id, createdAt, content, createdAt);
}

/** Insert a surfacing row directly so surfaced_at/source/query are deterministic. */
function insertSurfacing(
  retroId: string,
  query: string,
  surfacedAt: string,
  source: string,
  score: number | null = 0.5,
): void {
  const db = getUsageDb();
  db.prepare(
    `INSERT INTO retro_surfacings (retro_id, cortex, query, surfaced_at, score, source)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(retroId, cortex, query, surfacedAt, score, source);
}

describe('usage telemetry', () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-usage-test-'));
    process.env.THINK_HOME = tmpHome;
    closeAllCortexDbs();
    closeUsageDb();
    getCortexDb(cortex);
  });

  afterEach(() => {
    closeAllCortexDbs();
    closeUsageDb();
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  describe('recordRetroSurfacings', () => {
    it('appends one row per surfacing', () => {
      recordRetroSurfacings([
        { retro_id: 'r1', cortex, query: 'q', score: 0.9, source: 'recall' },
        { retro_id: 'r2', cortex, query: 'q', score: 0.8, source: 'brief' },
      ]);
      const n = (getUsageDb().prepare('SELECT COUNT(*) AS n FROM retro_surfacings').get() as { n: number }).n;
      expect(n).toBe(2);
    });

    it('is a no-op for an empty batch', () => {
      recordRetroSurfacings([]);
      const n = (getUsageDb().prepare('SELECT COUNT(*) AS n FROM retro_surfacings').get() as { n: number }).n;
      expect(n).toBe(0);
    });
  });

  describe('getRetroUsageReport', () => {
    it('returns an empty report when nothing has happened', () => {
      const report = getRetroUsageReport();
      expect(report.total_surfacings).toBe(0);
      expect(report.surfaced).toEqual([]);
    });

    it('aggregates surfacings per retro with source split, queries, and content join', () => {
      insertRetroMemory('r1', 'always run migrations in a transaction', '2026-05-20T10:00:00.000Z');
      insertSurfacing('r1', 'migrations', '2026-05-21T10:00:00.000Z', 'brief');
      insertSurfacing('r1', 'migrations', '2026-05-21T11:00:00.000Z', 'recall');
      insertSurfacing('r1', 'schema changes', '2026-05-22T09:00:00.000Z', 'recall');

      const report = getRetroUsageReport();
      expect(report.total_surfacings).toBe(3);
      expect(report.surfaced).toHaveLength(1);

      const e = report.surfaced[0];
      expect(e.retro_id).toBe('r1');
      expect(e.cortex).toBe(cortex);
      expect(e.content).toBe('always run migrations in a transaction');
      expect(e.surface_count).toBe(3);
      expect(e.brief_count).toBe(1);
      expect(e.recall_count).toBe(2);
      expect(e.first_surfaced).toBe('2026-05-21T10:00:00.000Z');
      expect(e.last_surfaced).toBe('2026-05-22T09:00:00.000Z');
      // distinct queries, most-recent first
      expect(e.queries).toEqual(['schema changes', 'migrations']);
      // per-day timeline buckets ascending
      expect(e.timeline).toEqual([
        { date: '2026-05-21', count: 2 },
        { date: '2026-05-22', count: 1 },
      ]);
    });

    it('orders surfaced retros by surface count descending', () => {
      insertRetroMemory('r1', 'one hit', '2026-05-20T10:00:00.000Z');
      insertRetroMemory('r2', 'three hits', '2026-05-20T10:00:00.000Z');
      insertSurfacing('r1', 'q', '2026-05-21T10:00:00.000Z', 'recall');
      insertSurfacing('r2', 'q', '2026-05-21T10:00:00.000Z', 'recall');
      insertSurfacing('r2', 'q', '2026-05-21T10:01:00.000Z', 'recall');
      insertSurfacing('r2', 'q', '2026-05-21T10:02:00.000Z', 'recall');

      const report = getRetroUsageReport();
      expect(report.surfaced.map((e) => e.retro_id)).toEqual(['r2', 'r1']);
    });

    it('reports retros that exist but never surfaced as dead', () => {
      insertRetroMemory('r1', 'surfaced retro', '2026-05-20T10:00:00.000Z');
      insertRetroMemory('r2', 'never surfaced retro', '2026-05-20T10:00:00.000Z');
      insertSurfacing('r1', 'q', '2026-05-21T10:00:00.000Z', 'recall');

      const report = getRetroUsageReport();
      expect(report.surfaced.map((e) => e.retro_id)).toEqual(['r1']);
      expect(report.dead).toHaveLength(1);
      expect(report.dead[0].retro_id).toBe('r2');
      expect(report.dead[0].content).toBe('never surfaced retro');
    });

    it('keeps a surfaced retro whose memory row is gone (content null, not dead)', () => {
      insertSurfacing('ghost', 'q', '2026-05-21T10:00:00.000Z', 'recall');
      const report = getRetroUsageReport();
      expect(report.surfaced).toHaveLength(1);
      expect(report.surfaced[0].retro_id).toBe('ghost');
      expect(report.surfaced[0].content).toBeNull();
      expect(report.dead).toHaveLength(0);
    });
  });
});
