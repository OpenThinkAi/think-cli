import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { retroCommand } from '../../src/commands/retro.js';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
import { insertRetro, setRetroPromoted } from '../../src/db/retro-queries.js';
import * as autoPropagate from '../../src/lib/auto-propagate.js';

function makeProgram(): Command {
  const prog = new Command();
  prog.option('-C, --cortex <name>', 'Use a specific cortex for this command');
  prog.addCommand(retroCommand);
  return prog;
}

describe('think retro recall subcommand', () => {
  let originalHome: string | undefined;
  let tmpHome: string;
  const cortex = 'recall-test-cortex';

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-retro-recall-test-'));
    process.env.THINK_HOME = tmpHome;
    closeAllCortexDbs();
    getCortexDb(cortex); // pre-create the cortex
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    closeAllCortexDbs();
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it('exits non-zero when --cortex is not provided', async () => {
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'retro', 'recall']);
    expect(process.exitCode).toBe(1);
  });

  it('exits non-zero when the named cortex does not exist', async () => {
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'retro', 'recall', '--cortex', 'nonexistent-cortex-xyz']);
    expect(process.exitCode).toBe(1);
  });

  it('prints "no retros found" message when cortex has no promoted retros', async () => {
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'retro', 'recall', '--cortex', cortex]);

    expect(process.exitCode).toBeFalsy();
    const calls = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ');
    expect(calls).toMatch(/no retros found/);
  });

  it('returns only promoted=1 retros by default (AC #2)', async () => {
    const r1 = insertRetro(cortex, { content: 'promoted observation' });
    const r2 = insertRetro(cortex, { content: 'relegated observation' });
    setRetroPromoted(cortex, [r1.id], 1);
    // r2 stays promoted=0
    closeAllCortexDbs();

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'retro', 'recall', '--cortex', cortex]);

    expect(process.exitCode).toBeFalsy();
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toContain('promoted observation');
    expect(output).not.toContain('relegated observation');
  });

  it('--all returns relegated retros too (AC #2)', async () => {
    const r1 = insertRetro(cortex, { content: 'promoted obs for all test' });
    const r2 = insertRetro(cortex, { content: 'relegated obs for all test' });
    setRetroPromoted(cortex, [r1.id], 1);
    closeAllCortexDbs();

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'retro', 'recall', '--cortex', cortex, '--all']);

    expect(process.exitCode).toBeFalsy();
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toContain('promoted obs for all test');
    expect(output).toContain('relegated obs for all test');
  });

  it('--include-relegated is an alias for --all (AC #2)', async () => {
    const r = insertRetro(cortex, { content: 'relegated obs include-relegated alias' });
    // r stays promoted=0
    closeAllCortexDbs();

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'retro', 'recall', '--cortex', cortex, '--include-relegated']);

    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toContain('relegated obs include-relegated alias');
  });

  it('tombstoned rows are never returned (AC #2)', async () => {
    const canonical = insertRetro(cortex, { content: 'canonical retro for tombstone test' });
    const dupe = insertRetro(cortex, { content: 'tombstoned duplicate retro' });
    // Manually tombstone the dupe
    const db = getCortexDb(cortex);
    db.prepare('UPDATE retros SET tombstoned_at = ?, tombstone_reason = ? WHERE id = ?')
      .run(new Date().toISOString(), `merged_into:${canonical.id}`, dupe.id);
    setRetroPromoted(cortex, [canonical.id], 1);
    closeAllCortexDbs();

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'retro', 'recall', '--cortex', cortex, '--all']);

    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toContain('canonical retro for tombstone test');
    expect(output).not.toContain('tombstoned duplicate retro');
  });

  it('bumps last_recalled_at and recalled_count on surfaced rows (AC #3)', async () => {
    const r = insertRetro(cortex, { content: 'recall bump test retro' });
    setRetroPromoted(cortex, [r.id], 1);
    closeAllCortexDbs();

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'retro', 'recall', '--cortex', cortex]);

    const db = getCortexDb(cortex);
    const row = db.prepare('SELECT recalled_count, last_recalled_at FROM retros WHERE id = ?').get(r.id) as {
      recalled_count: number;
      last_recalled_at: string | null;
    };
    expect(row.recalled_count).toBe(1);
    expect(row.last_recalled_at).not.toBeNull();
  });

  it('exits 0 on success (AC #8)', async () => {
    const r = insertRetro(cortex, { content: 'exit code test retro' });
    setRetroPromoted(cortex, [r.id], 1);
    closeAllCortexDbs();

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'retro', 'recall', '--cortex', cortex]);
    expect(process.exitCode).toBeFalsy();
  });

  it('calls pullForRead before rendering retros (AC #2)', async () => {
    const pullSpy = vi.spyOn(autoPropagate, 'pullForRead').mockResolvedValue(undefined);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'retro', 'recall', '--cortex', cortex]);

    expect(pullSpy).toHaveBeenCalledWith(cortex, expect.objectContaining({ skip: false }));
    expect(process.exitCode).toBeFalsy();
  });

  it('--no-sync skips pullForRead (AC #4)', async () => {
    const pullSpy = vi.spyOn(autoPropagate, 'pullForRead').mockResolvedValue(undefined);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'retro', 'recall', '--cortex', cortex, '--no-sync']);

    expect(pullSpy).toHaveBeenCalledWith(cortex, expect.objectContaining({ skip: true }));
  });

  it('exit code 0 unaffected by pull failure (AC #1 offline-degrade)', async () => {
    vi.spyOn(autoPropagate, 'pullForRead').mockRejectedValue(new Error('simulated pull failure'));
    const r = insertRetro(cortex, { content: 'pull-fail test retro' });
    setRetroPromoted(cortex, [r.id], 1);
    closeAllCortexDbs();

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'retro', 'recall', '--cortex', cortex]);

    expect(process.exitCode).toBeFalsy();
  });

  it('accepts --cortex via the global -C flag', async () => {
    const r = insertRetro(cortex, { content: 'global flag cortex test' });
    setRetroPromoted(cortex, [r.id], 1);
    closeAllCortexDbs();

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'retro', 'recall']);

    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toContain('global flag cortex test');
  });
});
