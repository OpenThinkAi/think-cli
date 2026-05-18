/**
 * Tests for AGT-319: think recall --full, --json, --limit flags.
 *
 * All tests run against the FTS path (no daemon). Verifies:
 *  1. --json emits valid JSON array to stdout with stable null fields
 *  2. --limit 3 returns at most 3 entries
 *  3. --limit foo exits with a clear error
 *  4. --limit 0 exits with a clear error
 *  5. --json --full compose correctly
 *  6. --full returns entries including compacted raws in FTS mode
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { recallCommand } from '../../src/commands/recall.js';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
import { insertMemory } from '../../src/db/memory-queries.js';

const CORTEX = 'recall-flags-test';

function makeProgram(): Command {
  const prog = new Command().exitOverride();
  prog.addCommand(recallCommand);
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

describe('think recall flags (AGT-319)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-agt319-'));
    process.env.THINK_HOME = tmpHome;
    closeAllCortexDbs();
    writeConfig(tmpHome, CORTEX);
    getCortexDb(CORTEX);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    closeAllCortexDbs();
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it('--json emits a valid JSON array to stdout', async () => {
    insertMemory(CORTEX, { ts: '2026-05-01T00:00:00.000Z', author: 'tester', content: 'json output test memory' });
    closeAllCortexDbs();

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'recall', '--json', 'json output test']);

    expect(stdoutWriteSpy).toHaveBeenCalled();
    const written = stdoutWriteSpy.mock.calls.flat().join('');
    const parsed = JSON.parse(written.trim());
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('--json entries have all required fields with stable null values', async () => {
    insertMemory(CORTEX, { ts: '2026-05-01T00:00:00.000Z', author: 'tester', content: 'stable schema memory' });
    closeAllCortexDbs();

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'recall', '--json', 'stable schema']);

    const written = stdoutWriteSpy.mock.calls.flat().join('');
    const parsed = JSON.parse(written.trim()) as Record<string, unknown>[];
    expect(parsed.length).toBeGreaterThan(0);
    const entry = parsed[0];
    expect(entry).toHaveProperty('id');
    expect(entry).toHaveProperty('ts');
    expect(entry).toHaveProperty('cortex', CORTEX);
    expect(entry).toHaveProperty('kind');
    expect(entry).toHaveProperty('content');
    expect(entry).toHaveProperty('topics');
    expect(entry).toHaveProperty('supersedes', null);
    expect(entry).toHaveProperty('compacted_from', null);
    expect(entry).toHaveProperty('similarity', null);
    expect(entry).toHaveProperty('activity_seq', null);
  });

  it('--limit 3 returns at most 3 entries in JSON mode', async () => {
    for (let i = 0; i < 10; i++) {
      insertMemory(CORTEX, {
        ts: `2026-05-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
        author: 'tester',
        content: `limit test memory number ${i}`,
      });
    }
    closeAllCortexDbs();

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'recall', '--json', '--limit', '3', 'limit test memory']);

    const written = stdoutWriteSpy.mock.calls.flat().join('');
    const parsed = JSON.parse(written.trim()) as unknown[];
    expect(parsed.length).toBeLessThanOrEqual(3);
  });

  it('--limit foo exits non-zero with clear error', async () => {
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'recall', '--limit', 'foo', 'some query']);

    expect(process.exitCode).toBe(1);
    const errOutput = (console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ');
    expect(errOutput).toMatch(/--limit must be a positive integer/);
    expect(errOutput).toContain("'foo'");
  });

  it('--limit 0 exits non-zero with clear error', async () => {
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'recall', '--limit', '0', 'some query']);

    expect(process.exitCode).toBe(1);
    const errOutput = (console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ');
    expect(errOutput).toMatch(/--limit must be a positive integer/);
  });

  it('--json --full emits valid JSON array without error', async () => {
    insertMemory(CORTEX, { ts: '2026-05-01T00:00:00.000Z', author: 'tester', content: 'full json compose test' });
    closeAllCortexDbs();

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'recall', '--json', '--full', 'full json compose']);

    const written = stdoutWriteSpy.mock.calls.flat().join('');
    const parsed = JSON.parse(written.trim());
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('--full returns both raw and compacted entries in FTS mode', async () => {
    const db = getCortexDb(CORTEX);

    const rawEntry = insertMemory(CORTEX, {
      ts: '2026-01-01T00:00:00.000Z',
      author: 'tester',
      content: 'compaction full test raw entry',
    });
    db.prepare("UPDATE memories SET kind = 'memory' WHERE id = ?").run(rawEntry.id);

    const compactedEntry = insertMemory(CORTEX, {
      ts: '2026-01-02T00:00:00.000Z',
      author: 'tester',
      content: 'compaction full test compacted entry',
    });
    db.prepare("UPDATE memories SET kind = 'memory' WHERE id = ?").run(compactedEntry.id);

    db.prepare('INSERT INTO compaction_links (raw_id, compacted_id) VALUES (?, ?)').run(rawEntry.id, compactedEntry.id);
    closeAllCortexDbs();

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'recall', '--json', '--full', 'compaction full test']);

    const written = stdoutWriteSpy.mock.calls.flat().join('');
    const parsed = JSON.parse(written.trim()) as Record<string, unknown>[];
    // FTS mode does not apply the compaction filter (that is a daemon/vector path concern per AGT-305).
    // Both raw and compacted entries should appear in --full mode.
    expect(parsed.length).toBeGreaterThanOrEqual(2);
    const ids = parsed.map(e => e['id']);
    expect(ids).toContain(rawEntry.id);
    expect(ids).toContain(compactedEntry.id);
  });

  it('--json --all exits non-zero with clear incompatibility error', async () => {
    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'recall', '--json', '--all', 'some query']);

    expect(process.exitCode).toBe(1);
    const errOutput = (console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ');
    expect(errOutput).toMatch(/--json.*--all|not compatible/i);
  });
});
