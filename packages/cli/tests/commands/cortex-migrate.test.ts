import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { cortexCommand } from '../../src/commands/cortex.js';
import { createTestCortex, type TestCortex } from '../fixtures/cortex.js';
import { saveConfig, getConfig, getPeerId } from '../../src/lib/config.js';
import { insertMemory } from '../../src/db/memory-queries.js';
import { deterministicId } from '../../src/lib/deterministic-id.js';

describe('think cortex migrate --to fs --path', () => {
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

  it('exports SQLite memories to <path>/<cortex>/<peer>-0001.jsonl and rewrites config to fs', async () => {
    cortex = createTestCortex();
    fsRoot = mkdtempSync(path.join(tmpdir(), 'think-fs-migrate-target-'));
    // Use a fresh subdir as the target — the migrate command refuses to
    // export into a folder that already has subdirectories.
    const target = path.join(fsRoot, 'cortex-root');

    // Configure a `repo` source so the migrate command sees a backend to
    // migrate from. We point at a bogus file:// URL — the pull-from-source
    // step will fail-soft and the migrate continues with the SQLite data
    // we've already inserted.
    const baseConfig = getConfig();
    saveConfig({
      ...baseConfig,
      cortex: {
        author: 'test',
        active: cortex.name,
        repo: '/nonexistent/source.git',
      },
    });

    insertMemory(cortex.name, {
      id: deterministicId('2026-04-29T12:00:00Z', 'a', 'pre-migration'),
      ts: '2026-04-29T12:00:00Z',
      author: 'a',
      content: 'pre-migration',
    });

    // Suppress process.exit so commander errors fail the test rather than
    // killing the worker.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    // Quiet the noisy yellow "pull failed" line so test output stays clean.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await cortexCommand.parseAsync(
      ['migrate', '--to', 'fs', '--path', target],
      { from: 'user' },
    );

    expect(exitSpy).not.toHaveBeenCalled();

    // Config now points at the fs backend; repo cleared symmetrically.
    const after = getConfig();
    expect(after.cortex?.fs?.path).toBe(target);
    expect(after.cortex?.repo).toBeUndefined();
    expect(after.cortex?.server).toBeUndefined();

    // Memory landed in the expected per-peer bucket file.
    const peerId = getPeerId();
    const bucketPath = path.join(target, cortex.name, `${peerId}-0001.jsonl`);
    expect(fs.existsSync(bucketPath)).toBe(true);
    const lines = readFileSync(bucketPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as { content: string; origin_peer_id: string };
    expect(parsed.content).toBe('pre-migration');
    expect(parsed.origin_peer_id).toBe(peerId);
  });

  it('refuses to migrate into a folder that already has subdirectories', async () => {
    cortex = createTestCortex();
    fsRoot = mkdtempSync(path.join(tmpdir(), 'think-fs-migrate-busy-'));
    fs.mkdirSync(path.join(fsRoot, 'preexisting-cortex'));

    const baseConfig = getConfig();
    saveConfig({
      ...baseConfig,
      cortex: {
        author: 'test',
        active: cortex.name,
        repo: '/nonexistent/source.git',
      },
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      cortexCommand.parseAsync(
        ['migrate', '--to', 'fs', '--path', fsRoot],
        { from: 'user' },
      ),
    ).rejects.toThrow(/process\.exit\(1\)/);

    expect(exitSpy).toHaveBeenCalledWith(1);
    // Config still points at the original backend.
    const after = getConfig();
    expect(after.cortex?.repo).toBe('/nonexistent/source.git');
    expect(after.cortex?.fs).toBeUndefined();
  });
});
