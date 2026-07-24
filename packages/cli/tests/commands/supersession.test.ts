/**
 * Tests for `think supersession show` / `revert` (issue #87).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';

const CORTEX = 'supersession-cmd-test';

let thinkHome: string;
let originalHome: string | undefined;

vi.mock('../../src/lib/config.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/lib/config.js')>();
  return {
    ...mod,
    getConfig: () => ({ cortex: { active: CORTEX } }),
  };
});

beforeEach(() => {
  originalHome = process.env.THINK_HOME;
  thinkHome = mkdtempSync(join(tmpdir(), 'think-supersession-cmd-'));
  process.env.THINK_HOME = thinkHome;
  closeAllCortexDbs();
  getCortexDb(CORTEX);
  closeAllCortexDbs();
});

afterEach(() => {
  vi.clearAllMocks();
  closeAllCortexDbs();
  if (originalHome === undefined) delete process.env.THINK_HOME;
  else process.env.THINK_HOME = originalHome;
  rmSync(thinkHome, { recursive: true, force: true });
  process.exitCode = undefined;
});

function insertEntry(id: string, content: string, supersededBy?: string): void {
  const db = getCortexDb(CORTEX);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO memories
      (id, ts, author, content, source_ids, created_at, deleted_at,
       sync_version, origin_peer_id, embedding, embedding_model, activity_seq, kind,
       superseded_by, superseded_at)
    VALUES (?, ?, 'test', ?, '[]', ?, NULL, 1, 'peer', NULL, NULL, NULL, 'memory', ?, ?)
  `).run(id, now, content, now, supersededBy ?? null, supersededBy ? now : null);
}

async function runSupersession(args: string[]): Promise<string[]> {
  const lines: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    lines.push(a.join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    lines.push(a.join(' '));
  });
  const { supersessionCommand } = await import('../../src/commands/supersession.js');
  await supersessionCommand.parseAsync(args, { from: 'user' });
  logSpy.mockRestore();
  errSpy.mockRestore();
  return lines;
}

describe('think supersession show', () => {
  it('shows the superseding entry and offers the revert command', async () => {
    insertEntry('new-entry', 'the unrelated replacement');
    insertEntry('old-entry', 'the hidden decision record', 'new-entry');

    const lines = await runSupersession(['show', 'old-entry']);
    const output = lines.join('\n');
    expect(output).toContain('old-entry');
    expect(output).toMatch(/superseded/);
    expect(output).toContain('new-entry');
    expect(output).toContain('the unrelated replacement');
    expect(output).toContain('think supersession revert old-entry');
  });

  it('lists what an entry supersedes', async () => {
    insertEntry('winner', 'the replacement');
    insertEntry('loser-1', 'old record one', 'winner');
    insertEntry('loser-2', 'old record two', 'winner');

    const lines = await runSupersession(['show', 'winner']);
    const output = lines.join('\n');
    expect(output).toMatch(/supersedes 2 entries/);
    expect(output).toContain('loser-1');
    expect(output).toContain('loser-2');
  });

  it('exits 1 for an unknown id', async () => {
    const lines = await runSupersession(['show', 'ghost']);
    expect(lines.join('\n')).toContain('no entry with id ghost');
    expect(process.exitCode).toBe(1);
  });
});

describe('think supersession list', () => {
  it('lists superseded entries most recent first with a total count', async () => {
    insertEntry('winner', 'the replacement');
    insertEntry('hidden-1', 'first hidden record', 'winner');
    insertEntry('hidden-2', 'second hidden record', 'winner');
    insertEntry('live', 'a live record');

    const lines = await runSupersession(['list']);
    const output = lines.join('\n');
    expect(output).toMatch(/2 superseded entries/);
    expect(output).toContain('hidden-1');
    expect(output).toContain('hidden-2');
    expect(output).not.toContain('a live record');
    expect(output).toContain('think supersession revert');
  });

  it('reports no superseded entries on a clean cortex', async () => {
    insertEntry('live', 'a live record');
    const lines = await runSupersession(['list']);
    expect(lines.join('\n')).toContain('no superseded entries');
  });

  it('respects --limit while reporting the full total', async () => {
    insertEntry('winner', 'the replacement');
    for (let i = 0; i < 5; i++) insertEntry(`hidden-${i}`, `hidden record ${i}`, 'winner');

    const lines = await runSupersession(['list', '--limit', '2']);
    const output = lines.join('\n');
    expect(output).toMatch(/5 superseded entries \(showing 2\)/);
  });
});

describe('think supersession revert', () => {
  it('clears superseded_at/by and restores the entry', async () => {
    insertEntry('new-entry', 'replacement');
    insertEntry('old-entry', 'hidden record', 'new-entry');

    const lines = await runSupersession(['revert', 'old-entry']);
    expect(lines.join('\n')).toMatch(/reverted supersession of old-entry/);

    const row = getCortexDb(CORTEX).prepare(
      'SELECT superseded_at, superseded_by FROM memories WHERE id = ?',
    ).get('old-entry') as { superseded_at: string | null; superseded_by: string | null };
    expect(row.superseded_at).toBeNull();
    expect(row.superseded_by).toBeNull();
  });

  it('exits 1 and reports honestly when the entry is not superseded', async () => {
    insertEntry('live-entry', 'active record');
    const lines = await runSupersession(['revert', 'live-entry']);
    expect(lines.join('\n')).toContain('not superseded — nothing to revert');
    expect(process.exitCode).toBe(1);
  });
});
