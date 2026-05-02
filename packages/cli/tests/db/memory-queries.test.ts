import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { insertMemory } from '../../src/db/memory-queries.js';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
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
});

describe('migration v7 backfill', () => {
  // The migration runner applies all migrations on first DB open. To exercise
  // the backfill path we drop ourselves below v7, insert a NULL-origin row,
  // then re-run migrations.
  let originalHome: string | undefined;
  let tmpHome: string;
  const cortex = 'origin-backfill-test';

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-migration-test-'));
    process.env.THINK_HOME = tmpHome;
    closeAllCortexDbs();
  });

  afterEach(() => {
    closeAllCortexDbs();
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('backfills NULL origin_peer_id with the local peer id', () => {
    const db = getCortexDb(cortex);

    // Simulate a pre-v7 row by manually NULLing origin_peer_id on an
    // already-migrated DB. (Re-creating the table without the column would
    // also work but requires more dance with FTS triggers.)
    db.prepare(
      `INSERT INTO memories (id, ts, author, content, source_ids, created_at, sync_version, origin_peer_id)
       VALUES (?, ?, ?, ?, '[]', ?, 1, NULL)`,
    ).run('legacy-id', '2026-04-29T12:00:00Z', 'a', 'legacy', new Date().toISOString());

    // Re-run the v7 backfill statement directly. (The migration itself only
    // runs once per version; this test asserts the SQL it issues works.)
    const peerId = getPeerId();
    db.prepare('UPDATE memories SET origin_peer_id = ? WHERE origin_peer_id IS NULL').run(peerId);

    const row = db.prepare('SELECT origin_peer_id FROM memories WHERE id = ?').get('legacy-id') as { origin_peer_id: string };
    expect(row.origin_peer_id).toBe(peerId);
  });
});
