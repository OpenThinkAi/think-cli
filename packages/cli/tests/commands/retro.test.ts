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
import { retroCommand } from '../../src/commands/retro.js';
import * as daemonClientModule from '../../src/lib/daemon-client.js';
import { DaemonUnavailableError } from '../../src/lib/daemon-client.js';
import * as workingContext from '../../src/lib/working-context.js';

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

describe('think retro — v3 locality', () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-retro-v3-test-'));
    process.env.THINK_HOME = tmpHome;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Default: behave as if run outside a git repo so topic assertions are
    // deterministic. Tests that exercise auto-detection override this.
    vi.spyOn(workingContext, 'detectWorkingContext').mockReturnValue(null);
  });

  afterEach(() => {
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
});
