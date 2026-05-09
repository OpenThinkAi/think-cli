import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { retroCommand } from '../../src/commands/retro.js';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
import * as autoPropagate from '../../src/lib/auto-propagate.js';

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

  it('calls pushForWriteBackground after emit (AC #3)', async () => {
    const pushSpy = vi.spyOn(autoPropagate, 'pushForWriteBackground').mockImplementation(() => {});
    const cortex = 'push-on-write-test';

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'retro', 'observation for push test', '--cortex', cortex]);

    expect(pushSpy).toHaveBeenCalledWith(cortex, expect.objectContaining({ skip: false }));
    expect(process.exitCode).toBeFalsy();
  });

  it('--no-sync skips pushForWriteBackground (AC #4)', async () => {
    const pushSpy = vi.spyOn(autoPropagate, 'pushForWriteBackground').mockImplementation(() => {});
    const cortex = 'no-sync-push-test';

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'retro', 'no-sync observation', '--cortex', cortex, '--no-sync']);

    expect(pushSpy).toHaveBeenCalledWith(cortex, expect.objectContaining({ skip: true }));
  });

  it('exit code 0 unaffected by pushForWriteBackground (AC #5)', async () => {
    vi.spyOn(autoPropagate, 'pushForWriteBackground').mockImplementation(() => {
      throw new Error('simulated push failure');
    });
    const cortex = 'push-exit-code-test';

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'retro', 'observation', '--cortex', cortex]);

    expect(process.exitCode).toBeFalsy();
  });

  it('retro add subcommand calls pushForWriteBackground (AC #3)', async () => {
    const pushSpy = vi.spyOn(autoPropagate, 'pushForWriteBackground').mockImplementation(() => {});
    const cortex = 'add-sub-push-test';

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'retro', 'add', 'observation via add subcommand']);

    expect(pushSpy).toHaveBeenCalledWith(cortex, expect.objectContaining({ skip: false }));
  });

  // AGT-209 / GH#47: direct user emits land at promoted=1 so `retro recall`
  // surfaces them immediately. Prior behaviour (curator-only promotion via
  // occurrences>=2) made single-emit retros invisible by default and broke
  // the round-trip the user expects after `retro add`.
  it('retro add writes promoted=1 (AGT-209 AC #1)', async () => {
    const cortex = 'promoted-on-add-test';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'retro', 'user-attested observation', '--cortex', cortex]);

    const db = getCortexDb(cortex);
    const row = db.prepare('SELECT promoted FROM retros LIMIT 1').get() as { promoted: number };
    expect(row.promoted).toBe(1);
  });

  it('retro add subcommand also writes promoted=1 (AGT-209 AC #1)', async () => {
    const cortex = 'promoted-on-add-sub-test';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'retro', 'add', 'add subcommand observation']);

    const db = getCortexDb(cortex);
    const row = db.prepare('SELECT promoted FROM retros LIMIT 1').get() as { promoted: number };
    expect(row.promoted).toBe(1);
  });
});

// AGT-209 / GH#47 round-trip: end-to-end CLI behaviour — emit then recall in
// the same process must surface the just-emitted retro under default flags.
describe('think retro add → retro recall round-trip (AGT-209 AC #1)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-retro-roundtrip-test-'));
    process.env.THINK_HOME = tmpHome;
    closeAllCortexDbs();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Stub auto-propagation so the round-trip doesn't fork a background sync
    // process during the test (would race the cleanup tear-down).
    vi.spyOn(autoPropagate, 'pushForWriteBackground').mockImplementation(() => {});
    vi.spyOn(autoPropagate, 'pullForRead').mockResolvedValue(undefined);
  });

  afterEach(() => {
    closeAllCortexDbs();
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it('a single retro add is visible via default retro recall', async () => {
    const cortex = 'roundtrip-test';
    const text = 'roundtrip retro observation';

    const prog1 = makeProgram();
    await prog1.parseAsync(['node', 'think', 'retro', 'add', text, '--cortex', cortex]);
    expect(process.exitCode).toBeFalsy();

    const prog2 = makeProgram();
    await prog2.parseAsync(['node', 'think', 'retro', 'recall', '--cortex', cortex]);
    expect(process.exitCode).toBeFalsy();

    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toContain(text);
  });
});

// AGT-209 / GH#47 AC #3: when first-emit persistence fails, exit non-zero
// and surface the error rather than printing a misleading success checkmark.
describe('think retro add — first-emit failure surfacing (AGT-209 AC #3)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-retro-loudfail-test-'));
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

  it('first-emit exits non-zero when adapter.push reports errors', async () => {
    const { saveConfig, getConfig } = await import('../../src/lib/config.js');
    const { GitSyncAdapter } = await import('../../src/sync/git-adapter.js');

    saveConfig({
      ...getConfig(),
      cortex: { author: 'test', repo: 'git@example.invalid:org/cortex.git' },
    });

    // Reachable but push reports a downstream error (auth, ref-protection,
    // anything the lazy createOrphanBranch can't paper over).
    vi.spyOn(GitSyncAdapter.prototype, 'isReachable').mockResolvedValue(true);
    vi.spyOn(GitSyncAdapter.prototype, 'push').mockResolvedValue({
      pushed: 0,
      pulled: 0,
      errors: ['simulated remote write failure'],
    });

    const cortex = 'first-emit-fail-test';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'retro', 'add', 'observation that will fail to push', '--cortex', cortex]);

    expect(process.exitCode).toBe(1);
    const errOutput = (console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(errOutput).toContain('simulated remote write failure');
  });

  it('first-emit exits non-zero when adapter.push throws', async () => {
    const { saveConfig, getConfig } = await import('../../src/lib/config.js');
    const { GitSyncAdapter } = await import('../../src/sync/git-adapter.js');

    saveConfig({
      ...getConfig(),
      cortex: { author: 'test', repo: 'git@example.invalid:org/cortex.git' },
    });

    vi.spyOn(GitSyncAdapter.prototype, 'isReachable').mockResolvedValue(true);
    vi.spyOn(GitSyncAdapter.prototype, 'push').mockRejectedValue(new Error('network exploded'));

    const cortex = 'first-emit-throw-test';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'retro', 'add', 'observation that throws', '--cortex', cortex]);

    expect(process.exitCode).toBe(1);
    const errOutput = (console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(errOutput).toContain('network exploded');
  });

  it('first-emit falls through to background path when remote is unreachable', async () => {
    // Offline emit is a supported mode — auto-sync will retry. Don't fail
    // the user for being on a flaky connection.
    const { saveConfig, getConfig } = await import('../../src/lib/config.js');
    const { GitSyncAdapter } = await import('../../src/sync/git-adapter.js');

    saveConfig({
      ...getConfig(),
      cortex: { author: 'test', repo: 'git@example.invalid:org/cortex.git' },
    });

    vi.spyOn(GitSyncAdapter.prototype, 'isReachable').mockResolvedValue(false);
    const pushSpy = vi.spyOn(GitSyncAdapter.prototype, 'push');
    const bgSpy = vi.spyOn(autoPropagate, 'pushForWriteBackground').mockImplementation(() => {});

    const cortex = 'first-emit-offline-test';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'retro', 'add', 'offline observation', '--cortex', cortex]);

    expect(process.exitCode).toBeFalsy();
    expect(pushSpy).not.toHaveBeenCalled();
    expect(bgSpy).toHaveBeenCalled();
  });
});
