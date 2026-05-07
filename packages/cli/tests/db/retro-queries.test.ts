import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
import { insertRetro, searchRetros, getRetrosBySyncVersion, tombstoneRetro, VALID_KINDS } from '../../src/db/retro-queries.js';

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

  it('inserts a retro and returns the row', () => {
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
    // Verify expected columns are present
    const expected = ['id', 'content', 'kind', 'cortex_name', 'created_at', 'occurrences', 'tombstoned_at', 'tombstone_reason', 'sync_version'];
    for (const col of expected) {
      expect(colNames).toContain(col);
    }
  });

  it('FTS search round-trips', () => {
    insertRetro(cortex, { content: 'strategy engine type contracts should be documented' });
    insertRetro(cortex, { content: 'always run database migrations inside a transaction' });

    const results = searchRetros(cortex, 'strategy');
    expect(results.length).toBe(1);
    expect(results[0].content).toContain('strategy engine');
  });

  it('FTS search excludes tombstoned rows', () => {
    const row = insertRetro(cortex, { content: 'tombstoned retro content' });
    tombstoneRetro(cortex, row.id, 'superseded');

    const results = searchRetros(cortex, 'tombstoned');
    expect(results.length).toBe(0);
  });

  it('getRetrosBySyncVersion returns rows after the given version', () => {
    const r1 = insertRetro(cortex, { content: 'first retro' });
    const r2 = insertRetro(cortex, { content: 'second retro' });

    const after0 = getRetrosBySyncVersion(cortex, 0);
    expect(after0.length).toBe(2);

    const afterFirst = getRetrosBySyncVersion(cortex, r1.sync_version);
    expect(afterFirst.length).toBe(1);
    expect(afterFirst[0].id).toBe(r2.id);
  });

  it('tombstoneRetro sets tombstoned_at and tombstone_reason', () => {
    const row = insertRetro(cortex, { content: 'to be tombstoned' });
    tombstoneRetro(cortex, row.id, 'duplicate of another retro');

    const db = getCortexDb(cortex);
    const updated = db.prepare('SELECT * FROM retros WHERE id = ?').get(row.id) as { tombstoned_at: string | null; tombstone_reason: string | null };
    expect(updated.tombstoned_at).not.toBeNull();
    expect(updated.tombstone_reason).toBe('duplicate of another retro');
  });

  it('retros are not returned by searchEngrams', async () => {
    const { searchEngrams } = await import('../../src/db/engram-queries.js');
    insertRetro(cortex, { content: 'unique-retro-search-isolation-guard' });
    const engramResults = searchEngrams(cortex, 'unique-retro-search-isolation-guard');
    expect(engramResults.length).toBe(0);
  });

  it('retros are not returned by searchMemories', async () => {
    const { searchMemories } = await import('../../src/db/memory-queries.js');
    insertRetro(cortex, { content: 'unique-retro-memory-isolation-guard' });
    const memoryResults = searchMemories(cortex, 'unique-retro-memory-isolation-guard');
    expect(memoryResults.length).toBe(0);
  });
});
