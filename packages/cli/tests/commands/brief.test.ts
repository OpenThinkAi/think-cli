/**
 * Tests for think brief — iterative-learning v3 (retro locality).
 *
 * v3 model: BOTH sections read from the home cortex (active, or -C). The
 * repo-lessons section is retros scoped to the current repo CONTEXT via the
 * reserved repo:<context> topic (auto-detected from the git repo). Outside a
 * repo, the repo section shows all retros (no topic filter).
 *
 * detectWorkingContext is mocked per-test so assertions are deterministic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { briefCommand } from '../../src/commands/brief.js';
import * as daemonClientModule from '../../src/lib/daemon-client.js';
import { DaemonUnavailableError } from '../../src/lib/daemon-client.js';
import * as workingContext from '../../src/lib/working-context.js';
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

describe('think brief — v3 locality', () => {
  let originalHome: string | undefined;
  let tmpHome: string;
  const homeCortex = 'home-cortex';

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-brief-v3-test-'));
    process.env.THINK_HOME = tmpHome;
    writeConfig(tmpHome, homeCortex);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Deterministic context unless a test overrides it.
    vi.spyOn(workingContext, 'detectWorkingContext').mockReturnValue('stamp-cli');
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it('exits non-zero when no home cortex resolvable', async () => {
    writeConfig(tmpHome, '');
    await makeProgram().parseAsync(['node', 'think', 'brief']);
    expect(process.exitCode).toBe(1);
    const err = (console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ');
    expect(err).toMatch(/no home cortex/i);
  });

  it('degrades gracefully when daemon unavailable: warns + empty sections, exits 0', async () => {
    vi.spyOn(daemonClientModule, 'connectDaemon').mockRejectedValue(
      new DaemonUnavailableError('daemon failed to start', '/tmp/test-daemon.log'),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await makeProgram().parseAsync(['node', 'think', 'brief']);
    expect(process.exitCode).toBeFalsy();
    const warnOutput = (console.warn as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ');
    expect(warnOutput).toMatch(/daemon unavailable/i);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toContain('personal context');
    expect(output).toContain('repo lessons [stamp-cli]');
    expect(output).toContain('daemon offline');
  });

  it('calls recall twice, both on the home cortex; repo section is kind=retro + topic=repo:<context>', async () => {
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);
    await makeProgram().parseAsync(['node', 'think', 'brief']);

    expect(daemonClientModule.connectDaemon).toHaveBeenCalledOnce();
    expect(mockClient.call).toHaveBeenCalledTimes(2);

    const calls = mockClient.call.mock.calls;
    expect(calls[0][0]).toBe('recall');
    expect(calls[0][1]).toMatchObject({ cortex: homeCortex, scope: 'active' });
    expect((calls[0][1] as Record<string, unknown>)['kind']).toBeUndefined();

    expect(calls[1][0]).toBe('recall');
    expect(calls[1][1]).toMatchObject({ cortex: homeCortex, scope: 'active', kind: 'retro', topic: 'repo:stamp-cli' });

    expect(mockClient.close).toHaveBeenCalledOnce();
  });

  it('--context overrides the auto-detected context', async () => {
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);
    await makeProgram().parseAsync(['node', 'think', 'brief', '--context', 'Fx-Tracker']);
    const calls = mockClient.call.mock.calls;
    expect(calls[1][1]).toMatchObject({ topic: 'repo:fx-tracker' });
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toContain('repo lessons [fx-tracker]');
  });

  it('outside a git repo: no topic filter, all retros shown', async () => {
    vi.spyOn(workingContext, 'detectWorkingContext').mockReturnValue(null);
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);
    await makeProgram().parseAsync(['node', 'think', 'brief']);
    const calls = mockClient.call.mock.calls;
    expect((calls[1][1] as Record<string, unknown>)['topic']).toBeUndefined();
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toContain('repo lessons [all]');
  });

  it('renders both labelled sections in output', async () => {
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(makeMockClient());
    await makeProgram().parseAsync(['node', 'think', 'brief']);
    expect(process.exitCode).toBeFalsy();
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toContain('personal context');
    expect(output).toContain('repo lessons');
  });

  it('renders retro entries via the formatter in repo section', async () => {
    const retroEntry = entry({ id: 'r1', ts: '2026-05-01T12:00:00Z', kind: 'retro', content: 'always run build before commit', cortex: homeCortex });
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(makeMockClient([], [retroEntry]));
    await makeProgram().parseAsync(['node', 'think', 'brief']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toContain('always run build before commit');
    expect(output).toContain('retros (1)');
  });

  it('renders personal memory entries via the formatter', async () => {
    const memEntry = entry({ id: 'm1', ts: '2026-05-15T10:00:00Z', kind: 'memory', content: 'the daemon embedding model stays resident', cortex: homeCortex });
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(makeMockClient([memEntry], []));
    await makeProgram().parseAsync(['node', 'think', 'brief']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toContain('the daemon embedding model stays resident');
    expect(output).toContain('memories (1)');
  });

  it('prints note: when --days is passed (deprecated back-compat)', async () => {
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(makeMockClient());
    await makeProgram().parseAsync(['node', 'think', 'brief', '--days', '7']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toContain('note: --days is ignored');
  });

  it('does NOT print --days note when --days is not passed', async () => {
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(makeMockClient());
    await makeProgram().parseAsync(['node', 'think', 'brief']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).not.toContain('--days is');
  });

  it('forwards --limit to both recall calls', async () => {
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);
    await makeProgram().parseAsync(['node', 'think', 'brief', '--limit', '3']);
    const calls = mockClient.call.mock.calls;
    expect(calls[0][1]).toMatchObject({ limit: 3 });
    expect(calls[1][1]).toMatchObject({ limit: 3 });
  });

  it('shows note when home cortex has no entries', async () => {
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(makeMockClient([], []));
    await makeProgram().parseAsync(['node', 'think', 'brief']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toContain('no entries found in home cortex');
  });

  it('shows context-scoped note when no retros match the context', async () => {
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(makeMockClient([], []));
    await makeProgram().parseAsync(['node', 'think', 'brief']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toContain('no retros tagged repo:stamp-cli');
  });

  it('-C selects the home cortex to read from', async () => {
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);
    await makeProgram().parseAsync(['node', 'think', '-C', 'engineering', 'brief']);
    expect(process.exitCode).toBeFalsy();
    const calls = mockClient.call.mock.calls;
    expect(calls[0][1]).toMatchObject({ cortex: 'engineering' });
    expect(calls[1][1]).toMatchObject({ cortex: 'engineering', kind: 'retro' });
  });

  it('prints a deprecation note when a cortex is passed explicitly (-C/--cortex semantics changed)', async () => {
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(makeMockClient());
    await makeProgram().parseAsync(['node', 'think', '-C', 'engineering', 'brief']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).toContain('now selects the HOME cortex');
    expect(output).toContain('--context');
  });

  it('does NOT print the cortex deprecation note when no cortex flag is passed', async () => {
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(makeMockClient());
    await makeProgram().parseAsync(['node', 'think', 'brief']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(output).not.toContain('now selects the HOME cortex');
  });

  it('exits 0 on success', async () => {
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(makeMockClient());
    await makeProgram().parseAsync(['node', 'think', 'brief']);
    expect(process.exitCode).toBeFalsy();
  });

  it('forwards query argument to both recall calls', async () => {
    const mockClient = makeMockClient();
    vi.spyOn(daemonClientModule, 'connectDaemon').mockResolvedValue(mockClient);
    await makeProgram().parseAsync(['node', 'think', 'brief', 'my search query']);
    const calls = mockClient.call.mock.calls;
    expect(calls[0][1]).toMatchObject({ query: 'my search query' });
    expect(calls[1][1]).toMatchObject({ query: 'my search query' });
  });
});
