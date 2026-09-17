/**
 * Tests for `think memory add` — AGT-1297
 *
 * `-d/--decision` on `memory add` is a hard-removed engram-tier field (the
 * same removal as `think sync`'s --decision, --context and -e/--episode).
 * Passing it exits non-zero with a one-line stderr pointer to `think event`,
 * even under --silent, and the check fires before any cortex/config lookup
 * so nothing is ever written.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { memoryCommand } from '../../src/commands/memory.js';
import { closeAllCortexDbs } from '../../src/db/engrams.js';

/** Build a fresh program with a fresh memory command instance per test —
 * mirrors the pattern in sync.test.ts / retro.test.ts. */
function makeProgram(): Command {
  const prog = new Command();
  prog.option('-C, --cortex <name>', 'Use a specific cortex for this command');
  prog.addCommand(memoryCommand);
  return prog;
}

describe('think memory add — -d/--decision hard-removed (AGT-1297)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-memory-add-test-'));
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
    process.exitCode = 0;
  });

  it('rejects --decision: non-zero exit, stderr pointer, nothing written (AC #1/#2/#4)', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const prog = makeProgram();
    await prog.parseAsync([
      'node', 'think', '-C', 'decision-removed-memory-test',
      'memory', 'add', 'a memory', '--decision', 'chose option A',
    ]);

    expect(process.exitCode).toBe(1);
    const stderr = stderrSpy.mock.calls.flat().join('');
    expect(stderr).toContain('--decision');
    expect(stderr).toContain('think event');
    // No output emitted, and no "No active cortex" error either — the
    // rejection fires before any cortex/config lookup.
    expect((console.log as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    expect((console.error as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('rejects --decision under --silent too', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const prog = makeProgram();
    await prog.parseAsync([
      'node', 'think', '-C', 'decision-removed-memory-silent-test',
      'memory', 'add', 'a silent memory', '--decision', 'chose option A', '--silent',
    ]);

    expect(process.exitCode).toBe(1);
    expect(stderrSpy.mock.calls.flat().join('')).toContain('--decision');
    expect((console.log as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('think memory add --help no longer lists --decision (AC #3)', () => {
    const prog = makeProgram();
    const memory = prog.commands.find(c => c.name() === 'memory')!;
    const add = memory.commands.find(c => c.name() === 'add')!;

    expect(add.helpInformation()).not.toContain('--decision');
  });
});
