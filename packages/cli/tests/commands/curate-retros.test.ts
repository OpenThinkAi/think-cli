import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { curateRetrosCommand } from '../../src/commands/curate-retros.js';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
import {
  insertRetro,
  getPendingRetros,
  setRetroPromoted,
  getPromotedRetrosForRelegation,
  runsSince,
} from '../../src/db/retro-queries.js';
import * as retroCurator from '../../src/lib/retro-curator.js';

function makeProgram(): Command {
  const prog = new Command();
  prog.option('-C, --cortex <name>', 'Use a specific cortex for this command');
  prog.addCommand(curateRetrosCommand);
  return prog;
}

/** Write a minimal config with an active cortex into the temp THINK_HOME. */
function writeActiveConfig(tmpHome: string, activeCortex: string): void {
  const configDir = join(tmpHome, 'config');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    peerId: 'test-peer',
    syncPort: 47821,
    cortex: { active: activeCortex, author: 'tester' },
  }));
}

/** Insert two retro_curator_runs rows with distinct timestamps after `since`. */
function insertTwoCuratorRuns(cortex: string, since: string): void {
  const db = getCortexDb(cortex);
  const t1 = new Date(new Date(since).getTime() + 1000).toISOString();
  const t2 = new Date(new Date(since).getTime() + 2000).toISOString();
  db.prepare('INSERT OR IGNORE INTO retro_curator_runs (run_at) VALUES (?)').run(t1);
  db.prepare('INSERT OR IGNORE INTO retro_curator_runs (run_at) VALUES (?)').run(t2);
}

describe('think curate-retros command', () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-curate-retros-test-'));
    process.env.THINK_HOME = tmpHome;
    closeAllCortexDbs();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Default: mock runRetroDedupe to return no equivalences (no network call)
    vi.spyOn(retroCurator, 'runRetroDedupe').mockResolvedValue([]);
  });

  afterEach(() => {
    closeAllCortexDbs();
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it('exits non-zero when no cortex is specified and no active cortex configured', async () => {
    // No -C flag, no config in tmpHome → getConfig returns no active cortex
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'curate-retros']);
    expect(process.exitCode).toBe(1);
  });

  it('uses active cortex from config when -C is not provided', async () => {
    const cortex = 'active-cortex-cfg-test';
    writeActiveConfig(tmpHome, cortex);
    getCortexDb(cortex);

    vi.spyOn(retroCurator, 'getCandidatePairs').mockReturnValue([]);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'curate-retros']);

    // Command ran without exitCode 1 → used active cortex
    expect(process.exitCode).toBeFalsy();
  });

  it('runs without error on empty cortex (no retros)', async () => {
    const cortex = 'empty-cortex';
    getCortexDb(cortex);

    vi.spyOn(retroCurator, 'getCandidatePairs').mockReturnValue([]);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'curate-retros']);

    expect(process.exitCode).toBeFalsy();
    expect(retroCurator.runRetroDedupe).not.toHaveBeenCalled();
  });

  it('records a curator run on successful completion', async () => {
    const cortex = 'run-record-test';
    getCortexDb(cortex);

    vi.spyOn(retroCurator, 'getCandidatePairs').mockReturnValue([]);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'curate-retros']);

    // Re-open DB after the command closes it
    const db = getCortexDb(cortex);
    const runs = db.prepare('SELECT COUNT(*) as count FROM retro_curator_runs').get() as { count: number };
    expect(runs.count).toBe(1);
  });

  it('dedupe-merge: two semantically equivalent retros → canonical occurrences=2, newer tombstoned', async () => {
    const cortex = 'dedupe-test';
    getCortexDb(cortex);

    const canonical = insertRetro(cortex, { content: 'run all database migrations inside a transaction' });
    const dupe = insertRetro(cortex, { content: 'always wrap schema migrations in a transaction' });

    vi.spyOn(retroCurator, 'runRetroDedupe').mockResolvedValue([
      { a: canonical.id, b: dupe.id, equivalent: true },
    ]);
    vi.spyOn(retroCurator, 'getCandidatePairs').mockReturnValue([
      { a: canonical, b: dupe },
    ]);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'curate-retros']);

    // Re-open DB after command closes it
    const db = getCortexDb(cortex);
    const canonicalRow = db.prepare('SELECT * FROM retros WHERE id = ?').get(canonical.id) as {
      occurrences: number;
      tombstoned_at: string | null;
    };
    const dupeRow = db.prepare('SELECT * FROM retros WHERE id = ?').get(dupe.id) as {
      tombstoned_at: string | null;
      tombstone_reason: string;
    };

    expect(canonicalRow.occurrences).toBe(2);
    expect(canonicalRow.tombstoned_at).toBeNull();
    expect(dupeRow.tombstoned_at).toBeTruthy();
    expect(dupeRow.tombstone_reason).toBe(`merged_into:${canonical.id}`);
  });

  it('dedupe-merge: merged row is preserved in storage (no deletion — AC #6)', async () => {
    const cortex = 'no-deletion-test';
    getCortexDb(cortex);

    const canonical = insertRetro(cortex, { content: 'use FTS5 for full-text search indexing' });
    const dupe = insertRetro(cortex, { content: 'use fts5 virtual tables for text search' });

    vi.spyOn(retroCurator, 'runRetroDedupe').mockResolvedValue([
      { a: canonical.id, b: dupe.id, equivalent: true },
    ]);
    vi.spyOn(retroCurator, 'getCandidatePairs').mockReturnValue([
      { a: canonical, b: dupe },
    ]);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'curate-retros']);

    const db = getCortexDb(cortex);
    const all = db.prepare('SELECT id FROM retros').all() as { id: string }[];
    const allIds = all.map(r => r.id);
    expect(allIds).toContain(canonical.id);
    expect(allIds).toContain(dupe.id);
  });

  it('promotion: retro with occurrences >= 2 is set promoted=1 (AC #4)', async () => {
    const cortex = 'promotion-test';
    getCortexDb(cortex);

    const r = insertRetro(cortex, { content: 'always index foreign keys in SQLite' });
    // Manually bump occurrences to simulate a prior merge
    const db = getCortexDb(cortex);
    db.prepare('UPDATE retros SET occurrences = 2 WHERE id = ?').run(r.id);

    vi.spyOn(retroCurator, 'getCandidatePairs').mockReturnValue([]);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'curate-retros']);

    // Re-open DB after command closes it
    const freshDb = getCortexDb(cortex);
    const row = freshDb.prepare('SELECT promoted FROM retros WHERE id = ?').get(r.id) as { promoted: number };
    expect(row.promoted).toBe(1);
  });

  it('promotion: single-occurrence retro remains promoted=0', async () => {
    const cortex = 'no-promotion-test';
    getCortexDb(cortex);

    const r = insertRetro(cortex, { content: 'single occurrence retro should not be promoted' });

    vi.spyOn(retroCurator, 'getCandidatePairs').mockReturnValue([]);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'curate-retros']);

    const freshDb = getCortexDb(cortex);
    const row = freshDb.prepare('SELECT promoted FROM retros WHERE id = ?').get(r.id) as { promoted: number };
    expect(row.promoted).toBe(0);
  });

  it('relegation: promoted retro recalled before N runs is demoted to promoted=0, row stays (AC #5, #6)', () => {
    // Tests relegation semantics directly using the DB helpers (no command invocation,
    // since the command's threshold defaults to 50 which is impractical in tests)
    const cortex = 'relegation-direct-test';
    getCortexDb(cortex);

    const r = insertRetro(cortex, { content: 'use WAL mode for SQLite concurrency' });
    const db = getCortexDb(cortex);
    const pastTs = new Date(Date.now() - 10000).toISOString();

    // Simulate promoted retro that was last recalled 10s ago
    db.prepare(
      'UPDATE retros SET occurrences = 2, promoted = 1, last_recalled_at = ? WHERE id = ?'
    ).run(pastTs, r.id);

    // Insert 2 curator runs after pastTs (distinct timestamps)
    insertTwoCuratorRuns(cortex, pastTs);

    // Relegation candidates: promoted retros with last_recalled_at not null
    const candidates = getPromotedRetrosForRelegation(cortex);
    expect(candidates.map(c => c.id)).toContain(r.id);

    // runsSince returns 2 runs since pastTs → meets threshold of 2
    const runs = runsSince(cortex, pastTs);
    expect(runs).toBeGreaterThanOrEqual(2);

    const toRelegate = candidates.filter(c => runsSince(cortex, c.last_recalled_at!) >= 2);
    expect(toRelegate.map(c => c.id)).toContain(r.id);

    // Apply relegation
    setRetroPromoted(cortex, [r.id], 0);

    const row = db.prepare('SELECT * FROM retros WHERE id = ?').get(r.id) as {
      promoted: number;
      tombstoned_at: string | null;
    };
    // Row is demoted — not deleted
    expect(row.promoted).toBe(0);
    expect(row.tombstoned_at).toBeNull();

    // Relegated row is still queryable
    const allRows = db.prepare('SELECT id FROM retros').all() as { id: string }[];
    expect(allRows.map(row2 => row2.id)).toContain(r.id);
  });

  it('retros never recalled (last_recalled_at IS NULL) stay promoted even with occurrences >= 2 (AC #5)', () => {
    const cortex = 'no-relegate-null-recall-test';
    getCortexDb(cortex);

    const r = insertRetro(cortex, { content: 'never-recalled retro stays promoted' });
    const db = getCortexDb(cortex);
    db.prepare('UPDATE retros SET occurrences = 3, promoted = 1 WHERE id = ?').run(r.id);

    // last_recalled_at IS NULL → should NOT appear in relegation candidates
    const candidates = getPromotedRetrosForRelegation(cortex);
    expect(candidates.map(c => c.id)).not.toContain(r.id);
  });

  it('--dry-run does not commit any changes', async () => {
    const cortex = 'dry-run-test';
    getCortexDb(cortex);

    const r1 = insertRetro(cortex, { content: 'dry run canonical retro' });
    const r2 = insertRetro(cortex, { content: 'dry run duplicate retro' });

    vi.spyOn(retroCurator, 'runRetroDedupe').mockResolvedValue([
      { a: r1.id, b: r2.id, equivalent: true },
    ]);
    vi.spyOn(retroCurator, 'getCandidatePairs').mockReturnValue([
      { a: r1, b: r2 },
    ]);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'curate-retros', '--dry-run']);

    // Re-open (dry-run also calls closeCortexDb in finally)
    const freshDb = getCortexDb(cortex);

    // No merge should have happened
    const rows = freshDb.prepare('SELECT id, occurrences, tombstoned_at FROM retros').all() as {
      id: string;
      occurrences: number;
      tombstoned_at: string | null;
    }[];
    for (const row of rows) {
      expect(row.occurrences).toBe(1);
      expect(row.tombstoned_at).toBeNull();
    }
    // No curator run recorded in dry-run
    const runs = freshDb.prepare('SELECT COUNT(*) as count FROM retro_curator_runs').get() as { count: number };
    expect(runs.count).toBe(0);
  });

  it('getPendingRetros excludes tombstoned rows after dedupe-merge (AC #3)', async () => {
    const cortex = 'pending-after-merge-test';
    getCortexDb(cortex);

    const canonical = insertRetro(cortex, { content: 'canonical retro observation' });
    const dupe = insertRetro(cortex, { content: 'duplicate retro observation' });

    vi.spyOn(retroCurator, 'runRetroDedupe').mockResolvedValue([
      { a: canonical.id, b: dupe.id, equivalent: true },
    ]);
    vi.spyOn(retroCurator, 'getCandidatePairs').mockReturnValue([
      { a: canonical, b: dupe },
    ]);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'curate-retros']);

    const pending = getPendingRetros(cortex);
    const pendingIds = pending.map(r => r.id);
    expect(pendingIds).toContain(canonical.id);
    expect(pendingIds).not.toContain(dupe.id);
  });
});
