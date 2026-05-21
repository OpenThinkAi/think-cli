/**
 * Tests for `think log` deprecation notice -- AGT-390 / PE-10
 *
 * Verifies:
 *  1. Invocation prints a deprecation notice on stderr pointing to `think sync`
 *     as the v3 replacement.
 *  2. `--silent` suppresses the notice (matches the `--no-sync` deprecation
 *     pattern; keeps CLAUDE.md auto-logging quiet).
 *  3. The notice does not short-circuit the write — the entry still lands in
 *     the local `entries` table.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { makeLogCommand } from '../../src/commands/log.js';
import { getDb, closeDb } from '../../src/db/client.js';

/** Build a fresh program with a fresh log command instance per test --
 * Commander mutates _parent on addCommand. */
function makeProgram(): Command {
  const prog = new Command();
  prog.addCommand(makeLogCommand());
  return prog;
}

function withFreshThinkHome(prefix: string): void {
  let originalHome: string | undefined;
  let tmpHome: string;
  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), prefix));
    process.env.THINK_HOME = tmpHome;
    closeDb();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    closeDb();
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = 0;
  });
}

describe('think log -- v2-engram deprecation notice (AGT-390)', () => {
  withFreshThinkHome('think-log-cmd-test-');

  it('prints deprecation notice on stderr pointing to `think sync` (AC #1)', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'log', 'a note']);

    const stderr = stderrSpy.mock.calls.flat().join('');
    expect(stderr).toContain('`think log` is deprecated');
    expect(stderr).toContain('`think sync`');
  });

  it('suppresses the deprecation notice under --silent', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'log', 'a silent note', '--silent']);

    const stderr = stderrSpy.mock.calls.flat().join('');
    expect(stderr).not.toContain('deprecated');
  });

  it('still writes the entry to the local entries table (back-compat preserved)', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'log', 'persisted entry content']);

    // Re-open the DB after the action's closeDb(); query the entry back.
    const db = getDb();
    const row = db.prepare('SELECT content, category FROM entries LIMIT 1').get() as
      | { content: string; category: string }
      | undefined;
    expect(row?.content).toBe('persisted entry content');
    expect(row?.category).toBe('note');
  });

  it('--silent path also writes the entry (notice is the only thing suppressed)', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const prog = makeProgram();
    await prog.parseAsync(['node', 'think', 'log', 'silent persisted', '--silent']);

    const db = getDb();
    const row = db.prepare('SELECT COUNT(*) as count FROM entries').get() as { count: number };
    expect(row.count).toBe(1);
  });
});
