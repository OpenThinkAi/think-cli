/**
 * Tests for applySupersession (AGT-304)
 *
 * AC coverage:
 *   1. supersedes non-empty → older entries get superseded_at + superseded_by set
 *   2. isDuplicate true → new entry gets deleted_at set + L1 tombstone appended
 *   3. topics → topics_json updated on new entry in L2
 *   4. End-to-end: two contradictory retros → older has superseded_at non-null,
 *      new entry remains active
 *   5. isDuplicate → tombstoned entry has deleted_at non-null
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
import { applySupersession } from '../../src/daemon/supersession/apply.js';

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

  // Create L2 DB (migrations run automatically via getCortexDb)
  getCortexDb(CORTEX);
  closeAllCortexDbs();
});

afterEach(() => {
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

/**
 * Write a minimal L1 JSONL page so tombstone tests can find + annotate the entry.
 */
function writeL1Entry(entryId: string, content: string): void {
  const cortexDir = join(thinkHome, 'repo', CORTEX);
  mkdirSync(cortexDir, { recursive: true });
  const entry = {
    id: entryId,
    ts: new Date().toISOString(),
    author: 'test-author',
    kind: 'retro',
    content,
    topics: [],
    supersedes: [],
    compacted_from: null,
    decisions: [],
    source_ids: [],
    deleted_at: null,
  };
  writeFileSync(join(cortexDir, '000001.jsonl'), JSON.stringify(entry) + '\n', 'utf-8');
}

function getMemoryRow(id: string): Record<string, unknown> | undefined {
  const db = getCortexDb(CORTEX);
  return db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;
}

function readL1Lines(cortexDir: string): Record<string, unknown>[] {
  if (!existsSync(cortexDir)) return [];
  const lines: Record<string, unknown>[] = [];
  const files = (
    // no fs.readdirSync here — use readFileSync on the known file
    existsSync(join(cortexDir, '000001.jsonl'))
      ? ['000001.jsonl']
      : []
  );
  for (const file of files) {
    const raw = readFileSync(join(cortexDir, file), 'utf-8');
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      lines.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return lines;
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
    writeL1Entry(dupId, 'This repo uses pnpm.');

    applySupersession(dupId, {
      supersedes: [],
      topics: ['package-manager'],
      isDuplicate: true,
    }, CORTEX);

    const row = getMemoryRow(dupId);
    expect(row!['deleted_at']).not.toBeNull();
  });

  it('appends a tombstone line to L1 when isDuplicate is true', () => {
    const dupId = 'dup-entry-002';
    insertTestEntry(dupId, 'pnpm is the package manager here.');
    writeL1Entry(dupId, 'pnpm is the package manager here.');

    applySupersession(dupId, {
      supersedes: [],
      topics: [],
      isDuplicate: true,
    }, CORTEX);

    const cortexDir = join(thinkHome, 'repo', CORTEX);
    const lines = readL1Lines(cortexDir);
    // Should have 2 lines: the original + the tombstone
    expect(lines.length).toBe(2);
    const tombstoneLine = lines[lines.length - 1];
    expect(tombstoneLine['id']).toBe(dupId);
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
