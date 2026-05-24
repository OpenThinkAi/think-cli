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

/** Insert a surfacing row directly so all fields are deterministic. */
function insertSurfacing(opts: {
  retroId: string;
  query?: string;
  surfacedAt: string;
  source?: string;
  score?: number | null;
  sessionId?: string | null;
  sessionSeq?: number | null;
}): void {
  const db = getUsageDb();
  db.prepare(
    `INSERT INTO retro_surfacings (retro_id, cortex, query, surfaced_at, score, source, session_id, session_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.retroId,
    cortex,
    opts.query ?? 'q',
    opts.surfacedAt,
    opts.score ?? 0.5,
    opts.source ?? 'recall',
    opts.sessionId ?? null,
    opts.sessionSeq ?? null,
  );
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
    it('appends one row per returned retro', () => {
      recordRetroSurfacings({
        query: 'q',
        source: 'recall',
        session_id: null,
        retros: [
          { retro_id: 'r1', cortex, score: 0.9 },
          { retro_id: 'r2', cortex, score: 0.8 },
        ],
      });
      const n = (getUsageDb().prepare('SELECT COUNT(*) AS n FROM retro_surfacings').get() as { n: number }).n;
      expect(n).toBe(2);
    });

    it('is a no-op when no retros were returned', () => {
      recordRetroSurfacings({ query: 'q', source: 'recall', session_id: null, retros: [] });
      const n = (getUsageDb().prepare('SELECT COUNT(*) AS n FROM retro_surfacings').get() as { n: number }).n;
      expect(n).toBe(0);
    });

    it('assigns session_seq as the call ordinal within a session', () => {
      const db = getUsageDb();
      // First call in session s1 -> seq 1
      recordRetroSurfacings({ query: 'a', source: 'brief', session_id: 's1', retros: [{ retro_id: 'r1', cortex, score: 1 }] });
      // Second call in s1 -> seq 2 (two retros, same seq)
      recordRetroSurfacings({ query: 'b', source: 'recall', session_id: 's1', retros: [{ retro_id: 'r1', cortex, score: 1 }, { retro_id: 'r2', cortex, score: 1 }] });
      // A different session starts fresh at seq 1
      recordRetroSurfacings({ query: 'c', source: 'brief', session_id: 's2', retros: [{ retro_id: 'r1', cortex, score: 1 }] });

      const seqs = db
        .prepare('SELECT session_id, session_seq, query FROM retro_surfacings ORDER BY id')
        .all() as { session_id: string; session_seq: number; query: string }[];
      expect(seqs.find((r) => r.query === 'a')!.session_seq).toBe(1);
      expect(seqs.filter((r) => r.query === 'b').map((r) => r.session_seq)).toEqual([2, 2]);
      expect(seqs.find((r) => r.query === 'c')!.session_seq).toBe(1);
    });
  });

  describe('getRetroUsageReport', () => {
    it('returns an empty report when nothing has happened', () => {
      const report = getRetroUsageReport();
      expect(report.total_surfacings).toBe(0);
      expect(report.surfaced).toEqual([]);
    });

    it('aggregates count, source breakdown, session stage, queries, and content', () => {
      insertRetroMemory('r1', 'always run migrations in a transaction', '2026-05-20T10:00:00.000Z');
      insertSurfacing({ retroId: 'r1', query: 'migrations', surfacedAt: '2026-05-21T10:00:00.000Z', source: 'brief', sessionId: 's1', sessionSeq: 1 });
      insertSurfacing({ retroId: 'r1', query: 'migrations', surfacedAt: '2026-05-21T11:00:00.000Z', source: 'recall', sessionId: 's1', sessionSeq: 2 });
      insertSurfacing({ retroId: 'r1', query: 'schema changes', surfacedAt: '2026-05-22T09:00:00.000Z', source: 'hook', sessionId: 's2', sessionSeq: 1 });

      const report = getRetroUsageReport();
      expect(report.total_surfacings).toBe(3);
      expect(report.surfaced).toHaveLength(1);

      const e = report.surfaced[0];
      expect(e.retro_id).toBe('r1');
      expect(e.cortex).toBe(cortex);
      expect(e.content).toBe('always run migrations in a transaction');
      expect(e.surface_count).toBe(3);
      expect(e.by_source).toEqual({ brief: 1, recall: 1, mcp: 0, hook: 1 });
      expect(e.session_start_count).toBe(2); // two calls were seq=1
      expect(e.mid_session_count).toBe(1);
      expect(e.first_surfaced).toBe('2026-05-21T10:00:00.000Z');
      expect(e.last_surfaced).toBe('2026-05-22T09:00:00.000Z');
      expect(e.queries).toEqual(['schema changes', 'migrations']);
      expect(e.timeline).toEqual([
        { date: '2026-05-21', count: 2 },
        { date: '2026-05-22', count: 1 },
      ]);
    });

    it('orders surfaced retros by call count descending', () => {
      insertRetroMemory('r1', 'one hit', '2026-05-20T10:00:00.000Z');
      insertRetroMemory('r2', 'three hits', '2026-05-20T10:00:00.000Z');
      insertSurfacing({ retroId: 'r1', surfacedAt: '2026-05-21T10:00:00.000Z' });
      insertSurfacing({ retroId: 'r2', surfacedAt: '2026-05-21T10:00:00.000Z' });
      insertSurfacing({ retroId: 'r2', surfacedAt: '2026-05-21T10:01:00.000Z' });
      insertSurfacing({ retroId: 'r2', surfacedAt: '2026-05-21T10:02:00.000Z' });

      const report = getRetroUsageReport();
      expect(report.surfaced.map((e) => e.retro_id)).toEqual(['r2', 'r1']);
    });

    it('reports retros that exist but were never called as dead', () => {
      insertRetroMemory('r1', 'called retro', '2026-05-20T10:00:00.000Z');
      insertRetroMemory('r2', 'never called retro', '2026-05-20T10:00:00.000Z');
      insertSurfacing({ retroId: 'r1', surfacedAt: '2026-05-21T10:00:00.000Z' });

      const report = getRetroUsageReport();
      expect(report.surfaced.map((e) => e.retro_id)).toEqual(['r1']);
      expect(report.dead).toHaveLength(1);
      expect(report.dead[0].retro_id).toBe('r2');
      expect(report.dead[0].content).toBe('never called retro');
    });

    it('keeps a called retro whose memory row is gone (content null, not dead)', () => {
      insertSurfacing({ retroId: 'ghost', surfacedAt: '2026-05-21T10:00:00.000Z' });
      const report = getRetroUsageReport();
      expect(report.surfaced).toHaveLength(1);
      expect(report.surfaced[0].retro_id).toBe('ghost');
      expect(report.surfaced[0].content).toBeNull();
      expect(report.dead).toHaveLength(0);
    });
  });
});
