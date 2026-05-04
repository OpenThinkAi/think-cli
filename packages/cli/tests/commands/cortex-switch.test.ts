import { describe, it, expect, afterEach, vi } from 'vitest';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { cortexCommand } from '../../src/commands/cortex.js';
import { createTestCortex, type TestCortex } from '../fixtures/cortex.js';
import { saveConfig, getConfig } from '../../src/lib/config.js';
import { GitSyncAdapter } from '../../src/sync/git-adapter.js';
import { LocalFsSyncAdapter } from '../../src/sync/local-fs-adapter.js';

describe('think cortex switch — backend-aware "exists but not local" hint', () => {
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

  function captureLogs(): { logs: string[]; warns: string[] } {
    const logs: string[] = [];
    const warns: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      warns.push(args.map(String).join(' '));
    });
    return { logs, warns };
  }

  it('says "exists in <path>" + "sync from the folder" when fs is the backend', async () => {
    cortex = createTestCortex();
    fsRoot = mkdtempSync(path.join(tmpdir(), 'think-fs-switch-folder-'));

    const baseConfig = getConfig();
    saveConfig({
      ...baseConfig,
      cortex: {
        author: 'test',
        active: cortex.name,
        fs: { path: fsRoot },
      },
    });

    // Pretend `product` exists in the folder but not in the local DB.
    vi.spyOn(LocalFsSyncAdapter.prototype, 'listRemoteCortexes').mockResolvedValue([
      cortex.name,
      'product',
    ]);

    const { logs } = captureLogs();
    await cortexCommand.parseAsync(['switch', 'product'], { from: 'user' });

    const exists = logs.find(l => l.includes('exists'));
    const hint = logs.find(l => l.includes('Run: think cortex pull'));

    expect(exists).toBeDefined();
    expect(exists).toContain(`exists in ${fsRoot}`);
    expect(exists).not.toContain('exists remotely');
    expect(exists).not.toContain('exists in folder ');

    expect(hint).toBeDefined();
    expect(hint).toContain('to sync from the folder');
    expect(hint).not.toContain('to sync from remote');
  });

  it('still says "exists remotely" + "sync from remote" when git is the backend (no regression)', async () => {
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

    const { logs } = captureLogs();
    await cortexCommand.parseAsync(['switch', 'product'], { from: 'user' });

    const exists = logs.find(l => l.includes('exists'));
    const hint = logs.find(l => l.includes('Run: think cortex pull'));

    expect(exists).toBeDefined();
    expect(exists).toContain('exists remotely but not locally');

    expect(hint).toBeDefined();
    expect(hint).toContain('(to sync from remote)');
  });
});
