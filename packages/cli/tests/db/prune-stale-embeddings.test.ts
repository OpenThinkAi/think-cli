/**
 * Tests for pruneStaleEmbeddings — Tier 0 (tombstoned) + Tier 1 (superseded
 * past grace) embedding reclamation.
 *
 * The function clears the local, rebuildable `embedding` BLOB (and its
 * `memories_vec` shadow row) for rows recall no longer uses, without touching
 * content, sync_version, or live rows. Rows are inserted with raw SQL so the
 * test controls `embedding`, `deleted_at`, and `superseded_at` directly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
import { pruneStaleEmbeddings } from '../../src/db/memory-queries.js';

const cortex = 'prune-test';

/** ISO timestamp `days` days before now. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

interface RowOpts {
  id: string;
  embedding?: Uint8Array | null;
  deleted_at?: string | null;
  superseded_at?: string | null;
}

function insertRow(opts: RowOpts): void {
  const db = getCortexDb(cortex);
  db.prepare(
    `INSERT INTO memories (id, ts, author, content, created_at, embedding, embedding_model, deleted_at, superseded_at)
     VALUES (?, ?, 'tester', ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.id,
    '2026-01-01T00:00:00Z',
    `content-${opts.id}`,
    '2026-01-01T00:00:00Z',
    opts.embedding ?? null,
    opts.embedding ? 'Xenova/bge-small-en-v1.5' : null,
    opts.deleted_at ?? null,
    opts.superseded_at ?? null,
  );
}

function embeddingOf(id: string): Uint8Array | null {
  const db = getCortexDb(cortex);
  const row = db.prepare('SELECT embedding FROM memories WHERE id = ?').get(id) as
    | { embedding: Uint8Array | null }
    | undefined;
  return row?.embedding ?? null;
}

/** A 1536-byte (384-dim float32) stand-in embedding BLOB. */
function fakeEmbedding(): Uint8Array {
  return new Uint8Array(1536).fill(7);
}

describe('pruneStaleEmbeddings', () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-prune-test-'));
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

  it('clears embeddings on tombstoned rows but keeps a live row', () => {
    insertRow({ id: 'live', embedding: fakeEmbedding() });
    insertRow({ id: 'dead', embedding: fakeEmbedding(), deleted_at: daysAgo(1) });

    const result = pruneStaleEmbeddings(cortex, 14);

    expect(result.prunedRows).toBe(1);
    expect(result.bytesFreed).toBe(1536);
    expect(embeddingOf('dead')).toBeNull();
    expect(embeddingOf('live')).not.toBeNull();
  });

  it('clears embeddings on rows superseded past the grace window only', () => {
    insertRow({ id: 'live', embedding: fakeEmbedding() });
    insertRow({ id: 'old-super', embedding: fakeEmbedding(), superseded_at: daysAgo(30) });
    insertRow({ id: 'fresh-super', embedding: fakeEmbedding(), superseded_at: daysAgo(2) });

    const result = pruneStaleEmbeddings(cortex, 14);

    expect(result.prunedRows).toBe(1);
    expect(embeddingOf('old-super')).toBeNull();
    expect(embeddingOf('fresh-super')).not.toBeNull(); // within 14-day grace
    expect(embeddingOf('live')).not.toBeNull();
  });

  it('does not bump sync_version when clearing an embedding', () => {
    insertRow({ id: 'live', embedding: fakeEmbedding() });
    insertRow({ id: 'dead', embedding: fakeEmbedding(), deleted_at: daysAgo(1) });
    const db = getCortexDb(cortex);
    const before = (db.prepare('SELECT sync_version FROM memories WHERE id = ?').get('dead') as { sync_version: number }).sync_version;

    pruneStaleEmbeddings(cortex, 14);

    const after = (db.prepare('SELECT sync_version FROM memories WHERE id = ?').get('dead') as { sync_version: number }).sync_version;
    expect(after).toBe(before);
  });

  it('refuses to clear the cortex\'s last embeddings (safety guard)', () => {
    // Every embedded row is stale → clearing all would force a full reindex.
    insertRow({ id: 'dead1', embedding: fakeEmbedding(), deleted_at: daysAgo(1) });
    insertRow({ id: 'dead2', embedding: fakeEmbedding(), superseded_at: daysAgo(30) });

    const result = pruneStaleEmbeddings(cortex, 14);

    expect(result.skippedToProtectLastEmbeddings).toBe(true);
    expect(result.prunedRows).toBe(0);
    expect(embeddingOf('dead1')).not.toBeNull();
    expect(embeddingOf('dead2')).not.toBeNull();
  });

  it('is a no-op (no error) when nothing is stale', () => {
    insertRow({ id: 'live1', embedding: fakeEmbedding() });
    insertRow({ id: 'live2', embedding: fakeEmbedding() });

    const result = pruneStaleEmbeddings(cortex, 14);

    expect(result.prunedRows).toBe(0);
    expect(result.bytesFreed).toBe(0);
    expect(result.skippedToProtectLastEmbeddings).toBe(false);
  });

  it('ignores rows that already have a null embedding', () => {
    insertRow({ id: 'live', embedding: fakeEmbedding() });
    insertRow({ id: 'dead-noembed', embedding: null, deleted_at: daysAgo(1) });

    const result = pruneStaleEmbeddings(cortex, 14);

    expect(result.prunedRows).toBe(0);
  });
});
