import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { briefCommand } from '../../src/commands/brief.js';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
import { insertRetro, setRetroPromoted } from '../../src/db/retro-queries.js';
import * as autoPropagate from '../../src/lib/auto-propagate.js';

function makeProgram(): Command {
  const prog = new Command();
  prog.option('-C, --cortex <name>', 'Use a specific cortex for this command');
  prog.addCommand(briefCommand);
  return prog;
}

/** Write a minimal config.json so getConfig() returns an active cortex. */
function writeConfig(thinkHome: string, activeCortex: string): void {
  const configDir = join(thinkHome, 'config');
  mkdirSync(configDir, { recursive: true });
  const config = {
    peerId: 'test-peer',
    syncPort: 19876,
    cortex: { active: activeCortex, author: 'tester' },
  };
  writeFileSync(join(configDir, 'config.json'), JSON.stringify(config));
}

describe('think brief command', () => {
  let originalHome: string | undefined;
  let tmpHome: string;
  const targetCortex = 'brief-target-cortex';
  const personalCortex = 'brief-personal-cortex';

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-brief-test-'));
    process.env.THINK_HOME = tmpHome;
    closeAllCortexDbs();
    // Pre-create both cortexes
    getCortexDb(personalCortex);
    getCortexDb(targetCortex);
    writeConfig(tmpHome, personalCortex);
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

  it('exits non-zero when --cortex is not provided (AC #8)', async () => {
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'brief']);
    expect(process.exitCode).toBe(1);
  });

  it('exits non-zero when target cortex does not exist (AC #6)', async () => {
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'brief', '--cortex', 'nonexistent-cortex-xyz']);
    expect(process.exitCode).toBe(1);
    const errOutput = (console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ');
    expect(errOutput).toMatch(/no cortex named|does not exist/i);
  });

  it('renders two labelled sections (AC #4)', async () => {
    const r = insertRetro(targetCortex, { content: 'brief two-section test retro' });
    setRetroPromoted(targetCortex, [r.id], 1);
    closeAllCortexDbs();

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'brief', '--cortex', targetCortex]);

    expect(process.exitCode).toBeFalsy();
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toMatch(/personal context/i);
    expect(output).toMatch(/retros for/i);
  });

  it('retros section shows promoted retros (AC #4)', async () => {
    const r = insertRetro(targetCortex, { content: 'brief promoted retro content' });
    setRetroPromoted(targetCortex, [r.id], 1);
    closeAllCortexDbs();

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'brief', '--cortex', targetCortex]);

    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toContain('brief promoted retro content');
  });

  it('no-query path still renders both sections (AC #5)', async () => {
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'brief', '--cortex', targetCortex]);

    expect(process.exitCode).toBeFalsy();
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toMatch(/personal context/i);
    expect(output).toMatch(/retros for/i);
  });

  it('shows "no retros found" when cortex has no promoted retros (AC #5)', async () => {
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'brief', '--cortex', targetCortex]);

    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toMatch(/no retros found/i);
  });

  it('bumps recall stats on retros surfaced via brief (AC #3 via brief)', async () => {
    const r = insertRetro(targetCortex, { content: 'brief recall bump retro' });
    setRetroPromoted(targetCortex, [r.id], 1);
    closeAllCortexDbs();

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'brief', '--cortex', targetCortex]);

    const db = getCortexDb(targetCortex);
    const row = db.prepare('SELECT recalled_count, last_recalled_at FROM retros WHERE id = ?').get(r.id) as {
      recalled_count: number;
      last_recalled_at: string | null;
    };
    expect(row.recalled_count).toBe(1);
    expect(row.last_recalled_at).not.toBeNull();
  });

  it('accepts --cortex via the global -C flag', async () => {
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', targetCortex, 'brief']);

    expect(process.exitCode).toBeFalsy();
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toMatch(/retros for/i);
  });

  it('exits 0 on success regardless of result count (AC #8)', async () => {
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'brief', '--cortex', targetCortex]);
    expect(process.exitCode).toBeFalsy();
  });

  it('calls pullForRead before rendering retros (AC #1)', async () => {
    const pullSpy = vi.spyOn(autoPropagate, 'pullForRead').mockResolvedValue(undefined);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'brief', '--cortex', targetCortex]);

    expect(pullSpy).toHaveBeenCalledWith(targetCortex, expect.objectContaining({ skip: false }));
    expect(process.exitCode).toBeFalsy();
  });

  it('--no-sync skips pullForRead (AC #4)', async () => {
    const pullSpy = vi.spyOn(autoPropagate, 'pullForRead').mockResolvedValue(undefined);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'brief', '--cortex', targetCortex, '--no-sync']);

    expect(pullSpy).toHaveBeenCalledWith(targetCortex, expect.objectContaining({ skip: true }));
  });

  it('exits 0 when pullForRead rejects (pull failure does not break brief) (AC #1)', async () => {
    vi.spyOn(autoPropagate, 'pullForRead').mockRejectedValue(new Error('simulated pull failure'));

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'brief', '--cortex', targetCortex]);

    // brief still renders and exits clean despite the pull throwing
    expect(process.exitCode).toBeFalsy();
  });
});
