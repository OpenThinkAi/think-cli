/**
 * `think migrate-engrams` — AGT-1302 AC4.
 *
 * The rescue itself is covered in tests/lib/engram-migration.test.ts; this is
 * the terminal surface: the per-cortex counts `--dry-run` prints, and the
 * promise that it writes nothing while printing them.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';

vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn().mockResolvedValue(
    vi.fn().mockResolvedValue({ data: new Float32Array(384).fill(0.1) }),
  ),
}));

let thinkHome: string;
let originalHome: string | undefined;
let out: string[];

beforeEach(async () => {
  originalHome = process.env.THINK_HOME;
  thinkHome = mkdtempSync(join(tmpdir(), 'think-migrate-engrams-cmd-'));
  process.env.THINK_HOME = thinkHome;
  out = [];

  const configDir = join(thinkHome, 'config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({ peerId: 'cmd-test-peer', cortex: { author: 'cmd-author' } }),
    { mode: 0o600 },
  );

  vi.resetModules();
  const { closeAllCortexDbs } = await import('../../src/db/engrams.js');
  closeAllCortexDbs();
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.map(String).join(' '));
  });
});

afterEach(async () => {
  const { closeAllCortexDbs } = await import('../../src/db/engrams.js');
  closeAllCortexDbs();
  if (originalHome === undefined) delete process.env.THINK_HOME;
  else process.env.THINK_HOME = originalHome;
  rmSync(thinkHome, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
  process.exitCode = 0;
});

async function seed(): Promise<void> {
  const { getCortexDb, closeAllCortexDbs } = await import('../../src/db/engrams.js');
  const db = getCortexDb('work');
  const stmt = db.prepare(
    `INSERT INTO engrams (id, content, created_at, expires_at, episode_key, decisions)
     VALUES (?, ?, '2026-05-01T09:00:00.000Z', '2026-05-15T09:00:00.000Z', ?, ?)`,
  );
  stmt.run('m-1', 'a stranded observation', null, null);
  stmt.run('e-1', 'weighed two options', null, JSON.stringify(['Decided on the first']));
  stmt.run('s-1', 'a feed item', 'subscribe:teammate', null);
  closeAllCortexDbs();
}

async function run(argv: string[]): Promise<void> {
  const { migrateEngramsCommand } = await import('../../src/commands/migrate-engrams.js');
  const prog = new Command();
  prog.addCommand(migrateEngramsCommand);
  await prog.parseAsync(['node', 'think', 'migrate-engrams', ...argv]);
}

describe('think migrate-engrams', () => {
  it('--dry-run prints per-cortex counts and writes nothing', async () => {
    await seed();
    await run(['--dry-run']);

    const printed = out.join('\n');
    expect(printed).toContain('Would migrate:');
    expect(printed).toContain('work: 1 event, 1 memory, 1 skipped');
    expect(printed).toContain('nothing was written');

    const { getCortexDb } = await import('../../src/db/engrams.js');
    const db = getCortexDb('work');
    expect((db.prepare('SELECT COUNT(*) n FROM memories').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) n FROM l1_outbox').get() as { n: number }).n).toBe(0);
    expect(
      (db.prepare('SELECT COUNT(*) n FROM engrams WHERE evaluated_at IS NOT NULL').get() as { n: number }).n,
    ).toBe(0);
    expect(process.exitCode).toBeFalsy();
  });

  it('migrates for real without the flag, and says so when there is nothing to do', async () => {
    await seed();
    await run([]);

    const { getCortexDb, closeAllCortexDbs } = await import('../../src/db/engrams.js');
    expect(
      (getCortexDb('work').prepare('SELECT COUNT(*) n FROM memories').get() as { n: number }).n,
    ).toBe(2);
    closeAllCortexDbs();

    // Second run: nothing left to move. The subscribe row is still reported —
    // it is still sitting there, and saying otherwise would hide it.
    out.length = 0;
    await run([]);
    expect(out.join('\n')).toContain('work: 0 events, 0 memories, 1 skipped');
  });

  it('says so when a cortex has nothing stranded at all', async () => {
    const { getCortexDb, closeAllCortexDbs } = await import('../../src/db/engrams.js');
    getCortexDb('empty');
    closeAllCortexDbs();

    await run(['--dry-run']);
    expect(out.join('\n')).toContain('nothing to migrate');
  });
});
