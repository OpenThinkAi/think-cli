/**
 * Tests for applySupersession (AGT-304)
 *
 * AC coverage:
 *   1. supersedes non-empty → older entries get superseded_at + superseded_by set
 *   2. isDuplicate true → new entry gets deleted_at set + a tombstone line
 *      enqueued to l1_outbox (the plumbing drain appends it to the cortex
 *      branch — #70 Option B / AGT-458 — so there is no worktree write here)
 *   3. topics → topics_json updated on new entry in L2
 *   4. End-to-end: two contradictory retros → older has superseded_at non-null,
 *      new entry remains active
 *   5. isDuplicate → tombstoned entry has deleted_at non-null
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
import { applySupersession } from '../../src/daemon/supersession/apply.js';
import { pushDebouncer } from '../../src/daemon/push-debouncer.js';

const CORTEX = 'supersession-apply-test';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let thinkHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.THINK_HOME;
  thinkHome = mkdtempSync(join(tmpdir(), 'think-apply-test-'));
  process.env.THINK_HOME = thinkHome;
  closeAllCortexDbs();
  // applySupersession enqueues a tombstone and calls `pushDebouncer.notify()`
  // (the singleton), which schedules a debounced drain that would otherwise
  // spawn a real `git` subprocess against this test's torn-down THINK_HOME
  // after the test returns — a leftover child + timer that can wedge the
  // vitest fork-pool worker. Stub the git seam to a no-op so the scheduled
  // drain stays in-process and harmless.
  pushDebouncer._gitOverride = async () => '';

  // Create L2 DB (migrations run automatically via getCortexDb)
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Insert a minimal memory row into L2 for testing.
 * Bypasses the full sync pipeline — we only need the DB row.
 */
function insertTestEntry(id: string, content: string, kind = 'retro'): void {
  const db = getCortexDb(CORTEX);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO memories
      (id, ts, author, content, source_ids, created_at, deleted_at,
       sync_version, origin_peer_id, embedding, embedding_model, activity_seq, kind)
    VALUES (?, ?, 'test-author', ?, '[]', ?, NULL, 1, 'test-peer', NULL, NULL, NULL, ?)
  `).run(id, now, content, now, kind);
}

function getMemoryRow(id: string): Record<string, unknown> | undefined {
  const db = getCortexDb(CORTEX);
  return db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;
}

/** Read the enqueued l1_outbox lines (FIFO), parsed. */
function readOutboxLines(): Record<string, unknown>[] {
  const db = getCortexDb(CORTEX);
  const rows = db.prepare('SELECT line FROM l1_outbox ORDER BY id ASC').all() as
    { line: string }[];
  return rows.map((r) => JSON.parse(r.line) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('applySupersession (AGT-304)', () => {
  it('marks superseded entries with superseded_at and superseded_by', () => {
    const oldId = 'old-entry-001';
    const newId = 'new-entry-001';
    insertTestEntry(oldId, 'Use npm in this repo.');
    insertTestEntry(newId, 'Use pnpm in this repo.');

    applySupersession(newId, {
      supersedes: [oldId],
      topics: ['package-manager'],
      isDuplicate: false,
    }, CORTEX);

    const oldRow = getMemoryRow(oldId);
    expect(oldRow).toBeDefined();
    expect(oldRow!['superseded_at']).not.toBeNull();
    expect(oldRow!['superseded_by']).toBe(newId);

    // new entry should not be marked superseded
    const newRow = getMemoryRow(newId);
    expect(newRow!['superseded_at']).toBeNull();
    expect(newRow!['deleted_at']).toBeNull();
  });

  it('applies topics to the new entry in L2', () => {
    const newId = 'new-entry-002';
    insertTestEntry(newId, 'Run make build before make test.');

    applySupersession(newId, {
      supersedes: [],
      topics: ['build', 'testing'],
      isDuplicate: false,
    }, CORTEX);

    const row = getMemoryRow(newId);
    expect(row!['topics_json']).toBe(JSON.stringify(['build', 'testing']));
  });

  it('tombstones the new entry in L2 when isDuplicate is true', () => {
    const dupId = 'dup-entry-001';
    insertTestEntry(dupId, 'This repo uses pnpm.');

    applySupersession(dupId, {
      supersedes: [],
      topics: ['package-manager'],
      isDuplicate: true,
    }, CORTEX);

    const row = getMemoryRow(dupId);
    expect(row!['deleted_at']).not.toBeNull();
  });

  it('enqueues a tombstone line to l1_outbox when isDuplicate is true', () => {
    // The tombstone is reconstructed from the durable L2 row and enqueued for
    // the push-debouncer's plumbing drain — no worktree L1 file is touched
    // (#70 Option B / AGT-458).
    const dupId = 'dup-entry-002';
    insertTestEntry(dupId, 'pnpm is the package manager here.');

    applySupersession(dupId, {
      supersedes: [],
      topics: [],
      isDuplicate: true,
    }, CORTEX);

    const lines = readOutboxLines();
    expect(lines.length).toBe(1);
    const tombstoneLine = lines[0];
    expect(tombstoneLine['id']).toBe(dupId);
    expect(tombstoneLine['content']).toBe('pnpm is the package manager here.');
    expect(tombstoneLine['deleted_at']).not.toBeNull();
    expect(tombstoneLine['tombstone_reason']).toBe('duplicate_detected_by_supersession');
  });

  it('end-to-end: two contradictory retros — older superseded, newer active', () => {
    const oldId = 'e2e-old-001';
    const newId = 'e2e-new-001';
    insertTestEntry(oldId, 'The users.email column is always non-null.');
    insertTestEntry(newId, 'The users.email column is nullable as of the v4 migration.');

    applySupersession(newId, {
      supersedes: [oldId],
      topics: ['database', 'schema'],
      isDuplicate: false,
    }, CORTEX);

    const oldRow = getMemoryRow(oldId);
    const newRow = getMemoryRow(newId);

    // Older entry: superseded
    expect(oldRow!['superseded_at']).not.toBeNull();
    expect(oldRow!['superseded_by']).toBe(newId);
    // New entry: active (no tombstone, no supersession)
    expect(newRow!['deleted_at']).toBeNull();
    expect(newRow!['superseded_at']).toBeNull();
    // Topics applied to new entry
    expect(newRow!['topics_json']).toBe(JSON.stringify(['database', 'schema']));
  });

  it('is idempotent: applying supersession twice does not change superseded_at', () => {
    const oldId = 'idempotent-old-001';
    const newId = 'idempotent-new-001';
    insertTestEntry(oldId, 'Run npm install.');
    insertTestEntry(newId, 'Run pnpm install.');

    applySupersession(newId, { supersedes: [oldId], topics: [], isDuplicate: false }, CORTEX);
    const firstTs = (getMemoryRow(oldId) as Record<string, unknown>)['superseded_at'] as string;

    // Second apply — superseded_at IS NOT NULL guard should prevent overwrite
    applySupersession(newId, { supersedes: [oldId], topics: [], isDuplicate: false }, CORTEX);
    const secondTs = (getMemoryRow(oldId) as Record<string, unknown>)['superseded_at'] as string;

    expect(secondTs).toBe(firstTs);
  });
});
