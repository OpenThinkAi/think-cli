/**
 * Tests for think brief command - AGT-322 (v3 recall semantics)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { briefCommand } from '../../src/commands/brief.js';
import * as daemonClientModule from '../../src/lib/daemon-client.js';
import { DaemonUnavailableError } from '../../src/lib/daemon-client.js';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
import type { RecallEntry } from '../../src/daemon/recall.js';
function makeProgram() {
  const prog = new Command();
  prog.option('-C, --cortex <name>', 'Use a specific cortex for this command');
  prog.addCommand(briefCommand);
  return prog;
}

function writeConfig(thinkHome: string, activeCortex: string): void {
  const configDir = join(thinkHome, 'config');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({ peerId: 'test-peer', syncPort: 19876, cortex: { active: activeCortex, author: 'tester' } }),
  );
}

function entry(
  overrides: Partial<RecallEntry> & Pick<RecallEntry, 'id' | 'ts' | 'kind' | 'content' | 'cortex'>
): RecallEntry {
  return { topics: [], similarity: 0.9, score: 0.9, ...overrides };
}

function makeMockClient(personalEntries: RecallEntry[] = [], repoEntries: RecallEntry[] = []) {
  return {
    call: vi.fn().mockImplementation((_method: string, params: Record<string, unknown>) => {
      if (params['kind'] === 'retro') return Promise.resolve(repoEntries);
      return Promise.resolve(personalEntries);
    }),
    close: vi.fn(),
  };
}
describe('think brief command - v3 daemon-based (AGT-322)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;
  const targetCortex = 'brief-repo-cortex';
  const personalCortex = 'brief-personal-cortex';

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-brief-v3-test-'));
    process.env.THINK_HOME = tmpHome;
    writeConfig(tmpHome, personalCortex);
    closeAllCortexDbs();
    getCortexDb(targetCortex);
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

  it('exits non-zero when --cortex is not provided (AC #1)', async () => {
    await makeProgram().parseAsync(['node', 'think', 'brief']);
    expect(process.exitCode).toBe(1);
  });
  it('degrades gracefully when daemon unavailable: warns + empty sections, exits 0', async () => {
    vi.spyOn(daemonClientModule, 'connectDaemon').mockRejectedValue(
      new DaemonUnavailableError('daemon failed to start', '/tmp/test-daemon.log'),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await makeProgram().parseAsync(['node', 'think', 'brief', '--cortex', targetCortex]);
    expect(process.exitCode).toBeFalsy();
    const warnOutput = (console.warn as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ');
    expect(warnOutput).toMatch(/daemon unavailable/i);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toContain('personal context');
    expect(output).toContain('repo lessons');
    expect(output).toContain('daemon offline');
  });

  it('calls recall twice: personal (all kinds) + repo (kind=retro) (AC #2)', async () => {
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);
    await makeProgram().parseAsync(['node', 'think', 'brief', '--cortex', targetCortex]);

    expect(daemonClientModule.connectDaemon).toHaveBeenCalledOnce();
    expect(mockClient.call).toHaveBeenCalledTimes(2);

    const calls = mockClient.call.mock.calls;
    expect(calls[0][0]).toBe('recall');
    expect(calls[0][1]).toMatchObject({ cortex: personalCortex, scope: 'active' });
    expect((calls[0][1] as Record<string, unknown>)['kind']).toBeUndefined();

    expect(calls[1][0]).toBe('recall');
    expect(calls[1][1]).toMatchObject({ cortex: targetCortex, scope: 'active', kind: 'retro' });

    expect(mockClient.close).toHaveBeenCalledOnce();
  });
  it('renders both labelled sections in output (AC #3)', async () => {
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(makeMockClient());
    await makeProgram().parseAsync(['node', 'think', 'brief', '--cortex', targetCortex]);
    expect(process.exitCode).toBeFalsy();
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toContain('personal context');
    expect(output).toContain('repo lessons');
  });

  it('renders retro entries via AGT-318 formatter in repo section (AC #3)', async () => {
    const retroEntry = entry({ id: 'r1', ts: '2026-05-01T12:00:00Z', kind: 'retro', content: 'always run build before commit', cortex: targetCortex });
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(makeMockClient([], [retroEntry]));
    await makeProgram().parseAsync(['node', 'think', 'brief', '--cortex', targetCortex]);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toContain('always run build before commit');
    expect(output).toContain('retros (1)');
  });

  it('renders personal memory entries via AGT-318 formatter (AC #3)', async () => {
    const memEntry = entry({ id: 'm1', ts: '2026-05-15T10:00:00Z', kind: 'memory', content: 'the daemon embedding model stays resident', cortex: personalCortex });
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(makeMockClient([memEntry], []));
    await makeProgram().parseAsync(['node', 'think', 'brief', '--cortex', targetCortex]);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toContain('the daemon embedding model stays resident');
    expect(output).toContain('memories (1)');
  });

  it('prints note: when --days is passed (deprecated back-compat, AC #4)', async () => {
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(makeMockClient());
    await makeProgram().parseAsync(['node', 'think', 'brief', '--cortex', targetCortex, '--days', '7']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toContain('note: --days is ignored');
  });

  it('does NOT print --days note when --days is not passed (AC #4)', async () => {
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(makeMockClient());
    await makeProgram().parseAsync(['node', 'think', 'brief', '--cortex', targetCortex]);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).not.toContain('--days is');
  });

  it('forwards --limit to both recall calls (AC #5)', async () => {
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);
    await makeProgram().parseAsync(['node', 'think', 'brief', '--cortex', targetCortex, '--limit', '3']);
    const calls = mockClient.call.mock.calls;
    expect(calls[0][1]).toMatchObject({ limit: 3 });
    expect(calls[1][1]).toMatchObject({ limit: 3 });
  });

  it('shows note when personal cortex has no entries', async () => {
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(makeMockClient([], []));
    await makeProgram().parseAsync(['node', 'think', 'brief', '--cortex', targetCortex]);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toContain('no entries found in personal cortex');
  });

  it('shows note when repo cortex has no retros', async () => {
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(makeMockClient([], []));
    await makeProgram().parseAsync(['node', 'think', 'brief', '--cortex', targetCortex]);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toContain('no retros found for cortex');
  });

  it('accepts -C as alias for --cortex (global flag)', async () => {
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);
    await makeProgram().parseAsync(['node', 'think', '-C', targetCortex, 'brief']);
    expect(process.exitCode).toBeFalsy();
    const calls = mockClient.call.mock.calls;
    expect(calls[1][1]).toMatchObject({ cortex: targetCortex, kind: 'retro' });
  });

  it('exits 0 on success', async () => {
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(makeMockClient());
    await makeProgram().parseAsync(['node', 'think', 'brief', '--cortex', targetCortex]);
    expect(process.exitCode).toBeFalsy();
  });

  it('forwards query argument to both recall calls', async () => {
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);
    await makeProgram().parseAsync(['node', 'think', 'brief', 'my search query', '--cortex', targetCortex]);
    const calls = mockClient.call.mock.calls;
    expect(calls[0][1]).toMatchObject({ query: 'my search query' });
    expect(calls[1][1]).toMatchObject({ query: 'my search query' });
  });

  it('exits 1 and prints error when no active cortex configured', async () => {
    writeConfig(tmpHome, '');
    await makeProgram().parseAsync(['node', 'think', 'brief', '--cortex', targetCortex]);
    expect(process.exitCode).toBe(1);
    const errOutput = (console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ');
    expect(errOutput).toMatch(/no active cortex/i);
  });

  it('shows diagnostic warning for unknown cortex (no DB file)', async () => {
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await makeProgram().parseAsync(['node', 'think', 'brief', '--cortex', 'no-such-cortex-xyz']);
    const warnOutput = (console.warn as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ');
    expect(warnOutput).toMatch(/no local cortex named/i);
    expect(mockClient.call).toHaveBeenCalledTimes(1);
  });
});
