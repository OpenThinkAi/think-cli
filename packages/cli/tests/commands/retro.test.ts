import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retroCommand } from '../../src/commands/retro.js';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';

describe('think retro command', () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-retro-cmd-test-'));
    process.env.THINK_HOME = tmpHome;
    closeAllCortexDbs();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    closeAllCortexDbs();
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('exits non-zero when --cortex is missing', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    await expect(
      retroCommand.parseAsync(['the observation'], { from: 'user' })
    ).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('auto-creates the named cortex on first retro emission', async () => {
    const cortex = 'auto-create-test';
    await retroCommand.parseAsync(['first retro for this cortex', '--cortex', cortex], { from: 'user' });

    const db = getCortexDb(cortex);
    const row = db.prepare('SELECT COUNT(*) as count FROM retros').get() as { count: number };
    expect(row.count).toBe(1);
  });

  it('writes the retro content into the retros table', async () => {
    const cortex = 'write-test';
    await retroCommand.parseAsync(
      ['strategy engine contracts should be documented', '--cortex', cortex],
      { from: 'user' },
    );

    const db = getCortexDb(cortex);
    const row = db.prepare('SELECT * FROM retros LIMIT 1').get() as { content: string; kind: string | null };
    expect(row.content).toBe('strategy engine contracts should be documented');
    expect(row.kind).toBeNull();
  });

  it('exits non-zero for an invalid --kind value', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    await expect(
      retroCommand.parseAsync(
        ['some observation', '--cortex', 'test', '--kind', 'not-a-valid-kind'],
        { from: 'user' },
      )
    ).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it.each(['convention', 'invariant', 'prior_decision', 'gotcha'] as const)(
    'accepts valid --kind %s and stores it in the row',
    async (kind) => {
      const cortex = `kind-test-${kind}`;
      await retroCommand.parseAsync(
        [`observation with kind ${kind}`, '--cortex', cortex, '--kind', kind],
        { from: 'user' },
      );

      const db = getCortexDb(cortex);
      const row = db.prepare('SELECT kind FROM retros LIMIT 1').get() as { kind: string };
      expect(row.kind).toBe(kind);
    },
  );

  it('does not appear in engrams table (cross-table isolation)', async () => {
    const cortex = 'isolation-test';
    const uniqueToken = 'isolationtokeneng9xyz';
    await retroCommand.parseAsync([uniqueToken, '--cortex', cortex], { from: 'user' });

    const db = getCortexDb(cortex);
    const rows = db.prepare(
      `SELECT * FROM engrams WHERE content LIKE ? LIMIT 10`
    ).all(`%${uniqueToken}%`);
    expect(rows.length).toBe(0);
  });

  it('does not appear in memories table (cross-table isolation)', async () => {
    const cortex = 'isolation-test-2';
    const uniqueToken = 'isolationtokenmem9xyz';
    await retroCommand.parseAsync([uniqueToken, '--cortex', cortex], { from: 'user' });

    const db = getCortexDb(cortex);
    const rows = db.prepare(
      `SELECT * FROM memories WHERE content LIKE ? LIMIT 10`
    ).all(`%${uniqueToken}%`);
    expect(rows.length).toBe(0);
  });
});
