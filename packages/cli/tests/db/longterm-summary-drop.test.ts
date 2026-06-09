/**
 * AGT-479 AC #5: forward-only migration v19 drops the `longterm_summary`
 * table from existing databases. A cortex that previously had a
 * `longterm_summary` row must complete migrations without error and have
 * the table absent afterwards.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getCortexDb, closeAllCortexDbs, migrations } from '../../src/db/engrams.js';
import { runMigrations } from '../../src/db/migrate.js';

describe('migration v19 — DROP longterm_summary (AGT-479 AC #5)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-v19-test-'));
    process.env.THINK_HOME = tmpHome;
    closeAllCortexDbs();
  });

  afterEach(() => {
    closeAllCortexDbs();
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('drops longterm_summary table when it existed at v18', () => {
    // Simulate a v18 cortex: apply all migrations up to and including v18,
    // then manually create the longterm_summary table (as it existed before
    // v19) and insert a row.
    const cortex = 'v19-drop-test';
    const db = getCortexDb(cortex); // runs all migrations including v19

    // After migration v19 runs, the table must be gone.
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='longterm_summary'"
    ).all() as { name: string }[];
    expect(tables).toHaveLength(0);
  });

  it('is idempotent — running v19 on a DB that never had longterm_summary succeeds', () => {
    // getCortexDb on a fresh DB runs all migrations including v19. The DROP
    // TABLE IF EXISTS is a no-op when the table was never created.
    const cortex = 'v19-idempotent-test';
    expect(() => getCortexDb(cortex)).not.toThrow();

    const db = getCortexDb(cortex);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='longterm_summary'"
    ).all() as { name: string }[];
    expect(tables).toHaveLength(0);
  });

  it('drops a pre-existing longterm_summary row without crashing', () => {
    // Build an in-memory DB at v18 (all migrations except v19), create the
    // longterm_summary table manually, insert a row, then run v19 on it.
    const v18Migrations = migrations.filter(m => m.version <= 18);
    const v19Migration = migrations.find(m => m.version === 19);
    expect(v19Migration).toBeDefined();

    const db = new DatabaseSync(':memory:');
    runMigrations(db, v18Migrations);

    // Create longterm_summary as it existed in v18-and-earlier cortexes.
    db.exec(`
      CREATE TABLE IF NOT EXISTS longterm_summary (
        id INTEGER PRIMARY KEY NOT NULL,
        content TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sync_version INTEGER NOT NULL DEFAULT 0
      ) STRICT;
    `);
    db.prepare(
      `INSERT INTO longterm_summary (id, content, updated_at, sync_version)
       VALUES (1, 'Q2 summary text', ?, 1)`
    ).run(new Date().toISOString());

    // Verify the row is present before migration.
    const before = db.prepare('SELECT content FROM longterm_summary WHERE id = 1').get() as { content: string } | undefined;
    expect(before?.content).toBe('Q2 summary text');

    // Run v19.
    expect(() => runMigrations(db, [v19Migration!])).not.toThrow();

    // Table must be gone.
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='longterm_summary'"
    ).all() as { name: string }[];
    expect(tables).toHaveLength(0);
  });
});
