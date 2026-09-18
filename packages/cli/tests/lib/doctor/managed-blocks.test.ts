/**
 * Unit tests for checkManagedBlocks() — AGT-1308 AC1/AC4/AC5.
 *
 * The first group injects a fake refresher to pin the status mapping. The
 * last group drives the REAL AGT-1306 refresher against a temp registry and
 * temp files, which is what proves the two guarantees that matter: the report
 * is computed by the code `--fix` runs, and computing it writes nothing.
 *
 * THINK_HOME is already repointed into a temp directory by the suite-wide
 * isolation (tests/setup/home-isolation.ts), so the registry file this writes
 * is the isolated one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkManagedBlocks,
  MANAGED_BLOCKS_CHECK_ID,
} from '../../../src/lib/doctor/managed-blocks.js';
import { recordBlockWrite } from '../../../src/lib/block-registry.js';
import { buildBlock, upsertBlock, WORKLOG_UPSERT } from '../../../src/commands/init.js';

describe('checkManagedBlocks (AGT-1308)', () => {
  it('passes when a dry-run refresh would rewrite nothing', () => {
    const result = checkManagedBlocks({
      refresh: () => ({ refreshed: [], failures: [] }),
    });

    expect(result).toEqual({
      id: MANAGED_BLOCKS_CHECK_ID,
      status: 'pass',
      detail: 'Every registered managed block matches the installed template.',
      fixable: false,
    });
  });

  it('warns, fixable, and names each block a refresh would rewrite', () => {
    const result = checkManagedBlocks({
      refresh: () => ({ refreshed: ['/tmp/a/CLAUDE.md', '/tmp/b/AGENTS.md'], failures: [] }),
    });

    expect(result.status).toBe('warn');
    expect(result.fixable).toBe(true);
    expect(result.detail).toContain('2 managed blocks out of date');
    expect(result.detail).toContain('/tmp/a/CLAUDE.md');
    expect(result.detail).toContain('/tmp/b/AGENTS.md');
  });

  it('reports an entry it could not evaluate as an unfixable warn', () => {
    // `--fix` would hit exactly the same wall, so offering it would be a lie.
    const result = checkManagedBlocks({
      refresh: () => ({
        refreshed: [],
        failures: [{ path: '/tmp/c/CLAUDE.md', kind: 'retro', reason: 'EACCES' }],
      }),
    });

    expect(result.status).toBe('warn');
    expect(result.fixable).toBe(false);
    expect(result.detail).toContain('/tmp/c/CLAUDE.md');
    expect(result.detail).toContain('EACCES');
  });

  it('mentions still-stale blocks alongside an unevaluable one', () => {
    const result = checkManagedBlocks({
      refresh: () => ({
        refreshed: ['/tmp/a/CLAUDE.md'],
        failures: [{ path: '/tmp/c/CLAUDE.md', kind: 'work-log', reason: 'EACCES' }],
      }),
    });

    expect(result.detail).toContain('1 other registered block also out of date');
  });

  it('asks for a dry run', () => {
    const seen: Array<{ dryRun?: boolean }> = [];
    checkManagedBlocks({
      refresh: (options) => {
        seen.push(options);
        return { refreshed: [], failures: [] };
      },
    });
    expect(seen).toEqual([{ dryRun: true }]);
  });

  describe('against the real AGT-1306 refresher', () => {
    let dir: string;
    let file: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'think-doctor-blocks-'));
      file = join(dir, 'CLAUDE.md');
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('passes for a file already carrying the current template', () => {
      upsertBlock(file, buildBlock(false), WORKLOG_UPSERT);
      recordBlockWrite(file, 'work-log', WORKLOG_UPSERT.beginMarker, WORKLOG_UPSERT.endMarker);

      expect(checkManagedBlocks().status).toBe('pass');
    });

    it('AC5: reports a stale block without writing to the file', () => {
      // A registered file whose block body is stale: same markers, old text.
      writeFileSync(
        file,
        `${WORKLOG_UPSERT.beginMarker}\nold body from a previous template\n${WORKLOG_UPSERT.endMarker}\n`,
        'utf-8',
      );
      recordBlockWrite(file, 'work-log', WORKLOG_UPSERT.beginMarker, WORKLOG_UPSERT.endMarker);

      const before = readFileSync(file, 'utf-8');
      const beforeMtime = statSync(file).mtimeMs;

      const result = checkManagedBlocks();

      expect(result.status).toBe('warn');
      expect(result.fixable).toBe(true);
      expect(result.detail).toContain(file);
      expect(readFileSync(file, 'utf-8')).toBe(before);
      expect(statSync(file).mtimeMs).toBe(beforeMtime);
    });
  });
});
