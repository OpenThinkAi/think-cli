import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { insertMemory } from '../../src/db/memory-queries.js';
import { getCortexDb, closeAllCortexDbs, migrations } from '../../src/db/engrams.js';
import { runMigrations } from '../../src/db/migrate.js';
import { getPeerId } from '../../src/lib/config.js';

describe('insertMemory origin_peer_id', () => {
  let originalHome: string | undefined;
  let tmpHome: string;
  const cortex = 'origin-peer-test';

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-memory-test-'));
    process.env.THINK_HOME = tmpHome;
    closeAllCortexDbs();
    getCortexDb(cortex);
  });

  afterEach(() => {
    closeAllCortexDbs();
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('defaults origin_peer_id to the local peer when not supplied', () => {
    const row = insertMemory(cortex, {
      ts: '2026-04-29T12:00:00Z',
      author: 'a',
      content: 'default-origin',
    });
    expect(row.origin_peer_id).toBe(getPeerId());
  });

  it('preserves an explicit origin_peer_id', () => {
    const externalPeer = '11111111-2222-3333-4444-555555555555';
    const row = insertMemory(cortex, {
      ts: '2026-04-29T12:00:00Z',
      author: 'b',
      content: 'external-origin',
      origin_peer_id: externalPeer,
    });
    expect(row.origin_peer_id).toBe(externalPeer);
  });

  it('records a null origin_peer_id when explicitly passed', () => {
    const row = insertMemory(cortex, {
      ts: '2026-04-29T12:00:00Z',
      author: 'c',
      content: 'unknown-origin',
      origin_peer_id: null,
    });
    expect(row.origin_peer_id).toBeNull();
  });
});

describe('migration v7 backfill', () => {
  // Exercises the actual migration runner: open a fresh DB pinned at v6,
  // write a row (no origin_peer_id column exists yet), then run the full
  // migrations array and assert the v7 backfill stamped the row.
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-migration-test-'));
    process.env.THINK_HOME = tmpHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('runs the v7 migration to backfill pre-existing rows', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA journal_mode = WAL');

    // Apply migrations up to (but not including) v7.
    const preV7 = migrations.filter(m => m.version < 7);
    runMigrations(db, preV7);

    // Pre-v7 schema has no origin_peer_id column.
    const colsBefore = db.prepare(`PRAGMA table_info(memories)`).all() as { name: string }[];
    expect(colsBefore.some(c => c.name === 'origin_peer_id')).toBe(false);

    db.prepare(
      `INSERT INTO memories (id, ts, author, content, source_ids, created_at, sync_version)
       VALUES (?, ?, ?, ?, '[]', ?, 1)`,
    ).run('legacy-id', '2026-04-29T12:00:00Z', 'a', 'legacy', new Date().toISOString());

    // Now run the full set, including v7.
    runMigrations(db, migrations);

    const row = db.prepare('SELECT origin_peer_id FROM memories WHERE id = ?').get('legacy-id') as { origin_peer_id: string };
    expect(row.origin_peer_id).toBe(getPeerId());

    db.close();
  });
});
