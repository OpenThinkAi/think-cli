import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../../src/db/migrate.js';
import { migrations, getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
import { getCompactionsForRaw, getRawForCompaction } from '../../src/db/compaction-links-queries.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('migration v12 — compaction_links table (AGT-271)', () => {
  it('creates compaction_links table with correct columns', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db, migrations);

    const cols = db.prepare('PRAGMA table_info(compaction_links)').all() as { name: string }[];
    expect(cols.some(c => c.name === 'raw_id')).toBe(true);
    expect(cols.some(c => c.name === 'compacted_id')).toBe(true);

    db.close();
  });

  it('creates idx_compaction_links_compacted_id index (reverse lookup path)', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db, migrations);

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='compaction_links'"
    ).all() as { name: string }[];
    // The PRIMARY KEY (raw_id, compacted_id) serves forward lookups via its
    // leading-column prefix — no explicit raw_id index needed. The explicit
    // index is only for the reverse (compacted_id → raw_id) direction.
    expect(indexes.some(idx => idx.name === 'idx_compaction_links_compacted_id')).toBe(true);

    db.close();
  });

  it('migration is idempotent — re-running does not throw', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db, migrations);
    expect(() => runMigrations(db, migrations)).not.toThrow();
    db.close();
  });

  it('rejects duplicate (raw_id, compacted_id) pairs due to PRIMARY KEY', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db, migrations);

    db.prepare(
      "INSERT INTO compaction_links (raw_id, compacted_id) VALUES ('r1', 'c1')"
    ).run();

    expect(() => {
      db.prepare(
        "INSERT INTO compaction_links (raw_id, compacted_id) VALUES ('r1', 'c1')"
      ).run();
    }).toThrow();

    db.close();
  });
});

describe('getCompactionsForRaw / getRawForCompaction (AGT-271)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;
  const cortex = 'compaction-links-test';

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-compaction-links-'));
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

  it('returns empty arrays when no links exist', () => {
    expect(getCompactionsForRaw(cortex, 'raw-missing')).toEqual([]);
    expect(getRawForCompaction(cortex, 'compacted-missing')).toEqual([]);
  });

  it('getCompactionsForRaw returns all compacted_ids for a raw_id', () => {
    // Two compacted entries both fold the same raw entry
    const db = getCortexDb(cortex);
    db.prepare(
      "INSERT INTO compaction_links (raw_id, compacted_id) VALUES ('raw-1', 'compacted-a')"
    ).run();
    db.prepare(
      "INSERT INTO compaction_links (raw_id, compacted_id) VALUES ('raw-1', 'compacted-b')"
    ).run();

    const result = getCompactionsForRaw(cortex, 'raw-1');
    expect(result).toHaveLength(2);
    expect(result).toContain('compacted-a');
    expect(result).toContain('compacted-b');
  });

  it('getRawForCompaction returns the raw_ids that were folded into a compacted entry', () => {
    const db = getCortexDb(cortex);
    db.prepare(
      "INSERT INTO compaction_links (raw_id, compacted_id) VALUES ('raw-1', 'compacted-a')"
    ).run();
    db.prepare(
      "INSERT INTO compaction_links (raw_id, compacted_id) VALUES ('raw-2', 'compacted-a')"
    ).run();

    const result = getRawForCompaction(cortex, 'compacted-a');
    expect(result).toHaveLength(2);
    expect(result).toContain('raw-1');
    expect(result).toContain('raw-2');
  });

  it('lookup is scoped — different cortex returns empty', () => {
    // Insert into the main test cortex
    const db = getCortexDb(cortex);
    db.prepare(
      "INSERT INTO compaction_links (raw_id, compacted_id) VALUES ('raw-x', 'comp-x')"
    ).run();

    // Create a second cortex — should have no rows
    const cortex2 = 'compaction-links-test-2';
    getCortexDb(cortex2);

    expect(getCompactionsForRaw(cortex2, 'raw-x')).toEqual([]);
    expect(getRawForCompaction(cortex2, 'comp-x')).toEqual([]);
  });
});
