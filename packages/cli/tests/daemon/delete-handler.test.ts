/**
 * Tests for the daemon `delete` endpoint (issue #84).
 *
 * Coverage:
 *   - delete by id tombstones the L2 row and enqueues an L1 tombstone line
 *   - delete by match tombstones every matching live row
 *   - zero-match returns { deleted: 0 } (never throws, never lies)
 *   - already-deleted rows are not re-deleted
 *   - --last deletes the most recent live entry
 *   - match above MAX_UNFORCED_MATCH requires force
 *   - validation: cortex required, exactly one selector
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
import { handleDelete, MAX_UNFORCED_MATCH } from '../../src/daemon/delete-handler.js';
import { pushDebouncer } from '../../src/daemon/push-debouncer.js';

const CORTEX = 'delete-handler-test';

let thinkHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.THINK_HOME;
  thinkHome = mkdtempSync(join(tmpdir(), 'think-delete-test-'));
  process.env.THINK_HOME = thinkHome;
  closeAllCortexDbs();
  // handleDelete calls pushDebouncer.notify() (the singleton), which would
  // otherwise spawn a real `git` subprocess against this torn-down THINK_HOME.
  pushDebouncer._gitOverride = async () => '';
  getCortexDb(CORTEX);
  closeAllCortexDbs();
});

afterEach(() => {
  pushDebouncer._gitOverride = undefined;
  closeAllCortexDbs();
  if (originalHome === undefined) delete process.env.THINK_HOME;
  else process.env.THINK_HOME = originalHome;
  rmSync(thinkHome, { recursive: true, force: true });
});

function insertTestEntry(id: string, content: string, ts?: string, topics?: string[]): void {
  const db = getCortexDb(CORTEX);
  const stamp = ts ?? new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO memories
      (id, ts, author, content, source_ids, created_at, deleted_at,
       sync_version, origin_peer_id, embedding, embedding_model, activity_seq, kind, topics_json)
    VALUES (?, ?, 'test-author', ?, '[]', ?, NULL, 1, 'test-peer', NULL, NULL, NULL, 'memory', ?)
  `).run(id, stamp, content, stamp, topics ? JSON.stringify(topics) : null);
}

function getRow(id: string): Record<string, unknown> | undefined {
  return getCortexDb(CORTEX).prepare('SELECT * FROM memories WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;
}

function readOutboxLines(): Record<string, unknown>[] {
  const rows = getCortexDb(CORTEX).prepare('SELECT line FROM l1_outbox ORDER BY id ASC').all() as
    { line: string }[];
  return rows.map((r) => JSON.parse(r.line) as Record<string, unknown>);
}

describe('handleDelete (issue #84)', () => {
  it('deletes a live entry by id and enqueues an L1 tombstone', () => {
    insertTestEntry('entry-001', 'HiveDB PR #54 merged', undefined, ['repo:hivedb']);

    const result = handleDelete({ cortex: CORTEX, id: 'entry-001' });

    expect(result.deleted).toBe(1);
    expect(result.entries[0]).toMatchObject({ id: 'entry-001', content: 'HiveDB PR #54 merged' });
    expect(getRow('entry-001')!['deleted_at']).not.toBeNull();

    const lines = readOutboxLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]['id']).toBe('entry-001');
    expect(lines[0]['deleted_at']).not.toBeNull();
    expect(lines[0]['tombstone_reason']).toBe('user_delete');
    expect(lines[0]['topics']).toEqual(['repo:hivedb']);
  });

  it('deletes all live entries matching a pattern', () => {
    insertTestEntry('m-1', 'wrong fact about deploys');
    insertTestEntry('m-2', 'another wrong fact entirely');
    insertTestEntry('m-3', 'unrelated correct entry');

    const result = handleDelete({ cortex: CORTEX, match: 'wrong fact' });

    expect(result.deleted).toBe(2);
    expect(getRow('m-1')!['deleted_at']).not.toBeNull();
    expect(getRow('m-2')!['deleted_at']).not.toBeNull();
    expect(getRow('m-3')!['deleted_at']).toBeNull();
    expect(readOutboxLines()).toHaveLength(2);
  });

  it('returns deleted: 0 for a pattern that matches nothing', () => {
    insertTestEntry('m-1', 'some entry');
    const result = handleDelete({ cortex: CORTEX, match: 'no-such-content' });
    expect(result).toEqual({ deleted: 0, entries: [] });
    expect(readOutboxLines()).toHaveLength(0);
  });

  it('returns deleted: 0 for an id that is already tombstoned', () => {
    insertTestEntry('m-1', 'entry');
    handleDelete({ cortex: CORTEX, id: 'm-1' });
    const second = handleDelete({ cortex: CORTEX, id: 'm-1' });
    expect(second.deleted).toBe(0);
    // Only the first delete enqueued a tombstone.
    expect(readOutboxLines()).toHaveLength(1);
  });

  it('last: true deletes the most recent live entry', () => {
    insertTestEntry('older', 'older entry', '2026-01-01T00:00:00.000Z');
    insertTestEntry('newer', 'newer entry', '2026-06-01T00:00:00.000Z');

    const result = handleDelete({ cortex: CORTEX, last: true });

    expect(result.deleted).toBe(1);
    expect(result.entries[0].id).toBe('newer');
    expect(getRow('older')!['deleted_at']).toBeNull();
  });

  it('requires force when match exceeds MAX_UNFORCED_MATCH entries', () => {
    for (let i = 0; i < MAX_UNFORCED_MATCH + 1; i++) {
      insertTestEntry(`bulk-${i}`, `bulk entry ${i}`);
    }

    expect(() => handleDelete({ cortex: CORTEX, match: 'bulk entry' }))
      .toThrow(/re-run with --force/);
    // Nothing was deleted by the refused call.
    expect(getRow('bulk-0')!['deleted_at']).toBeNull();

    const forced = handleDelete({ cortex: CORTEX, match: 'bulk entry', force: true });
    expect(forced.deleted).toBe(MAX_UNFORCED_MATCH + 1);
  });

  it('rejects a missing cortex and an unknown cortex', () => {
    expect(() => handleDelete({ id: 'x' })).toThrow(/'cortex'/);
    expect(() => handleDelete({ cortex: 'no-such-cortex-zzz', id: 'x' }))
      .toThrow(/not found/);
  });

  it('rejects zero selectors and multiple selectors', () => {
    expect(() => handleDelete({ cortex: CORTEX })).toThrow(/exactly one/);
    expect(() => handleDelete({ cortex: CORTEX, id: 'a', match: 'b' })).toThrow(/exactly one/);
  });
});
