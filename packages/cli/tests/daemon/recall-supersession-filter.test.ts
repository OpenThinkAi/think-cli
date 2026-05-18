/**
 * Tests for AGT-305: default recall filters superseded and compacted-raw entries.
 *
 * Strategy: set up fixture entries with known superseded_at / compaction_links
 * state, then verify that:
 *   - default recall hides superseded entries and compacted-raw memories
 *   - --full (full: true) returns everything
 *   - --include-superseded (includeSuperseded: true) restores superseded but
 *     still hides compacted-raw memories
 *   - compaction_links filter is NOT applied to retros or events (kind != 'memory')
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
import { insertMemory } from '../../src/db/memory-queries.js';
import { handleRecall } from '../../src/daemon/recall.js';
import * as embedModule from '../../src/lib/embed.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const DIM = 3;

function axis(pos: number): Float32Array {
  const v = new Float32Array(DIM);
  v[pos % DIM] = 1.0;
  return v;
}

function toBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer);
}

const CORTEX = 'recall-supersession-filter-test';

describe('handleRecall — supersession + compaction filters (AGT-305)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-agt305-'));
    process.env.THINK_HOME = tmpHome;
    closeAllCortexDbs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeAllCortexDbs();
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  // ── Test 1: default recall hides superseded entry ────────────────────────

  it('default recall returns only the newer (non-superseded) entry', async () => {
    const db = getCortexDb(CORTEX);

    // Insert two retro-like memory entries: old (superseded) and new (active).
    const oldEntry = insertMemory(CORTEX, {
      ts: '2026-01-01T00:00:00.000Z',
      author: 'test',
      content: 'outdated observation about the build system',
    });
    const newEntry = insertMemory(CORTEX, {
      ts: '2026-05-01T00:00:00.000Z',
      author: 'test',
      content: 'updated observation about the build system',
    });

    // Set embeddings — both point in the same direction so both would match.
    db.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
      .run(toBlob(axis(0)), oldEntry.id);
    db.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
      .run(toBlob(axis(0)), newEntry.id);

    // Mark oldEntry as superseded.
    db.prepare("UPDATE memories SET superseded_at = '2026-05-01T00:00:00.000Z', superseded_by = ? WHERE id = ?")
      .run(newEntry.id, oldEntry.id);

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    const results = await handleRecall({ cortex: CORTEX, query: 'build system' });

    const ids = results.map(r => r.id);
    expect(ids).not.toContain(oldEntry.id);
    expect(ids).toContain(newEntry.id);
  });

  // ── Test 2: --full returns both superseded and non-superseded ───────────

  it('--full returns both superseded and active entries', async () => {
    const db = getCortexDb(CORTEX);

    const oldEntry = insertMemory(CORTEX, {
      ts: '2026-01-01T00:00:00.000Z',
      author: 'test',
      content: 'old config approach',
    });
    const newEntry = insertMemory(CORTEX, {
      ts: '2026-05-01T00:00:00.000Z',
      author: 'test',
      content: 'new config approach',
    });

    db.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
      .run(toBlob(axis(0)), oldEntry.id);
    db.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
      .run(toBlob(axis(0)), newEntry.id);

    db.prepare("UPDATE memories SET superseded_at = '2026-05-01T00:00:00.000Z', superseded_by = ? WHERE id = ?")
      .run(newEntry.id, oldEntry.id);

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    const results = await handleRecall({ cortex: CORTEX, query: 'config', full: true });

    const ids = results.map(r => r.id);
    expect(ids).toContain(oldEntry.id);
    expect(ids).toContain(newEntry.id);
  });

  // ── Test 3: --include-superseded returns superseded but hides compacted-raw

  it('--include-superseded restores superseded entries', async () => {
    const db = getCortexDb(CORTEX);

    const oldEntry = insertMemory(CORTEX, {
      ts: '2026-01-01T00:00:00.000Z',
      author: 'test',
      content: 'legacy deployment approach',
    });
    const newEntry = insertMemory(CORTEX, {
      ts: '2026-05-01T00:00:00.000Z',
      author: 'test',
      content: 'modern deployment approach',
    });

    db.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
      .run(toBlob(axis(0)), oldEntry.id);
    db.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
      .run(toBlob(axis(0)), newEntry.id);

    db.prepare("UPDATE memories SET superseded_at = '2026-05-01T00:00:00.000Z', superseded_by = ? WHERE id = ?")
      .run(newEntry.id, oldEntry.id);

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    const results = await handleRecall({
      cortex: CORTEX,
      query: 'deployment',
      includeSuperseded: true,
    });

    const ids = results.map(r => r.id);
    expect(ids).toContain(oldEntry.id);
    expect(ids).toContain(newEntry.id);
  });

  // ── Test 4: default recall hides compacted-raw memories ─────────────────

  it('default recall hides raw memory entries that have been compacted', async () => {
    const db = getCortexDb(CORTEX);

    // rawEntry simulates a raw memory write; compactedEntry simulates the
    // compaction output that folds rawEntry.
    const rawEntry = insertMemory(CORTEX, {
      ts: '2026-01-15T00:00:00.000Z',
      author: 'test',
      content: 'raw memory observation',
    });
    const compactedEntry = insertMemory(CORTEX, {
      ts: '2026-01-15T00:01:00.000Z',
      author: 'test',
      content: 'compacted memory: raw memory observation (folded)',
    });

    db.prepare('UPDATE memories SET embedding = ?, kind = ? WHERE id = ?')
      .run(toBlob(axis(1)), 'memory', rawEntry.id);
    db.prepare('UPDATE memories SET embedding = ?, kind = ? WHERE id = ?')
      .run(toBlob(axis(1)), 'memory', compactedEntry.id);

    // Register the compaction link: rawEntry → compactedEntry.
    db.prepare('INSERT INTO compaction_links (raw_id, compacted_id) VALUES (?, ?)')
      .run(rawEntry.id, compactedEntry.id);

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(1));

    const results = await handleRecall({ cortex: CORTEX, query: 'raw memory' });

    const ids = results.map(r => r.id);
    expect(ids).not.toContain(rawEntry.id);
    expect(ids).toContain(compactedEntry.id);
  });

  // ── Test 5: compaction filter does NOT apply to non-memory kinds ─────────

  it('compaction filter does not hide retro entries even if listed in compaction_links', async () => {
    const db = getCortexDb(CORTEX);

    // Simulate a retro entry that was accidentally put in compaction_links
    // (should never happen in practice, but we verify the filter is conditional
    // on kind=memory and doesn't hide retros/events).
    const retroEntry = insertMemory(CORTEX, {
      ts: '2026-02-01T00:00:00.000Z',
      author: 'test',
      content: 'retro wisdom about architecture',
    });
    db.prepare("UPDATE memories SET embedding = ?, kind = 'retro' WHERE id = ?")
      .run(toBlob(axis(2)), retroEntry.id);

    // Intentionally insert this retro into compaction_links — the filter must
    // ignore it because it's not kind=memory.
    db.prepare('INSERT INTO compaction_links (raw_id, compacted_id) VALUES (?, ?)')
      .run(retroEntry.id, 'fake-compacted-id');

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(2));

    const results = await handleRecall({ cortex: CORTEX, query: 'architecture' });

    const ids = results.map(r => r.id);
    expect(ids).toContain(retroEntry.id);
  });

  // ── Test 6: --full restores compacted-raw memories too ──────────────────

  it('--full returns both raw and compacted memory entries', async () => {
    const db = getCortexDb(CORTEX);

    const rawEntry = insertMemory(CORTEX, {
      ts: '2026-03-01T00:00:00.000Z',
      author: 'test',
      content: 'raw entry to be compacted',
    });
    const compactedEntry = insertMemory(CORTEX, {
      ts: '2026-03-01T00:01:00.000Z',
      author: 'test',
      content: 'compacted result',
    });

    db.prepare('UPDATE memories SET embedding = ?, kind = ? WHERE id = ?')
      .run(toBlob(axis(0)), 'memory', rawEntry.id);
    db.prepare('UPDATE memories SET embedding = ?, kind = ? WHERE id = ?')
      .run(toBlob(axis(0)), 'memory', compactedEntry.id);

    db.prepare('INSERT INTO compaction_links (raw_id, compacted_id) VALUES (?, ?)')
      .run(rawEntry.id, compactedEntry.id);

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    const results = await handleRecall({ cortex: CORTEX, query: 'compacted', full: true });

    const ids = results.map(r => r.id);
    expect(ids).toContain(rawEntry.id);
    expect(ids).toContain(compactedEntry.id);
  });

  // ── Test 7: --include-superseded still hides compacted-raw memories ──────

  it('--include-superseded still hides compacted-raw memory entries', async () => {
    const db = getCortexDb(CORTEX);

    const rawEntry = insertMemory(CORTEX, {
      ts: '2026-04-01T00:00:00.000Z',
      author: 'test',
      content: 'raw memory that was compacted',
    });
    const compactedEntry = insertMemory(CORTEX, {
      ts: '2026-04-01T00:01:00.000Z',
      author: 'test',
      content: 'compacted output',
    });

    db.prepare('UPDATE memories SET embedding = ?, kind = ? WHERE id = ?')
      .run(toBlob(axis(1)), 'memory', rawEntry.id);
    db.prepare('UPDATE memories SET embedding = ?, kind = ? WHERE id = ?')
      .run(toBlob(axis(1)), 'memory', compactedEntry.id);

    db.prepare('INSERT INTO compaction_links (raw_id, compacted_id) VALUES (?, ?)')
      .run(rawEntry.id, compactedEntry.id);

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(1));

    const results = await handleRecall({
      cortex: CORTEX,
      query: 'compacted',
      includeSuperseded: true,
    });

    const ids = results.map(r => r.id);
    // rawEntry should still be hidden — --include-superseded only lifts the
    // superseded_at filter, not the compaction_links filter.
    expect(ids).not.toContain(rawEntry.id);
    expect(ids).toContain(compactedEntry.id);
  });
});
