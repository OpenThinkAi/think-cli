/**
 * AGT-1303 — the engram write tier is gone, not deprecated.
 *
 * Two kinds of assertion live here, because the two halves of the AC fail in
 * different places:
 *
 *  1. AC2 — removed *commands*. `think curate` / `monitor` / `curator` /
 *     `migrate-data` / `log` and `think cortex auto-curate|auto-sync` must be
 *     unknown to the CLI. Commander only reports an unknown command from a
 *     fully-assembled program, and `src/index.ts` calls `program.parse()` at
 *     import time, so this half runs the built CLI in a subprocess. Skipped
 *     when `dist/` is absent (same gate as tests/mcp/server.test.ts).
 *
 *  2. AC1/AC3 — removed *flags*. `recall --engrams` and
 *     `subscribe poll --legacy-engrams` stay registered-but-hidden so the user
 *     gets our one-line removal note rather than commander's generic "unknown
 *     option" (the pattern AGT-1297 established for `think sync`). Those run
 *     in-process against the command objects. The subscribe half lives in
 *     tests/commands/subscribe.test.ts, next to its proxy fixture.
 *
 * Every subprocess run gets a throwaway THINK_HOME so nothing touches a real
 * cortex — the suite's HOME is already isolated (AGT-1322), this keeps each
 * case independent on top of that.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { recallCommand } from '../../src/commands/recall.js';

const PKG_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const DIST_INDEX = join(PKG_ROOT, 'dist', 'index.js');

/** Run the built CLI against a throwaway THINK_HOME and return its result. */
function runCli(args: string[]): { status: number | null; stderr: string; stdout: string } {
  const thinkHome = mkdtempSync(join(tmpdir(), 'think-agt1303-'));
  try {
    const r = spawnSync(process.execPath, [DIST_INDEX, ...args], {
      env: { ...process.env, THINK_HOME: thinkHome, NO_COLOR: '1' },
      encoding: 'utf-8',
      timeout: 30_000,
    });
    return { status: r.status, stderr: r.stderr ?? '', stdout: r.stdout ?? '' };
  } finally {
    rmSync(thinkHome, { recursive: true, force: true });
  }
}

describe.skipIf(!existsSync(DIST_INDEX))('removed commands report an unknown command (AGT-1303 AC2)', () => {
  // `log` is here for the same reason as the rest even though it wrote local
  // entries rather than engrams: it is the retired pre-cortex write command.
  for (const cmd of ['curate', 'monitor', 'curator', 'migrate-data', 'log']) {
    it(`think ${cmd} is not a command`, () => {
      const { status, stderr } = runCli([cmd, 'whatever']);
      expect(status).not.toBe(0);
      expect(stderr).toMatch(/unknown command/i);
    });
  }

  for (const sub of ['auto-curate', 'auto-sync']) {
    it(`think cortex ${sub} is not a subcommand`, () => {
      const { status, stderr } = runCli(['cortex', sub, 'status']);
      expect(status).not.toBe(0);
      expect(stderr).toMatch(/unknown command/i);
    });
  }

  it('think --help lists none of the removed commands', () => {
    const { stdout } = runCli(['--help']);
    // Anchored to the command column so `curate-retros` (which stays) and the
    // word "curate" inside a description cannot satisfy the assertion.
    for (const cmd of ['curate', 'monitor', 'curator', 'migrate-data', 'log']) {
      expect(stdout).not.toMatch(new RegExp(`^\\s+${cmd}(\\s|$)`, 'm'));
    }
  });

  it('retro curation and the engram migration survive (AC4 / AC5)', () => {
    // The two commands most easily deleted by accident alongside the tier:
    // `curate-retros` never touched engrams, and `migrate-engrams` is the
    // AGT-1302 rescue that has to outlive the tier it drains.
    expect(runCli(['curate-retros', '--help']).status).toBe(0);
    expect(runCli(['migrate-engrams', '--help']).status).toBe(0);
  });
});

describe('think recall --engrams is removed (AGT-1303 AC3)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let prevExitCode: typeof process.exitCode;

  beforeEach(() => {
    prevExitCode = process.exitCode;
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    process.exitCode = prevExitCode;
    vi.restoreAllMocks();
  });

  function makeProgram(): Command {
    const prog = new Command();
    prog.addCommand(recallCommand);
    return prog;
  }

  it('exits non-zero with a one-line removal note and never opens a cortex', async () => {
    await makeProgram().parseAsync(['node', 'think', 'recall', 'anything', '--engrams']);

    expect(process.exitCode).toBe(1);
    const stderr = stderrSpy.mock.calls.flat().join('');
    expect(stderr).toContain('--engrams');
    expect(stderr).toContain('has been removed');
    // One line, not a paragraph — matches the AGT-1297 flag-removal notes.
    expect(stderr.trimEnd().split('\n')).toHaveLength(1);
  });

  it('is rejected before the no-active-cortex check, so the note is what the user sees', async () => {
    // The rejection is unconditional and first: a config with no active cortex
    // must still produce the flag note rather than "No active cortex".
    await makeProgram().parseAsync(['node', 'think', 'recall', 'anything', '--engrams']);
    expect(stderrSpy.mock.calls.flat().join('')).not.toContain('No active cortex');
  });

  it('think recall --help no longer lists --engrams', () => {
    const helpText = makeProgram().commands.find((c) => c.name() === 'recall')!.helpInformation();
    expect(helpText).not.toContain('--engrams');
  });
});
