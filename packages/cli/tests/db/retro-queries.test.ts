import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
import {
  insertRetro,
  VALID_KINDS,
  getPendingRetros,
  mergeRetro,
  setRetroPromoted,
  recordCuratorRun,
  runsSince,
} from '../../src/db/retro-queries.js';

describe('retro-queries', () => {
  let originalHome: string | undefined;
  let tmpHome: string;
  const cortex = 'retro-test';

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-retro-test-'));
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

  it('inserts a retro and returns the full row', () => {
    const row = insertRetro(cortex, { content: 'use transactions for all schema migrations' });
    expect(row.id).toBeTruthy();
    expect(row.content).toBe('use transactions for all schema migrations');
    expect(row.kind).toBeNull();
    expect(row.cortex_name).toBe(cortex);
    expect(row.occurrences).toBe(1);
    expect(row.tombstoned_at).toBeNull();
    expect(row.tombstone_reason).toBeNull();
    expect(typeof row.created_at).toBe('string');
    expect(row.sync_version).toBeGreaterThan(0);
  });

  it('stores a valid kind and round-trips it', () => {
    for (const kind of VALID_KINDS) {
      const row = insertRetro(cortex, { content: `kind test: ${kind}`, kind });
      expect(row.kind).toBe(kind);
    }
  });

  it('stores null kind when omitted', () => {
    const row = insertRetro(cortex, { content: 'no kind' });
    expect(row.kind).toBeNull();
  });

  it('retros table has no expires_at column', () => {
    const db = getCortexDb(cortex);
    const cols = db.prepare('PRAGMA table_info(retros)').all() as { name: string }[];
    const colNames = cols.map(c => c.name);
    expect(colNames).not.toContain('expires_at');
    const expected = ['id', 'content', 'kind', 'cortex_name', 'created_at', 'occurrences', 'tombstoned_at', 'tombstone_reason', 'sync_version'];
    for (const col of expected) {
      expect(colNames).toContain(col);
    }
  });

  it('FTS5 index is populated on insert and supports MATCH queries (AC #5)', () => {
    insertRetro(cortex, { content: 'strategy engine type contracts should be documented' });
    insertRetro(cortex, { content: 'always run database migrations inside a transaction' });

    const db = getCortexDb(cortex);
    const results = db.prepare(
      `SELECT r.* FROM retros r JOIN retros_fts f ON r.rowid = f.rowid
       WHERE retros_fts MATCH ? ORDER BY rank LIMIT 10`
    ).all('strategy') as { content: string }[];

    expect(results.length).toBe(1);
    expect(results[0].content).toContain('strategy engine');
  });

  it('sync_version increments with each insert', () => {
    const r1 = insertRetro(cortex, { content: 'first retro' });
    const r2 = insertRetro(cortex, { content: 'second retro' });
    expect(r2.sync_version).toBeGreaterThan(r1.sync_version);
  });

  it('retros do not appear in engrams table (cross-table isolation)', () => {
    const token = 'isolation9guard';
    insertRetro(cortex, { content: token });
    const db = getCortexDb(cortex);
    const engramResults = db.prepare(
      `SELECT * FROM engrams WHERE content LIKE ? LIMIT 10`
    ).all(`%${token}%`);
    expect(engramResults.length).toBe(0);
  });

  it('retros do not appear in memories table (cross-table isolation)', () => {
    const token = 'isolation9memory9guard';
    insertRetro(cortex, { content: token });
    const db = getCortexDb(cortex);
    const memoryResults = db.prepare(
      `SELECT * FROM memories WHERE content LIKE ? LIMIT 10`
    ).all(`%${token}%`);
    expect(memoryResults.length).toBe(0);
  });

  it('migration v9 adds promoted, last_recalled_at, recalled_count columns to retros', () => {
    const db = getCortexDb(cortex);
    const cols = db.prepare('PRAGMA table_info(retros)').all() as { name: string }[];
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain('promoted');
    expect(colNames).toContain('last_recalled_at');
    expect(colNames).toContain('recalled_count');
  });

  it('migration v9 creates retro_curator_runs table', () => {
    const db = getCortexDb(cortex);
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='retro_curator_runs'`
    ).all() as { name: string }[];
    expect(tables.length).toBe(1);
  });

  it('new retro row has promoted=0, last_recalled_at=null, recalled_count=0 by default', () => {
    const row = insertRetro(cortex, { content: 'default columns check' });
    expect(row.promoted).toBe(0);
    expect(row.last_recalled_at).toBeNull();
    expect(row.recalled_count).toBe(0);
  });

  it('getPendingRetros returns non-tombstoned retros ordered by created_at', () => {
    const r1 = insertRetro(cortex, { content: 'first retro' });
    const r2 = insertRetro(cortex, { content: 'second retro' });
    const r3 = insertRetro(cortex, { content: 'third retro' });

    // Tombstone r2
    const db = getCortexDb(cortex);
    db.prepare(`UPDATE retros SET tombstoned_at = ? WHERE id = ?`).run(new Date().toISOString(), r2.id);

    const pending = getPendingRetros(cortex);
    const ids = pending.map(r => r.id);
    expect(ids).toContain(r1.id);
    expect(ids).not.toContain(r2.id);
    expect(ids).toContain(r3.id);
    expect(ids.indexOf(r1.id)).toBeLessThan(ids.indexOf(r3.id));
  });

  it('mergeRetro increments occurrences on canonical and tombstones merged entry', () => {
    const canonical = insertRetro(cortex, { content: 'run migrations in a transaction' });
    const dupe = insertRetro(cortex, { content: 'always wrap db migrations in transactions' });

    mergeRetro(cortex, canonical.id, dupe.id);

    const db = getCortexDb(cortex);
    const canonicalRow = db.prepare('SELECT * FROM retros WHERE id = ?').get(canonical.id) as { occurrences: number; tombstoned_at: string | null };
    const mergedRow = db.prepare('SELECT * FROM retros WHERE id = ?').get(dupe.id) as { tombstoned_at: string | null; tombstone_reason: string };

    expect(canonicalRow.occurrences).toBe(2);
    expect(canonicalRow.tombstoned_at).toBeNull();
    expect(mergedRow.tombstoned_at).toBeTruthy();
    expect(mergedRow.tombstone_reason).toBe(`merged_into:${canonical.id}`);
  });

  it('mergeRetro merged row still exists in DB (no deletion)', () => {
    const canonical = insertRetro(cortex, { content: 'use prepared statements' });
    const dupe = insertRetro(cortex, { content: 'always use parameterized queries' });

    mergeRetro(cortex, canonical.id, dupe.id);

    const db = getCortexDb(cortex);
    const all = db.prepare('SELECT id FROM retros').all() as { id: string }[];
    const allIds = all.map(r => r.id);
    expect(allIds).toContain(canonical.id);
    expect(allIds).toContain(dupe.id);
  });

  it('setRetroPromoted sets promoted=1 on given ids', () => {
    const r1 = insertRetro(cortex, { content: 'retro one' });
    const r2 = insertRetro(cortex, { content: 'retro two' });

    setRetroPromoted(cortex, [r1.id, r2.id], 1);

    const db = getCortexDb(cortex);
    const row1 = db.prepare('SELECT promoted FROM retros WHERE id = ?').get(r1.id) as { promoted: number };
    const row2 = db.prepare('SELECT promoted FROM retros WHERE id = ?').get(r2.id) as { promoted: number };
    expect(row1.promoted).toBe(1);
    expect(row2.promoted).toBe(1);
  });

  it('setRetroPromoted with promoted=0 demotes a previously promoted retro', () => {
    const r = insertRetro(cortex, { content: 'retro to relegate' });
    setRetroPromoted(cortex, [r.id], 1);
    setRetroPromoted(cortex, [r.id], 0);

    const db = getCortexDb(cortex);
    const row = db.prepare('SELECT promoted FROM retros WHERE id = ?').get(r.id) as { promoted: number };
    expect(row.promoted).toBe(0);
  });

  it('recordCuratorRun inserts a row into retro_curator_runs', () => {
    recordCuratorRun(cortex);
    const db = getCortexDb(cortex);
    const rows = db.prepare('SELECT * FROM retro_curator_runs').all() as { run_at: string }[];
    expect(rows.length).toBe(1);
    expect(typeof rows[0].run_at).toBe('string');
  });

  it('runsSince returns count of runs after the given timestamp', () => {
    const before = new Date(Date.now() - 5000).toISOString();
    recordCuratorRun(cortex);
    recordCuratorRun(cortex);

    const count = runsSince(cortex, before);
    // Both runs happened after `before`
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('runsSince returns 0 when no runs after the given timestamp', () => {
    recordCuratorRun(cortex);
    const after = new Date(Date.now() + 5000).toISOString();
    const count = runsSince(cortex, after);
    expect(count).toBe(0);
  });
});
