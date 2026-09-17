/**
 * Tests for `think sync` command — AGT-293
 *
 * Verifies:
 *  1. When daemon is available, calls daemonClient.call("sync", {..., kind: "memory"})
 *  2. Output is "✓ [<cortex>] <ts> stored memory <id>" for status=stored
 *     or "⏳ [<cortex>] queued memory <id> (indexing in background)" for
 *     status=queued (distinct sigil + verb reflect L2 commitment state;
 *     timestamp omitted because client wall-clock may diverge from
 *     eventual L2 storage time)
 *  3. --silent suppresses output
 *  4. --no-sync flag forwarded to daemon as skipPush:true
 *  5. When daemon unavailable (DaemonUnavailableError), the entry is written to
 *     the cortex's L1 outbox — never the engrams table — with a one-line stderr
 *     note that survives --silent (AGT-1298)
 *  6. AGT-1297: -e/--episode, --context and -d/--decision are hard-removed —
 *     each exits non-zero with a one-line stderr pointer to `think event`,
 *     even under --silent, and writes nothing (daemon never contacted, no
 *     engram row inserted)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { makeSyncCommand } from '../../src/commands/log.js';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
import * as daemonClientModule from '../../src/lib/daemon-client.js';
import { DaemonUnavailableError } from '../../src/lib/daemon-client.js';

/** Build a fresh program with a fresh sync command instance per test —
 * Commander mutates _parent on addCommand, so reusing a single Command
 * across tests would silently propagate stale parent pointers. */
function makeProgram(): Command {
  const prog = new Command();
  prog.option('-C, --cortex <name>', 'Use a specific cortex for this command');
  prog.addCommand(makeSyncCommand());
  return prog;
}

/** Minimal DaemonClient stub that resolves successfully */
function makeMockClient(resultOverride?: Partial<{ entry_id: string; status: string; warnings: string[] }>) {
  const result = {
    entry_id: 'test-entry-id-abc123',
    status: 'stored' as const,
    ...resultOverride,
  };
  return {
    call: vi.fn().mockResolvedValue(result),
    close: vi.fn(),
  };
}

/**
 * Shared setup: each test gets a fresh THINK_HOME under tmp, console.log
 * silenced, and full teardown. Used by all three describe blocks below.
 * Wraps Vitest's beforeEach/afterEach so the duplication stays in one place.
 */
function withFreshThinkHome(prefix: string): void {
  let originalHome: string | undefined;
  let tmpHome: string;
  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), prefix));
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
}

describe('think sync — daemon-routed path (AGT-293)', () => {
  withFreshThinkHome('think-sync-cmd-test-');

  it('calls daemonClient.call("sync", { cortex, content, kind: "memory", skipPush }) (AC #1)', async () => {
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const cortex = 'daemon-call-test';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'sync', 'test memory content']);

    expect(daemonClientModule.connectDaemon).toHaveBeenCalled();
    expect(mockClient.call).toHaveBeenCalledWith('sync', {
      cortex,
      content: 'test memory content',
      kind: 'memory',
      skipPush: false, // default: opts.sync=true → skipPush=false
    });
    expect(mockClient.close).toHaveBeenCalled();
  });

  it('forwards skipPush:true when --no-push is passed (canonical flag, AGT-293)', async () => {
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const cortex = 'no-push-test';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'sync', 'no-push content', '--no-push']);

    expect(mockClient.call).toHaveBeenCalledWith('sync', expect.objectContaining({
      skipPush: true,
    }));
  });

  it('forwards skipPush:true when --no-sync is passed (deprecated alias, AC #4)', async () => {
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const cortex = 'no-sync-test';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'sync', 'no-sync content', '--no-sync']);

    expect(mockClient.call).toHaveBeenCalledWith('sync', expect.objectContaining({
      skipPush: true,
    }));
  });

  it('emits stderr deprecation warning when --no-sync is invoked (AGT-293 review)', async () => {
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const cortex = 'no-sync-warn-test';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'sync', 'deprecated flag', '--no-sync']);

    const stderr = stderrSpy.mock.calls.flat().join('');
    expect(stderr).toContain('--no-sync is deprecated');
    expect(stderr).toContain('--no-push');
  });

  it('suppresses the --no-sync deprecation warning under --silent', async () => {
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const cortex = 'no-sync-silent-test';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'sync', 'silent deprecated', '--no-sync', '--silent']);

    const stderr = stderrSpy.mock.calls.flat().join('');
    expect(stderr).not.toContain('--no-sync is deprecated');
  });

  it('outputs "<ts> stored memory <id>" on success (AC #2)', async () => {
    const mockClient = makeMockClient({ entry_id: 'abc123def456' });
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const cortex = 'output-format-test';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'sync', 'output format check']);

    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toContain('stored memory abc123def456');
  });

  it('--silent suppresses all output (AC #3)', async () => {
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const cortex = 'silent-test';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'sync', 'silent content', '--silent']);

    expect((console.log as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    // Daemon call should still happen
    expect(mockClient.call).toHaveBeenCalled();
  });

  it('surfaces daemon advisory warnings when not silent', async () => {
    const mockClient = makeMockClient({
      entry_id: 'warn-id',
      warnings: ["kind 'memory' stored to L1 only; L2 schema extension pending"],
    });
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const cortex = 'warnings-test';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'sync', 'content with warnings']);

    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toContain('L2 schema extension pending');
  });

  it('exits 0 on success', async () => {
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const cortex = 'exit-code-test';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'sync', 'test content']);

    expect(process.exitCode).toBeFalsy();
  });

  it('rejects --decision: non-zero exit, stderr pointer, nothing written (AGT-1297 AC #1/#2/#4)', async () => {
    const connectSpy = vi.spyOn(daemonClientModule, 'connectDaemon');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const cortex = 'decision-removed-test';
    const prog = makeProgram();
    await prog.parseAsync([
      'node', 'think', '-C', cortex, 'sync', 'content with decision',
      '--decision', 'chose option A',
    ]);

    expect(process.exitCode).toBe(1);
    const stderr = stderrSpy.mock.calls.flat().join('');
    expect(stderr).toContain('--decision');
    expect(stderr).toContain('think event');
    // Nothing was written and the daemon was never contacted.
    expect(connectSpy).not.toHaveBeenCalled();
    const db = getCortexDb(cortex);
    const row = db.prepare('SELECT COUNT(*) as count FROM engrams').get() as { count: number };
    expect(row.count).toBe(0);
  });

  it('rejects --decision under --silent too (the pointer is not output, not diagnostics)', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const cortex = 'decision-removed-silent-test';
    const prog = makeProgram();
    await prog.parseAsync([
      'node', 'think', '-C', cortex, 'sync', 'silent decision',
      '--decision', 'critical decision text', '--silent',
    ]);

    expect(process.exitCode).toBe(1);
    expect(stderrSpy.mock.calls.flat().join('')).toContain('--decision');
    expect((console.log as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    const db = getCortexDb(cortex);
    const row = db.prepare('SELECT COUNT(*) as count FROM engrams').get() as { count: number };
    expect(row.count).toBe(0);
  });

  it('rejects --context: non-zero exit, stderr pointer, nothing written (AGT-1297 AC #1/#2/#4)', async () => {
    const connectSpy = vi.spyOn(daemonClientModule, 'connectDaemon');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const cortex = 'context-removed-test';
    const prog = makeProgram();
    await prog.parseAsync([
      'node', 'think', '-C', cortex, 'sync', 'content with context',
      '--context', '{"foo":"bar"}',
    ]);

    expect(process.exitCode).toBe(1);
    const stderr = stderrSpy.mock.calls.flat().join('');
    expect(stderr).toContain('--context');
    expect(stderr).toContain('think event');
    expect(connectSpy).not.toHaveBeenCalled();
    const db = getCortexDb(cortex);
    const row = db.prepare('SELECT COUNT(*) as count FROM engrams').get() as { count: number };
    expect(row.count).toBe(0);
  });

  it('rejects -e/--episode: non-zero exit, stderr pointer, nothing written (AGT-1297 AC #1/#2/#4)', async () => {
    const connectSpy = vi.spyOn(daemonClientModule, 'connectDaemon');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const cortex = 'episode-removed-test';
    const prog = makeProgram();
    await prog.parseAsync([
      'node', 'think', '-C', cortex, 'sync', 'content with episode',
      '-e', 'some-episode-key',
    ]);

    expect(process.exitCode).toBe(1);
    const stderr = stderrSpy.mock.calls.flat().join('');
    expect(stderr).toContain('episode');
    expect(stderr).toContain('think event');
    expect(connectSpy).not.toHaveBeenCalled();
    const db = getCortexDb(cortex);
    const row = db.prepare('SELECT COUNT(*) as count FROM engrams').get() as { count: number };
    expect(row.count).toBe(0);
  });

  it('think sync --help no longer lists the removed flags (AGT-1297 AC #3)', () => {
    const prog = makeProgram();
    const helpText = prog.commands.find(c => c.name() === 'sync')!.helpInformation();

    expect(helpText).not.toContain('--decision');
    expect(helpText).not.toContain('--context');
    expect(helpText).not.toContain('--episode');
  });

  it('echoes content in success output', async () => {
    const mockClient = makeMockClient({ entry_id: 'echo-id' });
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const cortex = 'echo-test';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'sync', 'the content to confirm']);

    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toContain('the content to confirm');
  });

  it('uses "queued" output label when daemon returns status=queued (AC #2)', async () => {
    const mockClient = makeMockClient({ entry_id: 'queue-id', status: 'queued' });
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const cortex = 'queued-status-test';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'sync', 'queued content']);

    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toContain('queued memory queue-id (indexing in background)');
  });

  // AGT-296: --topic flags reach the daemon topics array
  it('forwards multiple --topic flags as topics array to daemon (AGT-296 AC #6)', async () => {
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const cortex = 'topic-test';
    const prog = makeProgram();
    await prog.parseAsync([
      'node', 'think', '-C', cortex, 'sync', 'merged the JWT refresh PR',
      '--topic', 'auth', '--topic', 'jwt',
    ]);

    const callArgs = mockClient.call.mock.calls[0][1] as Record<string, unknown>;
    expect(callArgs['topics']).toEqual(['auth', 'jwt']);
  });

  it('omits topics key when no --topic flags given (AGT-296)', async () => {
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const cortex = 'no-topic-test';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'sync', 'some memory']);

    const callArgs = mockClient.call.mock.calls[0][1] as Record<string, unknown>;
    expect(callArgs).not.toHaveProperty('topics');
  });
});

describe('think sync — daemon-down write goes to L1 (AGT-1298, AC #5)', () => {
  withFreshThinkHome('think-sync-fallback-test-');

  /** Read the pending l1_outbox lines for a cortex, parsed. */
  function outboxEntries(cortex: string): Record<string, unknown>[] {
    const db = getCortexDb(cortex);
    const rows = db.prepare('SELECT line FROM l1_outbox ORDER BY id ASC').all() as unknown as { line: string }[];
    return rows.map(r => JSON.parse(r.line) as Record<string, unknown>);
  }

  it('enqueues a kind="memory" L1 entry — and writes nothing to engrams', async () => {
    vi.spyOn(daemonClientModule, 'connectDaemon').mockRejectedValue(new DaemonUnavailableError('daemon failed to start; check ~/.think/daemon.log'));

    const cortex = 'fallback-test';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'sync', 'fallback content', '--topic', 'auth']);

    const entries = outboxEntries(cortex);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('memory');
    expect(entries[0].content).toBe('fallback content');
    expect(entries[0].topics).toEqual(['auth']);
    // The whole point of AGT-1298: the v2 engrams table nothing drains stays empty.
    const db = getCortexDb(cortex);
    const engrams = db.prepare('SELECT COUNT(*) as count FROM engrams').get() as { count: number };
    expect(engrams.count).toBe(0);
  });

  it('shows "daemon unavailable" note on stderr, success line on stdout (AC #3)', async () => {
    vi.spyOn(daemonClientModule, 'connectDaemon').mockRejectedValue(new DaemonUnavailableError('daemon failed to start; check ~/.think/daemon.log'));

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const cortex = 'degraded-note-test';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'sync', 'fallback content']);

    // ✓ line goes to stdout; note goes to stderr so callers capturing stdout
    // don't embed it in their parsed value.
    const stdout = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    const stderr = stderrSpy.mock.calls.flat().join('');
    expect(stdout).toContain('stored memory');
    expect(stdout).not.toContain('daemon unavailable');
    expect(stderr).toContain('daemon unavailable');
    expect(stderr).toContain('indexed on next daemon start');
  });

  it('--silent keeps stdout empty but STILL emits the one-line note (AC #3)', async () => {
    vi.spyOn(daemonClientModule, 'connectDaemon').mockRejectedValue(new DaemonUnavailableError('daemon failed to start; check ~/.think/daemon.log'));
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const cortex = 'degraded-silent-test';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'sync', 'fallback silent', '--silent']);

    expect((console.log as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    // Unlike every other diagnostic, this one survives --silent: a --silent
    // auto-logging hook must still leave a trace that the daemon was down.
    const stderr = stderrSpy.mock.calls.flat().join('');
    expect(stderr).toContain('daemon unavailable');
    expect(stderr.trim().split('\n')).toHaveLength(1);
    expect(outboxEntries(cortex)).toHaveLength(1);
  });

  it('exits 0 when the L1 write succeeds', async () => {
    vi.spyOn(daemonClientModule, 'connectDaemon').mockRejectedValue(new DaemonUnavailableError('daemon failed to start; check ~/.think/daemon.log'));

    const cortex = 'degraded-exit-test';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'sync', 'fallback exit test']);

    expect(process.exitCode).toBeFalsy();
  });

  it('exits non-zero and reports when the L1 write itself fails (AC #4)', async () => {
    vi.spyOn(daemonClientModule, 'connectDaemon').mockRejectedValue(new DaemonUnavailableError('daemon failed to start; check ~/.think/daemon.log'));
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // An unwritable cortex name: sanitizeName rejects path separators, so the
    // outbox insert can never happen.
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', '../escape', 'sync', 'unwritable content']);

    expect(process.exitCode).toBe(1);
    const stderr = stderrSpy.mock.calls.flat().join('');
    expect(stderr).toContain('L1 write failed');
    // No phantom success line.
    const stdout = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(stdout).not.toContain('stored memory');
  });

  it('surfaces unexpected daemon error on stderr and still writes to L1', async () => {
    vi.spyOn(daemonClientModule, 'connectDaemon').mockRejectedValue(
      new Error('unexpected protocol error: malformed response'),
    );
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const cortex = 'unexpected-error-test';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'sync', 'test content']);

    // (a) entry still written — to L1, not engrams
    expect(outboxEntries(cortex)).toHaveLength(1);

    // (b) error surfaced on stderr
    const stderrOutput = stderrSpy.mock.calls.flat().join('');
    expect(stderrOutput).toContain('daemon error');
    expect(stderrOutput).toContain('unexpected protocol error');

    // (c) the diagnostic stays off stdout
    const logOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(logOutput).not.toContain('daemon error');
  });

  it('--silent suppresses the unexpected-daemon-error line (but not the L1 note)', async () => {
    vi.spyOn(daemonClientModule, 'connectDaemon').mockRejectedValue(
      new Error('unexpected protocol error: malformed response'),
    );
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const cortex = 'unexpected-silent-test';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'sync', 'silent fallback', '--silent']);

    // Entry still written
    expect(outboxEntries(cortex)).toHaveLength(1);

    const stderrOutput = stderrSpy.mock.calls.flat().join('');
    expect(stderrOutput).not.toContain('daemon error');
    expect(stderrOutput).toContain('daemon unavailable');
  });
});

describe('think sync — no cortex configured (original local think.db path)', () => {
  withFreshThinkHome('think-sync-nocortex-test-');

  it('writes to local think.db when no cortex is active (legacy path)', async () => {
    const connectSpy = vi.spyOn(daemonClientModule, 'connectDaemon');

    const prog = makeProgram();
    // No -C flag; no cortex configured in fresh tmpHome
    await prog.parseAsync(['node', 'think', 'sync', 'no cortex message']);

    // Daemon should NOT be called when no cortex is configured
    expect(connectSpy).not.toHaveBeenCalled();
    // Output should have the legacy format
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toContain('[sync]');
  });
});
