/**
 * Tests for `think retro` command — iterative-learning v3 (retro locality).
 *
 * v3 contract (supersedes the AGT-294 per-context-branch contract):
 *  1. Storage cortex = home cortex: global -C, else config.cortex.active.
 *  2. Context is auto-detected from the git repo (basename) and folded into
 *     topics as a reserved 'repo:<context>' tag.
 *  3. --context <name> overrides the auto-detected context.
 *  4. -C / --cortex selects the home cortex to STORE on (commander routes the
 *     long name to the program-global option in every position).
 *  5. Outside a git repo (no detected context, no --context), the retro is
 *     stored untagged.
 *  6. v2 subcommands (add / recall) still no-op with a migration message.
 *
 * detectWorkingContext is mocked to null by default so topic assertions are
 * deterministic regardless of where the test process runs (it runs inside the
 * think-cli repo, which would otherwise auto-tag every write).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { makeRetroCommand } from '../../src/commands/retro.js';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
import * as daemonClientModule from '../../src/lib/daemon-client.js';
import { DaemonUnavailableError } from '../../src/lib/daemon-client.js';
import * as workingContext from '../../src/lib/working-context.js';

/** Build a fresh program with a fresh retro command instance per test */
function makeProgram(): Command {
  const prog = new Command();
  prog.option('-C, --cortex <name>', 'Use a specific cortex for this command');
  prog.addCommand(makeRetroCommand());
  return prog;
}

/** Minimal DaemonClient stub that resolves successfully */
function makeMockClient(resultOverride?: Partial<{ entry_id: string; status: string; warnings: string[] }>) {
  const result = {
    entry_id: 'retro-entry-id-abc123',
    status: 'stored' as const,
    ...resultOverride,
  };
  return {
    call: vi.fn().mockResolvedValue(result),
    close: vi.fn(),
  };
}

describe('think retro — v3 locality', () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-retro-v3-test-'));
    process.env.THINK_HOME = tmpHome;
    // Cortex DB handles are cached per process — drop any held over from a
    // prior test's (now-deleted) THINK_HOME.
    closeAllCortexDbs();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Default: behave as if run outside a git repo so topic assertions are
    // deterministic. Tests that exercise auto-detection override this.
    vi.spyOn(workingContext, 'detectWorkingContext').mockReturnValue(null);
  });

  afterEach(() => {
    closeAllCortexDbs();
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it('stores on the -C home cortex with kind="retro" (no context → no topics)', async () => {
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const cortex = 'engineering';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'retro', 'some codebase observation']);

    expect(daemonClientModule.connectDaemon).toHaveBeenCalled();
    expect(mockClient.call).toHaveBeenCalledWith('sync', {
      cortex,
      content: 'some codebase observation',
      kind: 'retro',
    });
    expect(mockClient.close).toHaveBeenCalled();
  });

  it('outputs "✓ [cortex] ... stored retro <id>" with content excerpt on success', async () => {
    const mockClient = makeMockClient({ entry_id: 'abc123def456' });
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const cortex = 'engineering';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'retro', 'some observation']);

    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toContain('stored retro abc123def456');
    expect(output).toContain(cortex);
    expect(output).toContain('some observation');
  });

  it('auto-detects the git repo context and tags it as repo:<context>', async () => {
    vi.spyOn(workingContext, 'detectWorkingContext').mockReturnValue('stamp-cli');
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', 'engineering', 'retro', 'tests run after merge before push']);

    const callArgs = mockClient.call.mock.calls[0][1] as Record<string, unknown>;
    expect(callArgs.cortex).toBe('engineering');
    expect(callArgs.topics).toEqual(['repo:stamp-cli']);
  });

  it('--context overrides the auto-detected context', async () => {
    vi.spyOn(workingContext, 'detectWorkingContext').mockReturnValue('detected-repo');
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', 'engineering', 'retro', 'obs', '--context', 'Fx-Tracker']);

    const callArgs = mockClient.call.mock.calls[0][1] as Record<string, unknown>;
    // normalized lowercase, detected value ignored
    expect(callArgs.topics).toEqual(['repo:fx-tracker']);
  });

  it('appends the context topic after user --topic values', async () => {
    vi.spyOn(workingContext, 'detectWorkingContext').mockReturnValue('stamp-cli');
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', 'eng', 'retro', 'obs', '--topic', 'ux', '--topic', 'perf']);

    const callArgs = mockClient.call.mock.calls[0][1] as Record<string, unknown>;
    expect(callArgs.topics).toEqual(['ux', 'perf', 'repo:stamp-cli']);
  });

  it('--topic alone (no context) is forwarded unchanged', async () => {
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', 'eng', 'retro', 'topical obs', '--topic', 'ux', '--topic', 'perf']);

    expect(mockClient.call).toHaveBeenCalledWith('sync', expect.objectContaining({
      topics: ['ux', 'perf'],
    }));
  });

  it('omits topics key when no context and no --topic', async () => {
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', 'eng', 'retro', 'observation without topics']);

    const callArgs = mockClient.call.mock.calls[0][1] as Record<string, unknown>;
    expect(callArgs).not.toHaveProperty('topics');
  });

  it('falls back to config active cortex for storage when no -C', async () => {
    const { saveConfig, getConfig } = await import('../../src/lib/config.js');
    saveConfig({ ...getConfig(), cortex: { active: 'personal' } });

    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'retro', 'obs stored on active cortex']);

    expect(mockClient.call).toHaveBeenCalledWith('sync', expect.objectContaining({
      cortex: 'personal',
    }));
  });

  it('--cortex (like -C) selects the storage cortex; context still auto-detected', async () => {
    vi.spyOn(workingContext, 'detectWorkingContext').mockReturnValue('stamp-cli');
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'retro', 'obs', '--cortex', 'engineering']);

    const callArgs = mockClient.call.mock.calls[0][1] as Record<string, unknown>;
    expect(callArgs.cortex).toBe('engineering');         // --cortex = storage
    expect(callArgs.topics).toEqual(['repo:stamp-cli']); // context from the repo
  });

  it('exits non-zero when no home cortex is resolvable', async () => {
    const connectSpy = vi.spyOn(daemonClientModule, 'connectDaemon');
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'retro', 'obs with no home cortex']);

    expect(connectSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    const err = (console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(err).toContain('no home cortex');
  });

  it('content "add" exits non-zero with migration message', async () => {
    const connectSpy = vi.spyOn(daemonClientModule, 'connectDaemon');

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', 'eng', 'retro', 'add']);

    expect(connectSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    const errOutput = (console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(errOutput).toContain('"add" is no longer a subcommand');
  });

  it('content "recall" exits non-zero with migration message', async () => {
    const connectSpy = vi.spyOn(daemonClientModule, 'connectDaemon');

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', 'eng', 'retro', 'recall']);

    expect(connectSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    const errOutput = (console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(errOutput).toContain('"recall" is no longer a subcommand');
  });

  it('L1 entry has kind: "retro"', async () => {
    const mockClient = makeMockClient({ entry_id: 'kind-check-id' });
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', 'kind-check', 'retro', 'the observation']);

    const callArgs = mockClient.call.mock.calls[0][1] as Record<string, unknown>;
    expect(callArgs.kind).toBe('retro');
  });

  it('writes the retro to L1 when the daemon is unavailable (AGT-1298)', async () => {
    vi.spyOn(daemonClientModule, 'connectDaemon').mockRejectedValue(
      new DaemonUnavailableError('daemon failed to start', '/tmp/think/daemon.log'),
    );
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const cortex = 'unavail-test';
    const prog = makeProgram();
    await prog.parseAsync([
      'node', 'think', '-C', cortex, 'retro',
      'the plumbing writer never checks the shared worktree out — that is the point',
    ]);

    // A daemon-down retro is no longer an error: it is written to L1 and
    // indexed on the next daemon start.
    expect(process.exitCode).toBeFalsy();
    const db = getCortexDb(cortex);
    const row = db.prepare('SELECT line FROM l1_outbox LIMIT 1').get() as { line: string } | undefined;
    expect(row).toBeDefined();
    expect((JSON.parse(row!.line) as Record<string, unknown>).kind).toBe('retro');
    expect(stderrSpy.mock.calls.flat().join('')).toContain('daemon unavailable');
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toContain('stored retro');
  });

  it('also writes to L1 when the connect fails with a raw socket error', async () => {
    // A stale/garbage socket path fails with ENOTSOCK etc., not
    // DaemonUnavailableError — still "unreachable", so still an L1 write.
    vi.spyOn(daemonClientModule, 'connectDaemon').mockRejectedValue(
      Object.assign(new Error('connect ENOTSOCK /tmp/think/daemon.sock'), { code: 'ENOTSOCK' }),
    );
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const cortex = 'raw-connect-error';
    const prog = makeProgram();
    await prog.parseAsync([
      'node', 'think', '-C', cortex, 'retro',
      'a socket that is not a socket is still a daemon you cannot reach',
    ]);

    expect(process.exitCode).toBeFalsy();
    const db = getCortexDb(cortex);
    const row = db.prepare('SELECT COUNT(*) as count FROM l1_outbox').get() as { count: number };
    expect(row.count).toBe(1);
  });

  it('a daemon that ANSWERS with an error is not routed around', async () => {
    // The quality gate and every other daemon-side refusal must stay fatal —
    // degrading here would let a rejected retro in through the back door.
    const client = {
      call: vi.fn().mockRejectedValue(new Error('retro rejected: content is too short')),
      close: vi.fn(),
    };
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(client);

    const cortex = 'daemon-refusal';
    const prog = makeProgram();
    await prog.parseAsync([
      'node', 'think', '-C', cortex, 'retro',
      'a lesson the daemon will refuse for its own reasons entirely',
    ]);

    expect(process.exitCode).toBe(1);
    const errOutput = (console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(errOutput).toContain('daemon error');
    const db = getCortexDb(cortex);
    const row = db.prepare('SELECT COUNT(*) as count FROM l1_outbox').get() as { count: number };
    expect(row.count).toBe(0);
  });

  it('still applies the AGT-455 quality gate on the daemon-down path', async () => {
    vi.spyOn(daemonClientModule, 'connectDaemon').mockRejectedValue(
      new DaemonUnavailableError('daemon failed to start', '/tmp/think/daemon.log'),
    );

    const cortex = 'unavail-gate-test';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'retro', 'too short']);

    expect(process.exitCode).toBe(1);
    const errOutput = (console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(errOutput).toContain('retro rejected');
    const db = getCortexDb(cortex);
    const outbox = db.prepare('SELECT COUNT(*) as count FROM l1_outbox').get() as { count: number };
    expect(outbox.count).toBe(0);
  });

  it('exits non-zero when the daemon is unavailable AND the L1 write fails (AC #4)', async () => {
    vi.spyOn(daemonClientModule, 'connectDaemon').mockRejectedValue(
      new DaemonUnavailableError('daemon failed to start', '/tmp/think/daemon.log'),
    );

    // sanitizeName rejects path separators, so the outbox insert cannot happen.
    const prog = makeProgram();
    await prog.parseAsync([
      'node', 'think', '-C', '../escape', 'retro',
      'a lesson long enough to clear the quality gate but with nowhere to go',
    ]);

    expect(process.exitCode).toBe(1);
    const errOutput = (console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(errOutput).toContain('L1 write failed');
  });

  it('surfaces advisory warnings from daemon', async () => {
    const mockClient = makeMockClient({
      entry_id: 'warn-id',
      warnings: ['near-duplicate check running'],
    });
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', 'warnings-test', 'retro', 'content with warnings']);

    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toContain('near-duplicate check running');
  });

  it('exits 0 on success', async () => {
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', 'exit-test', 'retro', 'test content']);

    expect(process.exitCode).toBeFalsy();
  });

  it('uses "queued" output label when daemon returns status=queued', async () => {
    const mockClient = makeMockClient({ entry_id: 'queue-id', status: 'queued' });
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', 'queued-test', 'retro', 'queued content']);

    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toContain('queued retro queue-id');
  });

  // think-cli#98 / AGT-1331: retro accepts --silent like sync and event.
  it('--silent stores the retro with no stdout output and exits 0', async () => {
    const mockClient = makeMockClient({ warnings: ['near-duplicate check running'] });
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const prog = makeProgram();
    await prog.parseAsync([
      'node', 'think', '-C', 'silent-retro', 'retro',
      'silent retros still land on the home cortex', '--silent',
    ]);

    expect(mockClient.call).toHaveBeenCalledOnce();
    expect((mockClient.call.mock.calls[0][1] as Record<string, unknown>).kind).toBe('retro');
    expect((console.log as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    expect(process.exitCode).toBeFalsy();
  });

  it('--silent on the daemon-down path writes to L1 and still emits the stderr note (#95)', async () => {
    vi.spyOn(daemonClientModule, 'connectDaemon').mockRejectedValue(
      new DaemonUnavailableError('daemon failed to start', '/tmp/think/daemon.log'),
    );
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const cortex = 'silent-retro-down';
    const prog = makeProgram();
    await prog.parseAsync([
      'node', 'think', '-C', cortex, 'retro',
      'a silent retro written while the daemon is down still reaches L1', '--silent',
    ]);

    expect(process.exitCode).toBeFalsy();
    const db = getCortexDb(cortex);
    const row = db.prepare('SELECT line FROM l1_outbox LIMIT 1').get() as { line: string } | undefined;
    expect(row).toBeDefined();
    expect((JSON.parse(row!.line) as Record<string, unknown>).kind).toBe('retro');
    expect((console.log as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    const stderr = stderrSpy.mock.calls.flat().join('');
    expect(stderr).toContain('daemon unavailable');
    expect(stderr).toContain('indexed on next daemon start');
  });

  it('--silent does not hide a daemon refusal', async () => {
    const client = {
      call: vi.fn().mockRejectedValue(new Error('retro rejected: content is too short')),
      close: vi.fn(),
    };
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(client);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', 'silent-refusal', 'retro', 'too short', '--silent']);

    expect(process.exitCode).toBe(1);
    const errOutput = (console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(errOutput).toContain('retro rejected');
  });

  it('--help lists --silent', () => {
    expect(makeRetroCommand().helpInformation()).toContain('--silent');
  });
});
