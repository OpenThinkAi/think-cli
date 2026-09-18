/**
 * AGT-1303 — the engram write tier is gone, not deprecated.
 *
 * Two kinds of assertion live here, because the two halves of the AC fail in
 * different places:
 *
 *  1. AC2 — removed *commands*. `think curate` / `monitor` / `curator` /
 *     `migrate-data` / `log` and `think cortex auto-curate|auto-sync` are
 *     re-registered hidden (AGT-1325) and print our own one-line removal
 *     pointer rather than falling through to commander's generic "unknown
 *     command" — see commands/removed-commands.ts. Their pointer behavior is
 *     asserted in-process (below) against the exported command objects
 *     directly — the same pattern the `recall --engrams` suite below already
 *     uses — rather than via a subprocess: `buildProgram()`'s `preAction`
 *     hook (`reportPendingHeal`) reads real `THINK_HOME` state, and the built
 *     `dist/index.js` also emits a stray `ExperimentalWarning: SQLite...`
 *     line on stderr on every invocation, either of which would corrupt the
 *     ONE-stderr-line assertion these tests need. A subprocess against the
 *     built CLI is still used for what genuinely requires a fully-assembled
 *     `program` object: proving a real unknown command still gets
 *     commander's own error, and that `--help` output omits every hidden
 *     name.
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
import {
  curateCommand,
  monitorCommand,
  curatorCommand,
  migrateDataCommand,
  logCommand,
  cortexAutoCurateCommand,
  cortexAutoSyncCommand,
} from '../../src/commands/removed-commands.js';

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

describe('removed commands print a one-line removal pointer, in-process (AGT-1325)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let prevExitCode: typeof process.exitCode;

  beforeEach(() => {
    prevExitCode = process.exitCode;
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    process.exitCode = prevExitCode;
    vi.restoreAllMocks();
  });

  async function run(cmd: Command, args: string[]): Promise<{ stderr: string; stdout: string }> {
    const prog = new Command();
    prog.exitOverride(); // never call the real process.exit from this bare program
    prog.addCommand(cmd);
    await prog.parseAsync(['node', 'think', ...args]);
    return {
      stderr: stderrSpy.mock.calls.flat().join(''),
      stdout: stdoutSpy.mock.calls.flat().join(''),
    };
  }

  // One case per removed top-level name, each pinned to the substring an
  // upgrading user needs to see: that the command is gone, and what to run
  // instead. `log` is here for the same reason as the rest even though it
  // wrote local entries rather than engrams: it is the retired pre-cortex
  // write command.
  const cases: Array<{ label: string; cmd: Command; args: string[]; needles: string[] }> = [
    // `curate` must explicitly name `curate-retros` as a different, surviving
    // command (AC1) — the confusable case the ticket calls out by name. Args
    // include a removed-flag muscle-memory invocation so the stub proves it
    // swallows unknown options/args rather than tripping commander's own
    // "unknown option" error first.
    { label: 'think curate', cmd: curateCommand, args: ['curate', '--episode', 'foo'], needles: ['removed', 'curate-retros'] },
    { label: 'think monitor', cmd: monitorCommand, args: ['monitor'], needles: ['removed', 'think recall', 'think memory'] },
    { label: 'think curator', cmd: curatorCommand, args: ['curator', 'show'], needles: ['removed', 'nothing to run'] },
    { label: 'think migrate-data', cmd: migrateDataCommand, args: ['migrate-data'], needles: ['removed', 'migrate-engrams'] },
    { label: 'think log', cmd: logCommand, args: ['log', 'a message'], needles: ['removed', 'think sync'] },
    { label: 'think cortex auto-curate', cmd: cortexAutoCurateCommand, args: ['auto-curate', 'status'], needles: ['removed', 'nothing to run', 'think daemon status'] },
    { label: 'think cortex auto-sync', cmd: cortexAutoSyncCommand, args: ['auto-sync'], needles: ['removed', 'nothing to run', 'think daemon status'] },
  ];

  for (const { label, cmd, args, needles } of cases) {
    it(`${label} exits 1 with the pointer, not "unknown command"/"unknown option", and never writes stdout`, async () => {
      const { stderr, stdout } = await run(cmd, args);

      expect(process.exitCode).toBe(1);
      expect(stdout).toBe('');
      expect(stderr).not.toMatch(/unknown command/i);
      expect(stderr).not.toMatch(/unknown option/i);
      for (const needle of needles) expect(stderr).toContain(needle);
      // ONE stderr line (AC1), matching the removed-flag precedent (AGT-1297).
      expect(stderr.trimEnd().split('\n')).toHaveLength(1);
    });
  }
});

describe.skipIf(!existsSync(DIST_INDEX))('removed commands vs. a real unknown command, and --help (AGT-1325)', () => {
  it('a genuinely unknown command still gets commander\'s own error', () => {
    const { status, stderr } = runCli(['totally-bogus-command-xyz']);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/unknown command/i);
  });

  it('think --help lists none of the removed commands', () => {
    const { stdout } = runCli(['--help']);
    // Anchored to the command column so `curate-retros` (which stays) and the
    // word "curate" inside a description cannot satisfy the assertion.
    for (const cmd of ['curate', 'monitor', 'curator', 'migrate-data', 'log']) {
      expect(stdout).not.toMatch(new RegExp(`^\\s+${cmd}(\\s|$)`, 'm'));
    }
  });

  it('think cortex --help lists neither auto-curate nor auto-sync', () => {
    const { stdout } = runCli(['cortex', '--help']);
    for (const sub of ['auto-curate', 'auto-sync']) {
      expect(stdout).not.toMatch(new RegExp(`^\\s+${sub}(\\s|$)`, 'm'));
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
