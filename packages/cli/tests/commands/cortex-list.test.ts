import { describe, it, expect, afterEach, vi } from 'vitest';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { cortexCommand } from '../../src/commands/cortex.js';
import { createTestCortex, type TestCortex } from '../fixtures/cortex.js';
import { saveConfig, getConfig } from '../../src/lib/config.js';
import { GitSyncAdapter } from '../../src/sync/git-adapter.js';
import { LocalFsSyncAdapter } from '../../src/sync/local-fs-adapter.js';

describe('think cortex list — backend-aware framing for "remote-only" cortexes', () => {
  let cortex: TestCortex | null = null;
  let fsRoot: string | null = null;

  afterEach(() => {
    cortex?.cleanup();
    cortex = null;
    if (fsRoot) {
      rmSync(fsRoot, { recursive: true, force: true });
      fsRoot = null;
    }
    vi.restoreAllMocks();
  });

  function captureLogs(): string[] {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    return lines;
  }

  it('shows "Folder only (in <path>, ...)" header when fs is the backend', async () => {
    cortex = createTestCortex();
    fsRoot = mkdtempSync(path.join(tmpdir(), 'think-fs-list-folder-'));

    const baseConfig = getConfig();
    saveConfig({
      ...baseConfig,
      cortex: {
        author: 'test',
        active: cortex.name,
        fs: { path: fsRoot },
      },
    });

    // The local cortex created by createTestCortex() is `cortex.name`; pretend
    // the folder also has a sibling cortex that the user hasn't pulled locally.
    vi.spyOn(LocalFsSyncAdapter.prototype, 'listRemoteCortexes').mockResolvedValue([
      cortex.name,
      'product',
    ]);

    const lines = captureLogs();
    await cortexCommand.parseAsync(['list'], { from: 'user' });

    const header = lines.find(l => l.includes('only'));
    expect(header).toBeDefined();
    expect(header).toContain('Folder only');
    expect(header).toContain(fsRoot);
    expect(header).toContain('run think cortex pull to sync');
    expect(header).not.toContain('Remote only');
  });

  it('still shows "Remote only (run think cortex pull to sync):" when git is the backend (no regression)', async () => {
    cortex = createTestCortex();

    const baseConfig = getConfig();
    saveConfig({
      ...baseConfig,
      cortex: {
        author: 'test',
        active: cortex.name,
        repo: 'git@example.invalid:org/cortex.git',
      },
    });

    vi.spyOn(GitSyncAdapter.prototype, 'listRemoteCortexes').mockResolvedValue([
      cortex.name,
      'product',
    ]);

    const lines = captureLogs();
    await cortexCommand.parseAsync(['list'], { from: 'user' });

    const header = lines.find(l => l.includes('only'));
    expect(header).toBeDefined();
    expect(header).toContain('Remote only (run think cortex pull to sync):');
    expect(header).not.toContain('Folder only');
  });

  it('omits the "only" subsection entirely when nothing is remote-only', async () => {
    cortex = createTestCortex();
    fsRoot = mkdtempSync(path.join(tmpdir(), 'think-fs-list-empty-'));

    const baseConfig = getConfig();
    saveConfig({
      ...baseConfig,
      cortex: {
        author: 'test',
        active: cortex.name,
        fs: { path: fsRoot },
      },
    });

    // Backend reports only the local cortex — no remote-only entries.
    vi.spyOn(LocalFsSyncAdapter.prototype, 'listRemoteCortexes').mockResolvedValue([
      cortex.name,
    ]);

    const lines = captureLogs();
    await cortexCommand.parseAsync(['list'], { from: 'user' });

    expect(lines.some(l => l.includes('only'))).toBe(false);
  });
});
