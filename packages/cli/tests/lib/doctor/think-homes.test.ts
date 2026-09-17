/**
 * Unit tests for checkThinkHomes() — AGT-1308 AC1.
 *
 * `homeDir` and `activeThinkDir` are injected in every test, so the scan runs
 * over a temp fixture and never enumerates the developer's real home (where
 * `~/.think-personal` and `~/.think-work` both exist and are evidence a later
 * ticket must observe unchanged).
 *
 * The invariant this suite exists to hold: multiple homes NEVER fail.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkThinkHomes,
  discoverThinkHomes,
  THINK_HOMES_CHECK_ID,
} from '../../../src/lib/doctor/think-homes.js';

describe('checkThinkHomes (AGT-1308)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'think-doctor-homes-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function makeHome(name: string, opts: { withRepo?: boolean } = {}): string {
    const dir = join(home, name);
    mkdirSync(dir, { recursive: true });
    if (opts.withRepo) mkdirSync(join(dir, 'repo', '.git'), { recursive: true });
    return dir;
  }

  it('passes with a single home', () => {
    const only = makeHome('.think', { withRepo: true });

    expect(checkThinkHomes({ homeDir: home, activeThinkDir: only })).toEqual({
      id: THINK_HOMES_CHECK_ID,
      status: 'pass',
      detail: `One think home: ${only}.`,
      fixable: false,
    });
  });

  it('warns — never fails — when several homes are present', () => {
    makeHome('.think', { withRepo: false });
    const personal = makeHome('.think-personal', { withRepo: true });
    makeHome('.think-work', { withRepo: true });

    const result = checkThinkHomes({ homeDir: home, activeThinkDir: personal });

    expect(result.status).toBe('warn');
    expect(result.fixable).toBe(false);
    expect(result.detail).toContain('3 think homes');
    expect(result.detail).toContain('no cortex repo');
    expect(result.detail).toContain('active');
  });

  it('marks which home the current process is using, and whether each has a cortex repo', () => {
    makeHome('.think', { withRepo: false });
    const work = makeHome('.think-work', { withRepo: true });

    const homes = discoverThinkHomes({ homeDir: home, activeThinkDir: work });

    expect(homes).toEqual([
      { dirPath: join(home, '.think'), hasCortexRepo: false, active: false },
      { dirPath: work, hasCortexRepo: true, active: true },
    ]);
  });

  it('includes an active THINK_HOME that sits outside the home directory', () => {
    makeHome('.think');
    const elsewhere = mkdtempSync(join(tmpdir(), 'think-doctor-elsewhere-'));
    try {
      const homes = discoverThinkHomes({ homeDir: home, activeThinkDir: elsewhere });
      expect(homes.map((h) => h.dirPath).sort()).toEqual([join(home, '.think'), elsewhere].sort());
      expect(homes.find((h) => h.dirPath === elsewhere)?.active).toBe(true);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('ignores files and symlinks that happen to be named like a home', () => {
    const real = makeHome('.think', { withRepo: true });
    writeFileSync(join(home, '.think-notes'), 'not a directory', 'utf-8');
    symlinkSync(real, join(home, '.think-link'));

    const homes = discoverThinkHomes({ homeDir: home, activeThinkDir: real });

    expect(homes.map((h) => h.dirPath)).toEqual([real]);
  });

  it('reports nothing rather than throwing when the home directory cannot be read', () => {
    const missing = join(home, 'gone');

    const result = checkThinkHomes({ homeDir: missing, activeThinkDir: join(missing, '.think') });

    // The active home is still reported — the scan found nothing, which is not
    // the same as there being no home at all.
    expect(result.status).toBe('pass');
    expect(result.detail).toContain(join(missing, '.think'));
  });
});
