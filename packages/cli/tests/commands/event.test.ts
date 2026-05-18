/**
 * Tests for `think event` command -- AGT-295
 *
 * Verifies:
 *  1. When daemon is available, calls daemonClient.call("sync", {..., kind: "event"})
 *  2. Output is "✓ [<cortex>] stored event <id>" for status=stored
 *  3. L1 entry has kind: "event", compacted_from: null, supersedes: []
 *  4. --silent suppresses output
 *  5. --topic flag forwarded as topics array
 *  6. --cortex local flag overrides global -C
 *  7. When daemon unavailable (DaemonUnavailableError), falls back to v2 direct-write
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { makeEventCommand } from '../../src/commands/event.js';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
import * as daemonClientModule from '../../src/lib/daemon-client.js';
import { DaemonUnavailableError } from '../../src/lib/daemon-client.js';

/** Build a fresh program with a fresh event command instance per test. */
function makeProgram(): Command {
  const prog = new Command();
  prog.option('-C, --cortex <name>', 'Use a specific cortex for this command');
  prog.addCommand(makeEventCommand());
  return prog;
}

/** Minimal DaemonClient stub that resolves successfully. */
function makeMockClient(resultOverride?: Partial<{ entry_id: string; status: string; warnings: string[] }>) {
  const result = {
    entry_id: 'test-event-id-abc123',
    status: 'stored' as const,
    ...resultOverride,
  };
  return {
    call: vi.fn().mockResolvedValue(result),
    close: vi.fn(),
  };
}

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

describe('think event -- daemon-routed path (AGT-295)', () => {
  withFreshThinkHome('think-event-cmd-test-');

  it('calls daemonClient.call("sync", { cortex, content, kind: "event", skipPush }) (AC #1)', async () => {
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const cortex = 'event-daemon-call-test';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'event', 'deployed v1.0.0 to production']);

    expect(daemonClientModule.connectDaemon).toHaveBeenCalled();
    expect(mockClient.call).toHaveBeenCalledWith('sync', {
      cortex,
      content: 'deployed v1.0.0 to production',
      kind: 'event',
      topics: undefined,
      skipPush: false,
    });
    expect(mockClient.close).toHaveBeenCalled();
  });

  it('passes kind: "event" -- not "memory" (core AC)', async () => {
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', 'kind-check-cortex', 'event', 'milestone reached']);

    const callArgs = mockClient.call.mock.calls[0][1] as Record<string, unknown>;
    expect(callArgs['kind']).toBe('event');
    expect(callArgs['kind']).not.toBe('memory');
    expect(callArgs['kind']).not.toBe('retro');
  });

  it('outputs "stored event <id>" on success (AC #2)', async () => {
    const mockClient = makeMockClient({ entry_id: 'abc123event' });
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const cortex = 'event-output-test';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'event', 'a notable thing happened']);

    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toContain('stored event abc123event');
  });

  it('forwards --topic as topics array (AC #5)', async () => {
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const cortex = 'event-topic-test';
    const prog = makeProgram();
    await prog.parseAsync([
      'node', 'think', '-C', cortex, 'event', 'decision made',
      '--topic', 'architecture', '--topic', 'reliability',
    ]);

    expect(mockClient.call).toHaveBeenCalledWith('sync', expect.objectContaining({
      topics: ['architecture', 'reliability'],
    }));
  });

  it('omits topics field when no --topic given', async () => {
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', 'no-topic-cortex', 'event', 'simple event']);

    const callArgs = mockClient.call.mock.calls[0][1] as Record<string, unknown>;
    expect(callArgs['topics']).toBeUndefined();
  });

  it('--silent suppresses all output (AC #4)', async () => {
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', 'silent-event-cortex', 'event', 'silent event', '--silent']);

    expect((console.log as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    expect(mockClient.call).toHaveBeenCalled();
  });

  it('local --cortex flag overrides global -C (AC #6)', async () => {
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const prog = makeProgram();
    await prog.parseAsync([
      'node', 'think', '-C', 'global-cortex',
      'event', 'override test',
      '--cortex', 'local-cortex',
    ]);

    const callArgs = mockClient.call.mock.calls[0][1] as Record<string, unknown>;
    expect(callArgs['cortex']).toBe('local-cortex');
  });

  it('forwards skipPush:true when --no-push is passed', async () => {
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', 'no-push-cortex', 'event', 'no-push event', '--no-push']);

    expect(mockClient.call).toHaveBeenCalledWith('sync', expect.objectContaining({
      skipPush: true,
    }));
  });

  it('exits 0 on success', async () => {
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', 'exit-code-cortex', 'event', 'successful event']);

    expect(process.exitCode).toBeFalsy();
  });
});

describe('think event -- L1 entry shape via daemon params (AC #3)', () => {
  withFreshThinkHome('think-event-l1-test-');

  it('daemon receives kind="event"; sync-handler stores compacted_from:null, supersedes:[] for event kind', async () => {
    // The L1 entry shape contract (compacted_from:null, supersedes:[]) is enforced
    // by the sync-handler (tested in tests/daemon/sync-handler.test.ts).
    // This test verifies the CLI end: that kind="event" is sent to the daemon so
    // the handler can uphold that contract.
    const mockClient = makeMockClient({ entry_id: 'l1-shape-id' });
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const cortex = 'l1-shape-cortex';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'event', 'testing L1 entry shape']);

    const callArgs = mockClient.call.mock.calls[0][1] as Record<string, unknown>;
    // kind="event" is the field that tells the sync-handler to set
    // compacted_from:null (permanently) and skip the supersession check.
    expect(callArgs['kind']).toBe('event');
    // The daemon never receives compacted_from or supersedes from the CLI --
    // those are handler-internal fields set on the L1 entry, not RPC params.
    expect(callArgs).not.toHaveProperty('compacted_from');
    expect(callArgs).not.toHaveProperty('supersedes');
  });

  it('fallback path (no daemon) stores content in v2 engrams table (kind field not preserved -- v2 schema limitation)', async () => {
    // The v2 engrams table predates the v3 kind system and has no kind column.
    // The fallback path writes the content to prevent data loss, but kind="event"
    // is not stored. This is documented behavior, not a bug.
    vi.spyOn(daemonClientModule, 'connectDaemon').mockRejectedValue(
      new DaemonUnavailableError('daemon failed to start; check ~/.think/daemon.log', '~/.think/daemon.log'),
    );

    const cortex = 'l1-fallback-cortex';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'event', 'fallback event for L1 shape test']);

    const db = getCortexDb(cortex);
    const row = db.prepare('SELECT id, content FROM engrams LIMIT 1').get() as {
      id: string;
      content: string;
    } | undefined;

    expect(row).toBeDefined();
    expect(row!.content).toBe('fallback event for L1 shape test');
    // kind column does not exist on the v2 engrams table -- this expectation
    // documents the known limitation of the fallback path.
    const cols = (db.prepare("PRAGMA table_info(engrams)").all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).not.toContain('kind');
  });
});

describe('think event -- degraded fallback when daemon unavailable (AC #7)', () => {
  withFreshThinkHome('think-event-fallback-test-');

  it('falls back to direct L2 write when connectDaemon rejects', async () => {
    vi.spyOn(daemonClientModule, 'connectDaemon').mockRejectedValue(
      new DaemonUnavailableError('daemon failed to start; check ~/.think/daemon.log', '~/.think/daemon.log'),
    );

    const cortex = 'event-fallback-test';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'event', 'fallback event content']);

    // Should still write to L2 via insertEngram (v2 degraded path)
    const db = getCortexDb(cortex);
    const row = db.prepare('SELECT COUNT(*) as count FROM engrams').get() as { count: number };
    expect(row.count).toBe(1);
  });

  it('shows "stored event" in output even when degraded', async () => {
    vi.spyOn(daemonClientModule, 'connectDaemon').mockRejectedValue(
      new DaemonUnavailableError('daemon failed to start; check ~/.think/daemon.log', '~/.think/daemon.log'),
    );

    const cortex = 'event-degraded-output-test';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'event', 'degraded event']);

    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toContain('stored event');
  });

  it('exits 0 even when degraded (write succeeded locally)', async () => {
    vi.spyOn(daemonClientModule, 'connectDaemon').mockRejectedValue(
      new DaemonUnavailableError('daemon failed to start; check ~/.think/daemon.log', '~/.think/daemon.log'),
    );

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', 'degraded-exit-cortex', 'event', 'fallback exit test']);

    expect(process.exitCode).toBeFalsy();
  });
});
