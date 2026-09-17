/**
 * Tests for commands/update.ts's block-refresh integration (AGT-1306).
 *
 * `npm install -g`, the daemon restart, and the block refresh are all exec
 * seams here — nothing in this file spawns a real process or touches the
 * real npm registry/daemon/home. `execFileSync` is mocked outright (the npm
 * calls); `../lib/daemon-drift.js` and `../lib/block-refresh.js` — both
 * loaded via `await import(...)` inside the command action — are mocked via
 * `vi.mock`, mirroring tests/commands/reindex.test.ts's pattern for a
 * command that dynamically imports a lib module.
 *
 * `getGlobalPackageRoot`/`getInstalledVersion` still read real package.json
 * files, just under a throwaway temp "npm root" this suite creates and
 * controls — never the real npm root or a real global install.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../../src/lib/daemon-drift.js', () => ({
  inspectDaemon: vi.fn().mockResolvedValue({ reachable: false, version: null }),
  needsDaemonRestart: vi.fn().mockReturnValue(false),
  restartDaemonViaBin: vi.fn().mockReturnValue({ ok: true }),
}));

vi.mock('../../src/lib/block-refresh.js', () => ({
  refreshBlocksViaBin: vi.fn().mockReturnValue({ ok: true, refreshed: [], failures: [] }),
}));

import { execFileSync } from 'node:child_process';
import * as daemonDrift from '../../src/lib/daemon-drift.js';
import * as blockRefresh from '../../src/lib/block-refresh.js';

const mockedExecFileSync = vi.mocked(execFileSync);

describe('think update — block refresh (AGT-1306)', () => {
  let npmRoot: string;
  let pkgDir: string;
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    // vi.restoreAllMocks() (afterEach, below) only resets vi.spyOn spies —
    // the plain vi.fn()s created inside the vi.mock(...) factories above have
    // no "original" to restore to, so their call history survives across
    // tests unless cleared explicitly here.
    vi.clearAllMocks();

    npmRoot = mkdtempSync(path.join(tmpdir(), 'think-update-npmroot-'));
    pkgDir = path.join(npmRoot, '@openthink', 'think');
    mkdirSync(pkgDir, { recursive: true });
    logs = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    vi.mocked(daemonDrift.inspectDaemon).mockResolvedValue({ reachable: false, version: null });
    vi.mocked(daemonDrift.needsDaemonRestart).mockReturnValue(false);
    vi.mocked(blockRefresh.refreshBlocksViaBin).mockReturnValue({ ok: true, refreshed: [], failures: [] });
  });

  afterEach(() => {
    rmSync(npmRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.resetModules();
  });

  function writePkgVersion(version: string): void {
    writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ version }), 'utf-8');
  }

  /** Fake `npm ...` behind execFileSync — no real npm process ever runs. */
  function mockNpm(opts: { latest: string; installBumpsTo?: string }): void {
    mockedExecFileSync.mockImplementation((_file: string, args?: readonly string[]) => {
      const a = args ?? [];
      if (a[0] === 'root' && a[1] === '-g') return npmRoot;
      if (a[0] === 'view') return opts.latest;
      if (a[0] === 'install') {
        if (opts.installBumpsTo) writePkgVersion(opts.installBumpsTo);
        return '';
      }
      throw new Error(`unexpected execFileSync call: npm ${a.join(' ')}`);
    });
  }

  async function importUpdate() {
    vi.resetModules();
    return import('../../src/commands/update.js');
  }

  it('AC3: refreshes blocks when the package is already current', async () => {
    writePkgVersion('2.6.0');
    mockNpm({ latest: '2.6.0' });

    const { updateCommand } = await importUpdate();
    await updateCommand.parseAsync([], { from: 'user' });

    // No install attempted — already current.
    expect(mockedExecFileSync).not.toHaveBeenCalledWith('npm', expect.arrayContaining(['install']), expect.anything());
    expect(blockRefresh.refreshBlocksViaBin).toHaveBeenCalledTimes(1);
    expect(blockRefresh.refreshBlocksViaBin).toHaveBeenCalledWith(pkgDir);
  });

  it('AC2: refreshes blocks via the re-exec seam after a real version bump, not in-process', async () => {
    writePkgVersion('2.5.0');
    mockNpm({ latest: '2.6.0', installBumpsTo: '2.6.0' });

    const { updateCommand } = await importUpdate();
    await updateCommand.parseAsync([], { from: 'user' });

    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'npm',
      expect.arrayContaining(['install', '-g']),
      expect.anything(),
    );
    // The refresh is delegated to the mocked re-exec seam — never a
    // direct, in-process call to the refresh logic itself.
    expect(blockRefresh.refreshBlocksViaBin).toHaveBeenCalledTimes(1);
    expect(blockRefresh.refreshBlocksViaBin).toHaveBeenCalledWith(pkgDir);
  });

  it('AC5: a refresh failure reported by the seam does not fail the update, and is printed', async () => {
    writePkgVersion('2.6.0');
    mockNpm({ latest: '2.6.0' });
    vi.mocked(blockRefresh.refreshBlocksViaBin).mockReturnValue({
      ok: true,
      refreshed: [],
      failures: [{ path: '/some/CLAUDE.md', kind: 'work-log', reason: 'EACCES: permission denied' }],
    });

    const { updateCommand } = await importUpdate();
    await expect(updateCommand.parseAsync([], { from: 'user' })).resolves.not.toThrow();

    expect(errors.some((l) => l.includes('/some/CLAUDE.md') && l.includes('permission denied'))).toBe(true);
  });

  it('AC4: reports the count of refreshed paths', async () => {
    writePkgVersion('2.6.0');
    mockNpm({ latest: '2.6.0' });
    vi.mocked(blockRefresh.refreshBlocksViaBin).mockReturnValue({
      ok: true,
      refreshed: ['/a/CLAUDE.md', '/b/CLAUDE.md'],
      failures: [],
    });

    const { updateCommand } = await importUpdate();
    await updateCommand.parseAsync([], { from: 'user' });

    expect(logs.some((l) => l.includes('Refreshed 2 managed blocks'))).toBe(true);
  });

  it('does not attempt a refresh when the package root cannot be resolved at all', async () => {
    mockedExecFileSync.mockImplementation((_file: string, args?: readonly string[]) => {
      const a = args ?? [];
      if (a[0] === 'root' && a[1] === '-g') throw new Error('npm not found');
      if (a[0] === 'view') throw new Error('offline');
      if (a[0] === 'install') throw new Error('npm not found');
      throw new Error(`unexpected execFileSync call: npm ${a.join(' ')}`);
    });

    const { updateCommand } = await importUpdate();
    await updateCommand.parseAsync([], { from: 'user' });

    expect(blockRefresh.refreshBlocksViaBin).not.toHaveBeenCalled();
  });

  it('never prints "v2"/"v3" wording around the refresh output', async () => {
    writePkgVersion('2.6.0');
    mockNpm({ latest: '2.6.0' });
    vi.mocked(blockRefresh.refreshBlocksViaBin).mockReturnValue({
      ok: true,
      refreshed: ['/a/CLAUDE.md'],
      failures: [{ path: '/b/CLAUDE.md', kind: 'retro', reason: 'boom' }],
    });

    const { updateCommand } = await importUpdate();
    await updateCommand.parseAsync([], { from: 'user' });

    const allOutput = [...logs, ...errors].join('\n');
    expect(allOutput.toLowerCase()).not.toMatch(/\bv[23]\b/);
  });
});

describe('commands/update.ts source — re-exec hygiene', () => {
  it('spawns the refresh via execFile-style array args, never shell interpolation', () => {
    const src = readFileSync(
      new URL('../../src/commands/update.ts', import.meta.url),
      'utf-8',
    );
    // The seam call itself lives in lib/block-refresh.ts; this just guards
    // that update.ts never re-implements ad hoc string-concatenated spawning
    // of its own instead of going through the shared, array-args seam.
    expect(src).not.toMatch(/exec\(`/); // no template-string shell exec
    expect(src).toContain('refreshBlocksViaBin(pkgRoot)');
  });
});
