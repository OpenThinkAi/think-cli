/**
 * Regression tests for AGT-438 / GH#63 — global `-C/--cortex` collides with the
 * subcommand `--cortex` on `cortex pull`, `cortex push`, and `cortex sync`.
 *
 * Commander v13 binds long flags to the nearest declaring command up the chain,
 * so when the program declares `-C, --cortex <name>` and a subcommand also
 * declares `--cortex <name>`, the flag-value lands on the program option and
 * the subcommand's `opts.cortex` is `undefined`. The buggy code then hit the
 * `if (!cortex)` "No active cortex" early bail when no active cortex was set.
 *
 * Fix: each subcommand handler reads `this.optsWithGlobals()` and falls back
 * to it. Resolution order: subcommand `--cortex` > global `-C/--cortex` >
 * `config.cortex.active` (preserves the no-flag default).
 *
 * IMPORTANT — harness shape: these tests MUST wrap `cortexCommand` under a
 * parent program that declares `-C/--cortex`, otherwise the global option is
 * not in scope and the bug does not reproduce (a test against bare
 * `cortexCommand.parseAsync` would pass even against the buggy code and fail
 * to guard the regression). The existing `cortex-status.test.ts` parses
 * `cortexCommand` standalone — that pattern is intentionally NOT used here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { cortexCommand } from '../../src/commands/cortex.js';
import * as registryModule from '../../src/sync/registry.js';
import * as engramsModule from '../../src/db/engrams.js';
import { saveConfig, getConfig } from '../../src/lib/config.js';
import type { SyncAdapter, SyncResult } from '../../src/sync/types.js';

/**
 * Build a fresh parent program that declares the global `-C/--cortex` option
 * and mounts the (singleton) `cortexCommand`. Each test gets a new program so
 * commander's per-program option state does not leak across tests.
 */
function makeProgram(): Command {
  const prog = new Command();
  prog.option('-C, --cortex <name>', 'Use a specific cortex for this command');
  prog.addCommand(cortexCommand);
  return prog;
}

/**
 * Minimal SyncAdapter spy. `isAvailable` / `isReachable` always succeed; the
 * three side-effect methods record the cortex name they were called with and
 * resolve to an empty SyncResult so the handlers exit cleanly.
 */
function makeFakeAdapter(): {
  adapter: SyncAdapter;
  pushSpy: ReturnType<typeof vi.fn>;
  pullSpy: ReturnType<typeof vi.fn>;
  syncSpy: ReturnType<typeof vi.fn>;
} {
  const emptyResult: SyncResult = { pushed: 0, pulled: 0, errors: [] };
  const pushSpy = vi.fn(async (_cortex: string): Promise<SyncResult> => emptyResult);
  const pullSpy = vi.fn(async (_cortex: string): Promise<SyncResult> => emptyResult);
  const syncSpy = vi.fn(async (_cortex: string): Promise<SyncResult> => emptyResult);
  const adapter: SyncAdapter = {
    name: 'fake',
    push: pushSpy,
    pull: pullSpy,
    sync: syncSpy,
    listRemoteCortexes: vi.fn(async () => []),
    createCortex: vi.fn(async () => {}),
    isAvailable: () => true,
    isReachable: async () => true,
  };
  return { adapter, pushSpy, pullSpy, syncSpy };
}

let tmpHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.THINK_HOME;
  tmpHome = mkdtempSync(join(tmpdir(), 'think-cortex-flag-test-'));
  process.env.THINK_HOME = tmpHome;
  // Silence handler output so test runner stays clean.
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // Stub closeCortexDb — the handlers call it on success and we have no real
  // DB open in these tests.
  vi.spyOn(engramsModule, 'closeCortexDb').mockImplementation(() => {});
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.THINK_HOME;
  else process.env.THINK_HOME = originalHome;
  rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe('AGT-438 / GH#63 — cortex pull/push/sync --cortex flag (no active cortex)', () => {
  // AC #1 + AC #7: the exact repro path.
  it('cortex pull --cortex <name> resolves <name> on the subcommand (AC #1, AC #7)', async () => {
    const { adapter, pullSpy } = makeFakeAdapter();
    vi.spyOn(registryModule, 'getSyncAdapter').mockReturnValue(adapter);

    // Save a config with NO active cortex (the failing repro shape).
    saveConfig({ ...getConfig(), cortex: { author: 'tester' } });

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'cortex', 'pull', '--cortex', 'cortex/engineering']);

    expect(pullSpy).toHaveBeenCalledWith('cortex/engineering');
    // The "No active cortex" bail must NOT have fired.
    expect(process.exitCode).not.toBe(1);
  });

  // AC #2: parallel for push.
  it('cortex push --cortex <name> resolves <name> on the subcommand (AC #2)', async () => {
    const { adapter, pushSpy } = makeFakeAdapter();
    vi.spyOn(registryModule, 'getSyncAdapter').mockReturnValue(adapter);
    saveConfig({ ...getConfig(), cortex: { author: 'tester' } });

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'cortex', 'push', '--cortex', 'cortex/engineering']);

    expect(pushSpy).toHaveBeenCalledWith('cortex/engineering');
    expect(process.exitCode).not.toBe(1);
  });

  // AC #2: parallel for sync.
  it('cortex sync --cortex <name> resolves <name> on the subcommand (AC #2)', async () => {
    const { adapter, syncSpy } = makeFakeAdapter();
    vi.spyOn(registryModule, 'getSyncAdapter').mockReturnValue(adapter);
    saveConfig({ ...getConfig(), cortex: { author: 'tester' } });

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'cortex', 'sync', '--cortex', 'cortex/engineering']);

    expect(syncSpy).toHaveBeenCalledWith('cortex/engineering');
    expect(process.exitCode).not.toBe(1);
  });
});

describe('AGT-438 / GH#63 — equals form --cortex=<name> (AC #3)', () => {
  it('cortex pull --cortex=<name> resolves identically to the space form (AC #3)', async () => {
    const { adapter, pullSpy } = makeFakeAdapter();
    vi.spyOn(registryModule, 'getSyncAdapter').mockReturnValue(adapter);
    saveConfig({ ...getConfig(), cortex: { author: 'tester' } });

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'cortex', 'pull', '--cortex=cortex/engineering']);

    expect(pullSpy).toHaveBeenCalledWith('cortex/engineering');
  });

  it('cortex push --cortex=<name> resolves identically to the space form (AC #3)', async () => {
    const { adapter, pushSpy } = makeFakeAdapter();
    vi.spyOn(registryModule, 'getSyncAdapter').mockReturnValue(adapter);
    saveConfig({ ...getConfig(), cortex: { author: 'tester' } });

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'cortex', 'push', '--cortex=cortex/engineering']);

    expect(pushSpy).toHaveBeenCalledWith('cortex/engineering');
  });

  it('cortex sync --cortex=<name> resolves identically to the space form (AC #3)', async () => {
    const { adapter, syncSpy } = makeFakeAdapter();
    vi.spyOn(registryModule, 'getSyncAdapter').mockReturnValue(adapter);
    saveConfig({ ...getConfig(), cortex: { author: 'tester' } });

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'cortex', 'sync', '--cortex=cortex/engineering']);

    expect(syncSpy).toHaveBeenCalledWith('cortex/engineering');
  });
});

describe('AGT-438 / GH#63 — global -C/--cortex form (AC #4)', () => {
  it('think -C <name> cortex pull resolves <name> via optsWithGlobals (AC #4)', async () => {
    const { adapter, pullSpy } = makeFakeAdapter();
    vi.spyOn(registryModule, 'getSyncAdapter').mockReturnValue(adapter);
    saveConfig({ ...getConfig(), cortex: { author: 'tester' } });

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', 'cortex/engineering', 'cortex', 'pull']);

    expect(pullSpy).toHaveBeenCalledWith('cortex/engineering');
    expect(process.exitCode).not.toBe(1);
  });

  it('think --cortex <name> cortex push resolves <name> via optsWithGlobals (AC #4)', async () => {
    const { adapter, pushSpy } = makeFakeAdapter();
    vi.spyOn(registryModule, 'getSyncAdapter').mockReturnValue(adapter);
    saveConfig({ ...getConfig(), cortex: { author: 'tester' } });

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '--cortex', 'cortex/engineering', 'cortex', 'push']);

    expect(pushSpy).toHaveBeenCalledWith('cortex/engineering');
    expect(process.exitCode).not.toBe(1);
  });

  it('think -C <name> cortex sync resolves <name> via optsWithGlobals (AC #4)', async () => {
    const { adapter, syncSpy } = makeFakeAdapter();
    vi.spyOn(registryModule, 'getSyncAdapter').mockReturnValue(adapter);
    saveConfig({ ...getConfig(), cortex: { author: 'tester' } });

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', 'cortex/engineering', 'cortex', 'sync']);

    expect(syncSpy).toHaveBeenCalledWith('cortex/engineering');
    expect(process.exitCode).not.toBe(1);
  });
});

describe('AGT-438 / GH#63 — non-regression: active-cortex default (AC #6)', () => {
  it('cortex pull (no flag) uses config.cortex.active (AC #6)', async () => {
    const { adapter, pullSpy } = makeFakeAdapter();
    vi.spyOn(registryModule, 'getSyncAdapter').mockReturnValue(adapter);
    saveConfig({ ...getConfig(), cortex: { author: 'tester', active: 'team-active' } });

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'cortex', 'pull']);

    expect(pullSpy).toHaveBeenCalledWith('team-active');
  });

  it('cortex push (no flag) uses config.cortex.active (AC #6)', async () => {
    const { adapter, pushSpy } = makeFakeAdapter();
    vi.spyOn(registryModule, 'getSyncAdapter').mockReturnValue(adapter);
    saveConfig({ ...getConfig(), cortex: { author: 'tester', active: 'team-active' } });

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'cortex', 'push']);

    expect(pushSpy).toHaveBeenCalledWith('team-active');
  });

  it('cortex sync (no flag) uses config.cortex.active (AC #6)', async () => {
    const { adapter, syncSpy } = makeFakeAdapter();
    vi.spyOn(registryModule, 'getSyncAdapter').mockReturnValue(adapter);
    saveConfig({ ...getConfig(), cortex: { author: 'tester', active: 'team-active' } });

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'cortex', 'sync']);

    expect(syncSpy).toHaveBeenCalledWith('team-active');
  });
});

describe('AGT-438 / GH#63 — precedence: local flag beats global beats active', () => {
  it('subcommand --cortex overrides both global -C and config.cortex.active', async () => {
    const { adapter, pullSpy } = makeFakeAdapter();
    vi.spyOn(registryModule, 'getSyncAdapter').mockReturnValue(adapter);
    saveConfig({ ...getConfig(), cortex: { author: 'tester', active: 'active-cx' } });

    const prog = makeProgram();
    // Both forms set a cortex; the subcommand flag must win.
    await prog.parseAsync(['node', 'think', '-C', 'global-cx', 'cortex', 'pull', '--cortex', 'local-cx']);

    expect(pullSpy).toHaveBeenCalledWith('local-cx');
  });

  it('global -C overrides config.cortex.active when no subcommand flag is set', async () => {
    const { adapter, pullSpy } = makeFakeAdapter();
    vi.spyOn(registryModule, 'getSyncAdapter').mockReturnValue(adapter);
    saveConfig({ ...getConfig(), cortex: { author: 'tester', active: 'active-cx' } });

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', 'global-cx', 'cortex', 'pull']);

    expect(pullSpy).toHaveBeenCalledWith('global-cx');
  });
});
