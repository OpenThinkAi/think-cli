/**
 * Tests for lib/block-refresh.ts (AGT-1306) — refreshing every AGT-1305
 * registered managed block from the current template after `think update`.
 *
 * `refreshRegisteredBlocks` is exercised end to end through `think init`
 * (to populate the registry realistically) plus direct file tampering (to
 * simulate a stale block written by an older template). `refreshBlocksViaBin`
 * uses the same exec-seam strategy as daemon-drift.test.ts's
 * `restartDaemonViaBin` tests — no process is actually spawned.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  statSync,
  chmodSync,
} from 'node:fs';
import { initCommand } from '../../src/commands/init.js';
import { listRegisteredBlocks } from '../../src/lib/block-registry.js';
import {
  refreshRegisteredBlocks,
  refreshBlocksViaBin,
} from '../../src/lib/block-refresh.js';

describe('refreshRegisteredBlocks', () => {
  let homeRoot: string;
  let projectDir: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    homeRoot = mkdtempSync(path.join(tmpdir(), 'think-block-refresh-home-'));
    projectDir = mkdtempSync(path.join(tmpdir(), 'think-block-refresh-project-'));
    prevHome = process.env.HOME;
    process.env.HOME = homeRoot;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(homeRoot, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    vi.restoreAllMocks();
  });

  it('rewrites a stale work-log block and reports the path as refreshed', async () => {
    await initCommand.parseAsync(['--dir', projectDir, '--yes'], { from: 'user' });
    const claudePath = path.join(projectDir, 'CLAUDE.md');

    // Simulate an older template's wording having been written to disk.
    const original = readFileSync(claudePath, 'utf-8');
    const staled = original.replace('# Work Logging', '# Work Logging (old wording)');
    writeFileSync(claudePath, staled, 'utf-8');

    const result = refreshRegisteredBlocks();

    expect(result.refreshed).toEqual([claudePath]);
    expect(result.failures).toEqual([]);
    const rewritten = readFileSync(claudePath, 'utf-8');
    expect(rewritten).not.toContain('(old wording)');
    expect(rewritten).toBe(original); // rebuilt to exactly today's template
  });

  it('leaves an already-current file untouched — mtime does not change (AC1)', async () => {
    await initCommand.parseAsync(['--dir', projectDir, '--yes'], { from: 'user' });
    const claudePath = path.join(projectDir, 'CLAUDE.md');
    const mtimeBefore = statSync(claudePath).mtimeMs;

    // Ensure a refresh that *did* touch the file would be observable: mtime
    // resolution can be coarse on some filesystems, so nudge the clock back
    // artificially far enough that any real write would be detectable.
    await new Promise((r) => setTimeout(r, 10));

    const result = refreshRegisteredBlocks();

    expect(result.refreshed).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(statSync(claudePath).mtimeMs).toBe(mtimeBefore);
  });

  it('rebuilds a stale retro block using the cortex derived from its existing text', async () => {
    await initCommand.parseAsync(
      ['--dir', projectDir, '--retro', '--cortex', 'fx-tracker'],
      { from: 'user' },
    );
    const claudePath = path.join(projectDir, 'CLAUDE.md');
    const original = readFileSync(claudePath, 'utf-8');

    const staled = original.replace('Iterative Learning', 'Iterative Learning (old wording)');
    writeFileSync(claudePath, staled, 'utf-8');

    const result = refreshRegisteredBlocks();

    expect(result.refreshed).toEqual([claudePath]);
    expect(result.failures).toEqual([]);
    const rewritten = readFileSync(claudePath, 'utf-8');
    expect(rewritten).toContain('think brief --context fx-tracker');
    expect(rewritten).toContain('think retro "<observation>" --context fx-tracker');
    expect(rewritten).not.toContain('(old wording)');
  });

  it('reports a per-file failure without throwing or failing the other entries', async () => {
    await initCommand.parseAsync(['--dir', projectDir, '--yes'], { from: 'user' });
    const claudePath = path.join(projectDir, 'CLAUDE.md');

    // A second, independently-registered file that stays healthy throughout.
    const otherDir = mkdtempSync(path.join(tmpdir(), 'think-block-refresh-other-'));
    try {
      await initCommand.parseAsync(['--dir', otherDir, '--yes'], { from: 'user' });
      const otherPath = path.join(otherDir, 'CLAUDE.md');
      writeFileSync(
        otherPath,
        readFileSync(otherPath, 'utf-8').replace('# Work Logging', '# Work Logging (old wording)'),
        'utf-8',
      );

      // Break the first file's file permissions so writing to it fails.
      // (upsertBlock's writeFileSync will throw EACCES.)
      writeFileSync(
        claudePath,
        readFileSync(claudePath, 'utf-8').replace('# Work Logging', '# Work Logging (old wording)'),
        'utf-8',
      );
      chmodSync(claudePath, 0o444);

      const result = refreshRegisteredBlocks();

      expect(result.refreshed).toEqual([otherPath]);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].path).toBe(claudePath);
      expect(result.failures[0].kind).toBe('work-log');
      expect(result.failures[0].reason).toBeTruthy();
    } finally {
      chmodSync(claudePath, 0o644);
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('skips and reports a retro entry whose cortex cannot be derived from the existing text', async () => {
    await initCommand.parseAsync(
      ['--dir', projectDir, '--retro', '--cortex', 'fx-tracker'],
      { from: 'user' },
    );
    const claudePath = path.join(projectDir, 'CLAUDE.md');

    // Hand-edit away the only line that names the cortex, without touching
    // the markers themselves — the entry stays registered (markers intact)
    // but nothing in the body identifies which cortex to rebuild against.
    const original = readFileSync(claudePath, 'utf-8');
    const withoutCortexMention = original.replace(/think brief --context \S+/g, 'think brief');
    writeFileSync(claudePath, withoutCortexMention, 'utf-8');

    const result = refreshRegisteredBlocks();

    expect(result.refreshed).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].path).toBe(claudePath);
    expect(result.failures[0].kind).toBe('retro');
    expect(result.failures[0].reason).toMatch(/cortex/i);
    // Untouched — never guessed a cortex to fabricate a rewrite.
    expect(readFileSync(claudePath, 'utf-8')).toBe(withoutCortexMention);
  });

  it('does nothing and returns an empty result when the registry is empty', () => {
    expect(listRegisteredBlocks()).toEqual([]);
    expect(refreshRegisteredBlocks()).toEqual({ refreshed: [], failures: [] });
  });
});

describe('refreshBlocksViaBin', () => {
  it('invokes the new install\'s entry point with the refresh-blocks-internal subcommand', () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const result = refreshBlocksViaBin('/npm/root/@openthink/think', (file, args) => {
      calls.push({ file, args });
      return JSON.stringify({ refreshed: ['/a/CLAUDE.md'], failures: [] });
    });

    expect(calls).toHaveLength(1);
    const bin = path.join('/npm/root/@openthink/think', 'dist', 'index.js');
    expect(calls[0]).toEqual({ file: process.execPath, args: [bin, 'refresh-blocks-internal'] });
    expect(result).toEqual({ ok: true, refreshed: ['/a/CLAUDE.md'], failures: [] });
  });

  it('reports ok=false with an error when the spawn throws', () => {
    const result = refreshBlocksViaBin('/npm/root/@openthink/think', () => {
      throw new Error('spawn failed');
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('spawn failed');
    expect(result.refreshed).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it('reports ok=false with an error when stdout is not valid JSON', () => {
    const result = refreshBlocksViaBin('/npm/root/@openthink/think', () => 'not json');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
