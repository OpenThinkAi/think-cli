/**
 * Tests for `think doctor` — AGT-1308 AC2/AC3.
 *
 * `lib/doctor/registry.js` is mocked outright, so this suite never runs a real
 * check: no LaunchAgent is scanned, no socket opened, no cortex read. What is
 * under test here is presentation and exit code — the command's whole job.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/lib/doctor/registry.js', () => ({
  doctorChecks: vi.fn(() => []),
  runDoctorChecks: vi.fn(),
  applyDoctorFixes: vi.fn(),
}));

import { doctorCommand } from '../../src/commands/doctor.js';
import {
  runDoctorChecks,
  applyDoctorFixes,
} from '../../src/lib/doctor/registry.js';
import type { CheckResult } from '../../src/lib/doctor/types.js';

const mockedRun = vi.mocked(runDoctorChecks);
const mockedFix = vi.mocked(applyDoctorFixes);

function res(id: string, partial: Partial<CheckResult> = {}): CheckResult {
  return { id, status: 'pass', detail: 'ok', fixable: false, ...partial };
}

describe('think doctor', () => {
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    logs = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    process.exitCode = undefined;
    mockedFix.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  async function run(argv: string[] = []): Promise<void> {
    await doctorCommand.parseAsync(argv, { from: 'user' });
  }

  it('AC2: exits 0 when nothing failed', async () => {
    mockedRun.mockResolvedValue([res('a'), res('b', { status: 'warn', detail: 'two homes' })]);

    await run();

    expect(process.exitCode).toBeUndefined();
    expect(logs.join('\n')).toContain('two homes');
  });

  it('AC2: exits 1 when any check failed', async () => {
    mockedRun.mockResolvedValue([res('a'), res('b', { status: 'fail', detail: 'broken' })]);

    await run();

    expect(process.exitCode).toBe(1);
  });

  it('AC1: prints one line per check, marked pass/warn/fail', async () => {
    mockedRun.mockResolvedValue([
      res('one', { detail: 'fine' }),
      res('two', { status: 'warn', detail: 'meh' }),
      res('three', { status: 'fail', detail: 'bad' }),
    ]);

    await run();

    expect(logs[0]).toBe('✓ one  fine');
    expect(logs[1]).toBe('⚠ two  meh');
    expect(logs[2]).toBe('✗ three  bad');
  });

  it('points at --fix when something is fixable', async () => {
    mockedRun.mockResolvedValue([res('a', { status: 'fail', fixable: true })]);

    await run();

    expect(logs.join('\n')).toContain('think doctor --fix');
  });

  it('AC2: --json emits one object per check and nothing else on stdout', async () => {
    const results = [
      res('one'),
      res('two', { status: 'fail', detail: 'bad', fixable: true }),
    ];
    mockedRun.mockResolvedValue(results);

    await run(['--json']);

    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0])).toEqual(results);
    for (const entry of JSON.parse(logs[0]) as CheckResult[]) {
      expect(Object.keys(entry).sort()).toEqual(['detail', 'fixable', 'id', 'status']);
    }
    expect(process.exitCode).toBe(1);
  });

  it('AC3: --fix applies the repairs, then re-runs the checks', async () => {
    mockedRun
      .mockResolvedValueOnce([res('a', { status: 'fail', detail: 'stale agents', fixable: true })])
      .mockResolvedValueOnce([res('a', { detail: 'clean' })]);
    mockedFix.mockResolvedValue([{ id: 'a', outcome: { ok: true, detail: 'Removed 2 stale LaunchAgents.' } }]);

    await run(['--fix']);

    expect(mockedFix).toHaveBeenCalledTimes(1);
    expect(mockedRun).toHaveBeenCalledTimes(2);
    // The reported state is the state the command leaves behind, and the exit
    // code reflects what is still broken — not what was broken on entry.
    expect(logs.join('\n')).toContain('Removed 2 stale LaunchAgents.');
    expect(logs.join('\n')).toContain('clean');
    expect(process.exitCode).toBeUndefined();
  });

  it('AC3: --fix says so when there was nothing to repair', async () => {
    mockedRun.mockResolvedValue([res('a')]);
    mockedFix.mockResolvedValue([]);

    await run(['--fix']);

    expect(logs.join('\n')).toContain('Nothing to fix.');
  });

  it('AC2: --fix --json keeps stdout pure JSON, repair notes on stderr', async () => {
    mockedRun
      .mockResolvedValueOnce([res('a', { status: 'fail', fixable: true })])
      .mockResolvedValueOnce([res('a')]);
    mockedFix.mockResolvedValue([{ id: 'a', outcome: { ok: true, detail: 'repaired' } }]);

    await run(['--fix', '--json']);

    expect(logs).toHaveLength(1);
    expect(() => JSON.parse(logs[0])).not.toThrow();
    expect(errors.join('\n')).toContain('repaired');
  });

  it('reports a failed repair without claiming success', async () => {
    mockedRun.mockResolvedValue([res('a', { status: 'fail', fixable: true })]);
    mockedFix.mockResolvedValue([{ id: 'a', outcome: { ok: false, detail: 'Could not restart the daemon.' } }]);

    await run(['--fix']);

    expect(logs.join('\n')).toContain('⚠ a  Could not restart the daemon.');
    expect(process.exitCode).toBe(1);
  });
});
