import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { retroCommand } from '../../src/commands/retro.js';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';

/** Wrap retroCommand in a program so the global -C, --cortex option is available */
function makeProgram(): Command {
  const prog = new Command();
  prog.option('-C, --cortex <name>', 'Use a specific cortex for this command');
  prog.addCommand(retroCommand);
  return prog;
}

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
    // Reset exitCode so it doesn't bleed across tests
    process.exitCode = 0;
  });

  it('exits non-zero when --cortex is missing', async () => {
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'retro', 'the observation']);
    expect(process.exitCode).toBe(1);
  });

  it('accepts --cortex via the global -C flag', async () => {
    const cortex = 'global-flag-test';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'retro', 'test via global flag']);

    const db = getCortexDb(cortex);
    const row = db.prepare('SELECT COUNT(*) as count FROM retros').get() as { count: number };
    expect(row.count).toBe(1);
  });

  it('auto-creates the named cortex on first retro emission', async () => {
    const cortex = 'auto-create-test';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'retro', 'first retro for this cortex', '--cortex', cortex]);

    const db = getCortexDb(cortex);
    const row = db.prepare('SELECT COUNT(*) as count FROM retros').get() as { count: number };
    expect(row.count).toBe(1);
  });

  it('writes the retro content into the retros table', async () => {
    const cortex = 'write-test';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'retro', 'strategy engine contracts should be documented', '--cortex', cortex]);

    const db = getCortexDb(cortex);
    const row = db.prepare('SELECT * FROM retros LIMIT 1').get() as { content: string; kind: string | null };
    expect(row.content).toBe('strategy engine contracts should be documented');
    expect(row.kind).toBeNull();
  });

  it('exits non-zero for an invalid --kind value', async () => {
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'retro', 'some observation', '--cortex', 'test', '--kind', 'not-a-valid-kind']);
    expect(process.exitCode).toBe(1);
  });

  it.each(['convention', 'invariant', 'prior_decision', 'gotcha'] as const)(
    'accepts valid --kind %s and stores it in the row',
    async (kind) => {
      const cortex = `kind-test-${kind}`;
      const prog = makeProgram();
      await prog.parseAsync(['node', 'think', 'retro', `observation with kind ${kind}`, '--cortex', cortex, '--kind', kind]);

      const db = getCortexDb(cortex);
      const row = db.prepare('SELECT kind FROM retros LIMIT 1').get() as { kind: string };
      expect(row.kind).toBe(kind);
    },
  );

  it('does not appear in engrams table (cross-table isolation)', async () => {
    const cortex = 'isolation-test';
    const uniqueToken = 'isolationtokeneng9xyz';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'retro', uniqueToken, '--cortex', cortex]);

    const db = getCortexDb(cortex);
    const rows = db.prepare(
      `SELECT * FROM engrams WHERE content LIKE ? LIMIT 10`
    ).all(`%${uniqueToken}%`);
    expect(rows.length).toBe(0);
  });

  it('does not appear in memories table (cross-table isolation)', async () => {
    const cortex = 'isolation-test-2';
    const uniqueToken = 'isolationtokenmem9xyz';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'retro', uniqueToken, '--cortex', cortex]);

    const db = getCortexDb(cortex);
    const rows = db.prepare(
      `SELECT * FROM memories WHERE content LIKE ? LIMIT 10`
    ).all(`%${uniqueToken}%`);
    expect(rows.length).toBe(0);
  });
});
