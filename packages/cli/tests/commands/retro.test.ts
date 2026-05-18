/**
 * Tests for `think retro` command — AGT-294
 *
 * Verifies:
 *  1. When daemon is available, calls daemonClient.call("sync", {..., kind: "retro"})
 *  2. Output is "✓ [cortex] stored retro <id>" with content excerpt
 *  3. --cortex flag overrides active cortex
 *  4. --topic flag (repeatable) is forwarded to daemon as topics array
 *  5. v2 subcommands (add / recall) no longer exist on this command
 *  6. L1 entry has kind: "retro" (verified via daemon mock params)
 *  7. Missing --cortex exits non-zero
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { retroCommand } from '../../src/commands/retro.js';
import * as daemonClientModule from '../../src/lib/daemon-client.js';
import { DaemonUnavailableError } from '../../src/lib/daemon-client.js';

/** Build a fresh program with a fresh retro command instance per test */
function makeProgram(): Command {
  const prog = new Command();
  prog.option('-C, --cortex <name>', 'Use a specific cortex for this command');
  prog.addCommand(retroCommand);
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

describe('think retro — daemon-routed path (AGT-294)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-retro-v3-test-'));
    process.env.THINK_HOME = tmpHome;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it('calls daemonClient.call("sync", { cortex, content, kind: "retro" }) (AC #1)', async () => {
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const cortex = 'retro-daemon-call-test';
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

  it('outputs "✓ [cortex] stored retro <id>" with content excerpt on success (AC #2)', async () => {
    const mockClient = makeMockClient({ entry_id: 'abc123def456' });
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const cortex = 'output-test';
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', cortex, 'retro', 'some observation']);

    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toContain('stored retro abc123def456');
    expect(output).toContain(cortex);
    expect(output).toContain('some observation');
  });

  it('--cortex flag overrides active cortex (AC #3)', async () => {
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'retro', 'overridden cortex obs', '--cortex', 'explicit-cortex']);

    expect(mockClient.call).toHaveBeenCalledWith('sync', expect.objectContaining({
      cortex: 'explicit-cortex',
    }));
  });

  it('--topic is forwarded as topics array to daemon (AC #4)', async () => {
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', 'topic-test', 'retro', 'topical obs', '--topic', 'ux', '--topic', 'perf']);

    expect(mockClient.call).toHaveBeenCalledWith('sync', expect.objectContaining({
      topics: ['ux', 'perf'],
    }));
  });

  it('does not include topics key when no --topic flags (clean params)', async () => {
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', 'no-topic-test', 'retro', 'observation without topics']);

    const callArgs = mockClient.call.mock.calls[0][1] as Record<string, unknown>;
    expect(callArgs).not.toHaveProperty('topics');
  });

  it('content "add" exits non-zero with migration message (AC #5 — no silent data corruption)', async () => {
    const connectSpy = vi.spyOn(daemonClientModule, 'connectDaemon');

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', 'add-guard-test', 'retro', 'add']);

    // Guard fires — daemon never called, exits non-zero
    expect(connectSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    const errOutput = (console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(errOutput).toContain('"add" is no longer a subcommand');
  });

  it('content "recall" exits non-zero with migration message (AC #5 — no silent data corruption)', async () => {
    const connectSpy = vi.spyOn(daemonClientModule, 'connectDaemon');

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', 'recall-guard-test', 'retro', 'recall']);

    // Guard fires — daemon never called, exits non-zero
    expect(connectSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    const errOutput = (console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(errOutput).toContain('"recall" is no longer a subcommand');
  });

  it('L1 entry has kind: "retro" (AC #7)', async () => {
    const mockClient = makeMockClient({ entry_id: 'kind-check-id' });
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', 'kind-check', 'retro', 'the observation']);

    const callArgs = mockClient.call.mock.calls[0][1] as Record<string, unknown>;
    expect(callArgs.kind).toBe('retro');
  });

  it('exits non-zero when --cortex is missing (AC #7)', async () => {
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'retro', 'missing cortex obs']);
    expect(process.exitCode).toBe(1);
  });

  it('does not fall back to active cortex from config — retros require explicit cortex', async () => {
    // Even if an active cortex is configured, retro requires explicit --cortex
    // (intentional design: retros scope to a specific tool, not working context)
    const { saveConfig, getConfig } = await import('../../src/lib/config.js');
    saveConfig({ ...getConfig(), cortex: { active: 'some-active-cortex' } });

    const connectSpy = vi.spyOn(daemonClientModule, 'connectDaemon');
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'retro', 'obs without explicit cortex']);

    // Should exit non-zero — no daemon call
    expect(connectSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('exits non-zero when daemon is unavailable', async () => {
    vi.spyOn(daemonClientModule, 'connectDaemon').mockRejectedValue(
      new DaemonUnavailableError('daemon failed to start', '/tmp/think/daemon.log'),
    );

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', 'unavail-test', 'retro', 'some obs']);

    expect(process.exitCode).toBe(1);
    const errOutput = (console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(errOutput).toContain('daemon unavailable');
  });

  it('surfaces advisory warnings from daemon', async () => {
    const mockClient = makeMockClient({
      entry_id: 'warn-id',
      warnings: ["kind 'retro' stored to L1 only; L2 schema extension pending"],
    });
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', 'warnings-test', 'retro', 'content with warnings']);

    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toContain('L2 schema extension pending');
  });

  it('-C global flag sets cortex', async () => {
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', '-C', 'global-cortex', 'retro', 'global flag test']);

    expect(mockClient.call).toHaveBeenCalledWith('sync', expect.objectContaining({
      cortex: 'global-cortex',
    }));
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
});
