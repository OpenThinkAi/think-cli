import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
import { insertRetro, VALID_KINDS } from '../../src/db/retro-queries.js';

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
});
