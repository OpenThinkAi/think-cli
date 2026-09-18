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

/**
 * Version precedence (AGT-1324).
 *
 * `latest` here is the `latest` DIST-TAG, which is what `npm view
 * @openthink/think version` returns — publish.yml routes a prerelease to its
 * own tag, so a canary on `3.0.0-rc.1` sees `latest` = `2.6.1` and must not
 * be downgraded to it. Same seams as the suite above: `execFileSync` is
 * mocked, so no npm process, no registry call and no global install ever
 * happens; the fake install writes into a throwaway temp "npm root".
 */
describe('think update — version precedence (AGT-1324)', () => {
  let npmRoot: string;
  let pkgDir: string;
  let logs: string[];
  let errors: string[];
  /** Every `npm install -g` spec the command asked for, in order. */
  let installedSpecs: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    npmRoot = mkdtempSync(path.join(tmpdir(), 'think-update-precedence-'));
    pkgDir = path.join(npmRoot, '@openthink', 'think');
    mkdirSync(pkgDir, { recursive: true });
    logs = [];
    errors = [];
    installedSpecs = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    vi.mocked(daemonDrift.inspectDaemon).mockResolvedValue({ reachable: false, version: null });
    vi.mocked(daemonDrift.needsDaemonRestart).mockReturnValue(false);
    vi.mocked(daemonDrift.restartDaemonViaBin).mockReturnValue({ ok: true });
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

  function installedVersionOnDisk(): string | null {
    try {
      return JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf-8')).version ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Fake npm. `latest` is what `npm view` answers (null = the lookup fails,
   * i.e. offline); an install of `@latest` lands `resolvesLatestTo ?? latest`
   * on disk, which is how a downgrade would show up here.
   */
  function mockNpm(opts: { latest: string | null; resolvesLatestTo?: string }): void {
    mockedExecFileSync.mockImplementation((_file: string, args?: readonly string[]) => {
      const a = args ?? [];
      if (a[0] === 'root' && a[1] === '-g') return npmRoot;
      if (a[0] === 'view') {
        if (opts.latest === null) throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org');
        return opts.latest;
      }
      if (a[0] === 'install') {
        const spec = a[a.length - 1];
        installedSpecs.push(spec);
        const target = opts.resolvesLatestTo ?? opts.latest;
        if (target) writePkgVersion(target);
        return '';
      }
      throw new Error(`unexpected execFileSync call: npm ${a.join(' ')}`);
    });
  }

  async function runUpdate(): Promise<void> {
    vi.resetModules();
    const { updateCommand } = await import('../../src/commands/update.js');
    await updateCommand.parseAsync([], { from: 'user' });
  }

  it('AC1: a prerelease install ahead of `latest` is kept, not downgraded', async () => {
    writePkgVersion('3.0.0-rc.1');
    mockNpm({ latest: '2.6.1' });

    await expect(runUpdate()).resolves.not.toThrow(); // exits 0

    expect(installedSpecs).toEqual([]);
    expect(installedVersionOnDisk()).toBe('3.0.0-rc.1');
    // One line naming both versions and the tag the install tracks.
    const out = logs.join('\n');
    expect(out).toContain('Installed @openthink/think@3.0.0-rc.1 is ahead of latest (2.6.1) — keeping it.');
    expect(out).toContain('npm install -g @openthink/think@rc');
  });

  it('AC1: the kept-install path still syncs the daemon and refreshes managed blocks', async () => {
    writePkgVersion('3.0.0-rc.1');
    mockNpm({ latest: '2.6.1' });
    vi.mocked(daemonDrift.needsDaemonRestart).mockReturnValue(true);

    await runUpdate();

    // The daemon is brought onto the version that is actually installed —
    // never onto `latest`, which is behind it.
    expect(daemonDrift.needsDaemonRestart).toHaveBeenCalledWith(
      { reachable: false, version: null },
      '3.0.0-rc.1',
    );
    expect(daemonDrift.restartDaemonViaBin).toHaveBeenCalledWith(pkgDir);
    expect(blockRefresh.refreshBlocksViaBin).toHaveBeenCalledTimes(1);
    expect(blockRefresh.refreshBlocksViaBin).toHaveBeenCalledWith(pkgDir);
  });

  it('AC2: a prerelease install behind its release upgrades (3.0.0-rc.1 → 3.0.0)', async () => {
    writePkgVersion('3.0.0-rc.1');
    mockNpm({ latest: '3.0.0' });

    await runUpdate();

    expect(installedSpecs).toEqual(['@openthink/think@latest']);
    expect(installedVersionOnDisk()).toBe('3.0.0');
    expect(logs.join('\n')).toContain('Updated to @openthink/think@3.0.0');
  });

  it('AC3: an install equal to `latest` is unchanged (no install, already-up-to-date line)', async () => {
    writePkgVersion('2.6.1');
    mockNpm({ latest: '2.6.1' });

    await runUpdate();

    expect(installedSpecs).toEqual([]);
    expect(logs.join('\n')).toContain('Already up to date (@openthink/think@2.6.1).');
  });

  it('AC3: an install behind `latest` still upgrades (2.6.0 → 2.6.1)', async () => {
    writePkgVersion('2.6.0');
    mockNpm({ latest: '2.6.1' });

    await runUpdate();

    expect(installedSpecs).toEqual(['@openthink/think@latest']);
    expect(installedVersionOnDisk()).toBe('2.6.1');
  });

  it('AC5: an unparsable INSTALLED version falls back to installing `@latest`', async () => {
    // An unknown install is the one case where `@latest` is the best answer
    // available — there is nothing to protect and npm can sort it out.
    writePkgVersion('not-a-version');
    mockNpm({ latest: '2.6.1' });

    await runUpdate();

    expect(installedSpecs).toEqual(['@openthink/think@latest']);
    expect(installedVersionOnDisk()).toBe('2.6.1');
  });

  it('AC5: an empty INSTALLED version string also falls back to installing `@latest`', async () => {
    writePkgVersion('');
    mockNpm({ latest: '2.6.1' });

    await runUpdate();

    expect(installedSpecs).toEqual(['@openthink/think@latest']);
  });

  it('AC5: an unparsable version from the registry installs nothing and says so', async () => {
    writePkgVersion('2.6.1');
    mockNpm({ latest: 'npm ERR! code E404' });

    await expect(runUpdate()).resolves.not.toThrow();

    expect(installedSpecs).toEqual([]);
    expect(installedVersionOnDisk()).toBe('2.6.1');
    expect(errors.join('\n')).toContain('unrecognizable latest version');
    // Heal wiring still runs on this path.
    expect(blockRefresh.refreshBlocksViaBin).toHaveBeenCalledTimes(1);
  });

  it('AC5: a registry string with control characters is escaped, not echoed raw', async () => {
    writePkgVersion('2.6.1');
    mockNpm({ latest: '[2K\rAlready up to date' });

    await runUpdate();

    const out = [...logs, ...errors].join('\n');
    expect(out).not.toContain('[2K');
    expect(out).toContain('\\u001b[2K');
  });

  it('AC5: an unreachable registry keeps a prerelease install rather than risking a cached downgrade', async () => {
    // `npm install -g …@latest` would resolve `latest` from npm's local
    // cache here, which on a canary machine is exactly the downgrade.
    writePkgVersion('3.0.0-rc.1');
    mockNpm({ latest: null, resolvesLatestTo: '2.6.1' });

    await runUpdate();

    expect(installedSpecs).toEqual([]);
    expect(installedVersionOnDisk()).toBe('3.0.0-rc.1');
    expect(errors.join('\n')).toContain('Could not check the registry');
    expect(blockRefresh.refreshBlocksViaBin).toHaveBeenCalledTimes(1);
  });

  it('an unreachable registry with a release install still attempts `@latest` (unchanged)', async () => {
    writePkgVersion('2.6.0');
    mockNpm({ latest: null, resolvesLatestTo: '2.6.1' });

    await runUpdate();

    expect(installedSpecs).toEqual(['@openthink/think@latest']);
  });

  it('never suggests a numeric dist-tag for a numeric prerelease identifier', async () => {
    writePkgVersion('3.0.0-1.2');
    mockNpm({ latest: '2.6.1' });

    await runUpdate();

    const out = logs.join('\n');
    expect(out).toContain('npm install -g @openthink/think@3.0.0-1.2');
    expect(out).not.toContain('@openthink/think@1 ');
  });
});
