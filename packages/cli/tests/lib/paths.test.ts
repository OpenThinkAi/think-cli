/**
 * Tests for maybeMigrateEngramsToIndex (lib/paths.ts) — alpha.5 engrams
 * consolidation rewrite.
 *
 * Covers:
 *   1. Both dirs exist + TTY  → consolidates and removes engrams/.
 *   2. Both dirs exist + no TTY → silent skip (no console output, no fs change).
 *   3. Conflicting cortex DB  → index/ copy preserved; engrams/ copy backed up.
 *   4. Only engrams/ exists   → auto-rename, no prompt.
 *   5. Only index/ exists     → no-op.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// Helper: produce a fresh tmp THINK_HOME for each test.
// ---------------------------------------------------------------------------

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'think-paths-test-'));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('maybeMigrateEngramsToIndex', () => {
  let originalHome: string | undefined;
  let thinkHome: string;
  let stderrOutput: string;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  // We need a fresh module for each test because maybeMigrateEngramsToIndex
  // has a module-level _migrationChecked flag.
  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    thinkHome = tmpHome();
    process.env.THINK_HOME = thinkHome;
    stderrOutput = '';
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrOutput += String(chunk);
      return true;
    });
    vi.resetModules();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(thinkHome, { recursive: true, force: true });
  });

  // ── helper: create dirs and stub fs.readSync to simulate Enter ────────────

  function seedBothDirs(files: { engrams: string[]; index: string[] } = { engrams: ['a.db'], index: [] }): { oldDir: string; newDir: string } {
    const oldDir = join(thinkHome, 'engrams');
    const newDir = join(thinkHome, 'index');
    mkdirSync(oldDir, { recursive: true });
    for (const f of files.engrams) writeFileSync(join(oldDir, f), 'data');
    mkdirSync(newDir, { recursive: true });
    for (const f of files.index) writeFileSync(join(newDir, f), 'index-data');
    return { oldDir, newDir };
  }

  // Stub fs.readSync(0, ...) to simulate the user pressing Enter (newline byte).
  function stubReadSyncEnter(): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(fs, 'readSync').mockImplementation(
      (fd, buf, offset, length, _position) => {
        if (fd === 0) {
          (buf as Buffer)[offset as number] = 10; // '\n'
          return 1;
        }
        // Delegate other fds to the real implementation (shouldn't be needed in tests).
        return fs.readSync(fd, buf as Buffer, offset as number, length as number, _position);
      }
    );
  }

  it('both dirs exist + TTY → consolidates engrams/ into index/ and removes engrams/', async () => {
    const { oldDir, newDir } = seedBothDirs({ engrams: ['cortex-a.db', 'cortex-b.db'], index: [] });
    const readSyncStub = stubReadSyncEnter();

    // Simulate a TTY stdin.
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    const { maybeMigrateEngramsToIndex } = await import('../../src/lib/paths.js');
    maybeMigrateEngramsToIndex();

    Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
    readSyncStub.mockRestore();

    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(join(newDir, 'cortex-a.db'))).toBe(true);
    expect(existsSync(join(newDir, 'cortex-b.db'))).toBe(true);
    expect(stderrOutput).toContain('consolidated');
  });

  it('both dirs exist + no TTY → silent skip (no fs change, no stderr output)', async () => {
    const { oldDir, newDir } = seedBothDirs({ engrams: ['cortex-a.db'], index: [] });

    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    const { maybeMigrateEngramsToIndex } = await import('../../src/lib/paths.js');
    maybeMigrateEngramsToIndex();

    Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });

    // Both dirs should still exist — nothing was moved.
    expect(existsSync(oldDir)).toBe(true);
    expect(existsSync(join(newDir, 'cortex-a.db'))).toBe(false);
    // No warning/error output.
    expect(stderrOutput).toBe('');
  });

  it('conflicting cortex DB → index/ copy preserved; engrams/ copy backed up', async () => {
    // cortex-shared.db exists in both; cortex-new.db only in engrams/.
    const { oldDir, newDir } = seedBothDirs({
      engrams: ['cortex-shared.db', 'cortex-new.db'],
      index: ['cortex-shared.db'],
    });
    const readSyncStub = stubReadSyncEnter();

    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    const { maybeMigrateEngramsToIndex } = await import('../../src/lib/paths.js');
    maybeMigrateEngramsToIndex();

    Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
    readSyncStub.mockRestore();

    // engrams/ should be removed.
    expect(existsSync(oldDir)).toBe(false);

    // index/cortex-shared.db should still have the original index content.
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(join(newDir, 'cortex-shared.db'), 'utf8')).toBe('index-data');

    // cortex-new.db should have been moved into index/.
    expect(existsSync(join(newDir, 'cortex-new.db'))).toBe(true);

    // The conflicting cortex-shared.db from engrams/ should be backed up.
    const parentDir = join(thinkHome);
    const backupDirs = readdirSync(parentDir).filter((d) => d.startsWith('engrams-backup-'));
    expect(backupDirs.length).toBe(1);
    expect(existsSync(join(parentDir, backupDirs[0], 'cortex-shared.db'))).toBe(true);

    // The confirmation message should mention the backup count and backup dir path.
    expect(stderrOutput).toContain('backed up 1 conflicting database(s)');
    expect(stderrOutput).toContain(backupDirs[0]);
  });

  it('only engrams/ exists → auto-rename to index/ with no prompt', async () => {
    const oldDir = join(thinkHome, 'engrams');
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(oldDir, 'cortex.db'), 'data');

    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    const { maybeMigrateEngramsToIndex } = await import('../../src/lib/paths.js');
    maybeMigrateEngramsToIndex();

    Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });

    const newDir = join(thinkHome, 'index');
    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(join(newDir, 'cortex.db'))).toBe(true);
    expect(stderrOutput).toContain('migrated');
    // Must not include 'Warning' (the old noisy message).
    expect(stderrOutput).not.toContain('Warning');
  });

  it('only index/ exists → complete no-op', async () => {
    const newDir = join(thinkHome, 'index');
    mkdirSync(newDir, { recursive: true });
    writeFileSync(join(newDir, 'cortex.db'), 'data');

    const { maybeMigrateEngramsToIndex } = await import('../../src/lib/paths.js');
    maybeMigrateEngramsToIndex();

    expect(existsSync(newDir)).toBe(true);
    expect(stderrOutput).toBe('');
  });
});
