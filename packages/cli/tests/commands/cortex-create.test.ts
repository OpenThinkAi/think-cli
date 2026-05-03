import { describe, it, expect, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { cortexCommand } from '../../src/commands/cortex.js';
import { createTestCortex, type TestCortex } from '../fixtures/cortex.js';
import { saveConfig, getConfig } from '../../src/lib/config.js';
import { GitSyncAdapter } from '../../src/sync/git-adapter.js';

describe('think cortex create — first-run wording', () => {
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

  it('says "(local + folder)" when an fs backend is configured', async () => {
    cortex = createTestCortex();
    fsRoot = mkdtempSync(path.join(tmpdir(), 'think-fs-create-folder-'));

    const baseConfig = getConfig();
    saveConfig({
      ...baseConfig,
      cortex: {
        author: 'test',
        fs: { path: fsRoot },
      },
    });

    const lines = captureLogs();
    await cortexCommand.parseAsync(['create', 'second-cortex'], { from: 'user' });

    const created = lines.find(l => l.includes('Created cortex'));
    expect(created).toBeDefined();
    expect(created).toContain('(local + folder)');
    expect(created).not.toContain('(local + remote)');
    // Side effect: the fs backend's createCortex mkdirs the cortex folder.
    expect(fs.existsSync(path.join(fsRoot, 'second-cortex'))).toBe(true);
  });

  it('still says "(local + remote)" when a git backend is configured (no regression)', async () => {
    cortex = createTestCortex();

    const baseConfig = getConfig();
    saveConfig({
      ...baseConfig,
      cortex: {
        author: 'test',
        repo: 'git@example.invalid:org/cortex.git',
      },
    });

    // Stand in for the real git op (clone + branch) so we exercise the
    // success-branch wording without needing a reachable remote.
    vi.spyOn(GitSyncAdapter.prototype, 'createCortex').mockResolvedValue();

    const lines = captureLogs();
    await cortexCommand.parseAsync(['create', 'gitty'], { from: 'user' });

    const created = lines.find(l => l.includes('Created cortex'));
    expect(created).toBeDefined();
    expect(created).toContain('(local + remote)');
    expect(created).not.toContain('(local + folder)');
  });

  it('says "(local only)" when no sync adapter is configured', async () => {
    cortex = createTestCortex();

    const baseConfig = getConfig();
    saveConfig({
      ...baseConfig,
      cortex: {
        author: 'test',
      },
    });

    const lines = captureLogs();
    await cortexCommand.parseAsync(['create', 'lonely'], { from: 'user' });

    const created = lines.find(l => l.includes('Created cortex'));
    expect(created).toBeDefined();
    expect(created).toContain('(local only)');
  });
});
