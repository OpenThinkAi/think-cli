/**
 * Tests for the daemon `expand` endpoint (AGT-288).
 *
 * Strategy: insert raw + compacted entries into a tmp-dir cortex DB via
 * insertMemory(), then add compaction_links rows and the v3 columns
 * (kind, compacted_from, topics, supersedes) via direct SQL to simulate what
 * the compaction pipeline will do once AGT-303 lands.
 *
 * AC coverage:
 *   1. expand a compacted entry → primary + raws populated; compactions empty
 *   2. expand a raw entry → primary + compactions populated; raws empty
 *   3. kind !== "memory" → raws and compactions are empty arrays
 *   4. entry not found → throws with "not_found"
 *   5. missing/empty params → throws with descriptive messages
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
import { insertMemory } from '../../src/db/memory-queries.js';
import { handleExpand } from '../../src/daemon/expand.js';

const CORTEX = 'expand-test';

describe('handleExpand (AGT-288)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-expand-'));
    process.env.THINK_HOME = tmpHome;
    closeAllCortexDbs();

    // Ensure the DB is created + migrated with the standard schema.
    getCortexDb(CORTEX);
  });

  afterEach(() => {
    closeAllCortexDbs();
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Helpers: add v3 columns + seed fixture rows
  // ---------------------------------------------------------------------------

  /**
   * Add the v3 columns (kind, compacted_from, topics, supersedes) to the
   * memories table if they don't already exist, then re-open the DB so the
   * column info cache in handleExpand sees them.
   */
  function addV3Columns(): void {
    const db = getCortexDb(CORTEX);
    const cols = new Set(
      (db.prepare('PRAGMA table_info(memories)').all() as { name: string }[]).map(c => c.name),
    );
    if (!cols.has('kind')) db.exec("ALTER TABLE memories ADD COLUMN kind TEXT;");
    if (!cols.has('compacted_from')) db.exec("ALTER TABLE memories ADD COLUMN compacted_from TEXT;");
    if (!cols.has('topics')) db.exec("ALTER TABLE memories ADD COLUMN topics TEXT NOT NULL DEFAULT '[]';");
    if (!cols.has('supersedes')) db.exec("ALTER TABLE memories ADD COLUMN supersedes TEXT NOT NULL DEFAULT '[]';");
    // Close + reopen so the WeakMap column-flag cache in expand.ts is fresh.
    closeAllCortexDbs();
    getCortexDb(CORTEX);
  }

  /** Write a raw memory (no compacted_from). */
  function writeRaw(content: string): string {
    const row = insertMemory(CORTEX, {
      ts: new Date().toISOString(),
      author: 'test',
      content,
    });
    const db = getCortexDb(CORTEX);
    db.prepare("UPDATE memories SET kind = 'memory', compacted_from = NULL WHERE id = ?").run(row.id);
    return row.id;
  }

  /** Write a compacted memory that folds `rawIds`. */
  function writeCompacted(content: string, rawIds: string[]): string {
    const row = insertMemory(CORTEX, {
      ts: new Date().toISOString(),
      author: 'test',
      content,
    });
    const db = getCortexDb(CORTEX);
    db.prepare(
      "UPDATE memories SET kind = 'memory', compacted_from = ? WHERE id = ?",
    ).run(JSON.stringify(rawIds), row.id);

    // Insert compaction_links rows so the reverse lookup works.
    for (const rawId of rawIds) {
      try {
        db.prepare(
          'INSERT INTO compaction_links (raw_id, compacted_id) VALUES (?, ?)',
        ).run(rawId, row.id);
      } catch {
        // Ignore duplicate (already seeded).
      }
    }

    return row.id;
  }

  /** Write a non-memory entry (retro or event). */
  function writeNonMemory(content: string, kind: string): string {
    const row = insertMemory(CORTEX, {
      ts: new Date().toISOString(),
      author: 'test',
      content,
    });
    const db = getCortexDb(CORTEX);
    db.prepare('UPDATE memories SET kind = ? WHERE id = ?').run(kind, row.id);
    return row.id;
  }

  // ---------------------------------------------------------------------------
  // AC 1: expand compacted entry → raws populated; compactions empty
  // ---------------------------------------------------------------------------

  it('compacted entry: raws contains the raw entries listed in compacted_from', () => {
    addV3Columns();

    const rawId1 = writeRaw('raw thought A');
    const rawId2 = writeRaw('raw thought B');
    const compactedId = writeCompacted('compacted summary of A and B', [rawId1, rawId2]);

    const result = handleExpand({ cortex: CORTEX, entry_id: compactedId });

    expect(result.primary.id).toBe(compactedId);
    expect(result.primary.kind).toBe('memory');
    expect(result.primary.compacted_from).toEqual(expect.arrayContaining([rawId1, rawId2]));
    expect(result.primary.compacted_from).toHaveLength(2);

    expect(result.raws).toHaveLength(2);
    const rawResultIds = result.raws.map(e => e.id);
    expect(rawResultIds).toContain(rawId1);
    expect(rawResultIds).toContain(rawId2);

    expect(result.compactions).toHaveLength(0);

    // Verify cortex is set on all entries.
    for (const entry of [result.primary, ...result.raws]) {
      expect(entry.cortex).toBe(CORTEX);
    }
  });

  // ---------------------------------------------------------------------------
  // AC 2: expand raw entry → compactions populated; raws empty
  // ---------------------------------------------------------------------------

  it('raw entry: compactions contains the compacted entries that fold it', () => {
    addV3Columns();

    const rawId = writeRaw('original observation');
    const compactedId = writeCompacted('compaction that folds the raw entry', [rawId]);

    const result = handleExpand({ cortex: CORTEX, entry_id: rawId });

    expect(result.primary.id).toBe(rawId);
    expect(result.primary.kind).toBe('memory');
    expect(result.primary.compacted_from).toBeNull();

    expect(result.raws).toHaveLength(0);
    expect(result.compactions).toHaveLength(1);
    expect(result.compactions[0].id).toBe(compactedId);
    expect(result.compactions[0].cortex).toBe(CORTEX);
  });

  // ---------------------------------------------------------------------------
  // Cross-reference symmetry: expanding both sides of a pair yields each other
  // ---------------------------------------------------------------------------

  it('cross-reference symmetry: expand raw → compaction id matches; expand compacted → raw id matches', () => {
    addV3Columns();

    const rawId = writeRaw('symmetric raw entry');
    const compactedId = writeCompacted('symmetric compacted entry', [rawId]);

    // Expand the raw entry: its compactions should include the compacted entry.
    const rawExpanded = handleExpand({ cortex: CORTEX, entry_id: rawId });
    expect(rawExpanded.compactions.map(e => e.id)).toContain(compactedId);
    expect(rawExpanded.raws).toHaveLength(0);

    // Expand the compacted entry: its raws should include the raw entry.
    const compactedExpanded = handleExpand({ cortex: CORTEX, entry_id: compactedId });
    expect(compactedExpanded.raws.map(e => e.id)).toContain(rawId);
    expect(compactedExpanded.compactions).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // AC 3: kind !== "memory" → raws and compactions empty
  // ---------------------------------------------------------------------------

  it('retro entry: returns primary only; raws and compactions are empty', () => {
    addV3Columns();
    const retroId = writeNonMemory('a durable codebase wisdom', 'retro');

    const result = handleExpand({ cortex: CORTEX, entry_id: retroId });

    expect(result.primary.id).toBe(retroId);
    expect(result.primary.kind).toBe('retro');
    expect(result.raws).toHaveLength(0);
    expect(result.compactions).toHaveLength(0);
  });

  it('event entry: returns primary only; raws and compactions are empty', () => {
    addV3Columns();
    const eventId = writeNonMemory('deploy milestone reached', 'event');

    const result = handleExpand({ cortex: CORTEX, entry_id: eventId });

    expect(result.primary.id).toBe(eventId);
    expect(result.primary.kind).toBe('event');
    expect(result.raws).toHaveLength(0);
    expect(result.compactions).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Pre-v3 DB (no kind/compacted_from columns): defaults to memory semantics
  // ---------------------------------------------------------------------------

  it('pre-v3 DB without kind/compacted_from columns: treats entry as raw memory', () => {
    // Do NOT call addV3Columns() — use the base schema.
    const rawId = insertMemory(CORTEX, {
      ts: new Date().toISOString(),
      author: 'test',
      content: 'legacy entry without kind column',
    }).id;

    const result = handleExpand({ cortex: CORTEX, entry_id: rawId });

    expect(result.primary.id).toBe(rawId);
    expect(result.primary.kind).toBeNull();   // column absent → null
    expect(result.primary.compacted_from).toBeNull();
    expect(result.raws).toHaveLength(0);
    expect(result.compactions).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // AC 4: entry not found → throws
  // ---------------------------------------------------------------------------

  it('throws when entry id does not exist in the cortex', () => {
    expect(() =>
      handleExpand({ cortex: CORTEX, entry_id: 'nonexistent-id-xyz' }),
    ).toThrow(/not found/i);
  });

  it('throws error with not_found code when entry is missing', () => {
    try {
      handleExpand({ cortex: CORTEX, entry_id: 'nonexistent-id-xyz' });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as NodeJS.ErrnoException).code).toBe('not_found');
    }
  });

  // ---------------------------------------------------------------------------
  // AC 5: param validation
  // ---------------------------------------------------------------------------

  it('throws on missing cortex param', () => {
    expect(() =>
      handleExpand({ entry_id: 'some-id' }),
    ).toThrow(/expand.*cortex/i);
  });

  it('throws on empty cortex param', () => {
    expect(() =>
      handleExpand({ cortex: '', entry_id: 'some-id' }),
    ).toThrow(/expand.*cortex/i);
  });

  it('throws on missing entry_id param', () => {
    expect(() =>
      handleExpand({ cortex: CORTEX }),
    ).toThrow(/expand.*entry_id/i);
  });

  it('throws on empty entry_id param', () => {
    expect(() =>
      handleExpand({ cortex: CORTEX, entry_id: '' }),
    ).toThrow(/expand.*entry_id/i);
  });

  it('throws on path-traversal cortex name (sanitizeName guard)', () => {
    expect(() =>
      handleExpand({ cortex: '../../../etc/passwd', entry_id: 'some-id' }),
    ).toThrow();
  });

  // ---------------------------------------------------------------------------
  // Result shape
  // ---------------------------------------------------------------------------

  it('all ExpandEntry fields are present on returned entries', () => {
    addV3Columns();
    const rawId = writeRaw('shape check content');
    const result = handleExpand({ cortex: CORTEX, entry_id: rawId });
    const entry = result.primary;

    expect(typeof entry.id).toBe('string');
    expect(typeof entry.ts).toBe('string');
    expect(typeof entry.author).toBe('string');
    expect(typeof entry.content).toBe('string');
    expect(entry.kind === null || typeof entry.kind === 'string').toBe(true);
    expect(entry.compacted_from === null || Array.isArray(entry.compacted_from)).toBe(true);
    expect(Array.isArray(entry.topics)).toBe(true);
    expect(Array.isArray(entry.supersedes)).toBe(true);
    expect(entry.deleted_at === null || typeof entry.deleted_at === 'string').toBe(true);
    expect(entry.cortex).toBe(CORTEX);
  });
});
