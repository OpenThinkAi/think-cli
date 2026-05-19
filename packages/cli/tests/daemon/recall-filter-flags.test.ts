/**
 * Tests for AGT-320 recall filter flags: --kind, --topic, --since.
 *
 * Strategy: use a tmp-dir cortex DB with fixture entries that have known
 * kind/topics_json/ts values. Embedding is mocked so no model download needed.
 * Critical: uses topics_json column (migration 14), not the legacy topics column.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
import { insertMemory } from '../../src/db/memory-queries.js';
import { handleRecall, validateKind, validateSince } from '../../src/daemon/recall.js';
import * as embedModule from '../../src/lib/embed.js';

const DIM = 3;

function axis(pos: number): Float32Array {
  const v = new Float32Array(DIM);
  v[pos % DIM] = 1.0;
  return v;
}

function toBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer);
}

const CORTEX = 'recall-filter-flags-test';

describe('handleRecall — filter flags (AGT-320)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-agt320-'));
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

  // ── --kind filter ───────────────────────────────────────────

  it('--kind retro returns only retro entries', async () => {
    const db = getCortexDb(CORTEX);
    const retroEntry = insertMemory(CORTEX, {
      ts: '2026-05-01T00:00:00.000Z', author: 'test',
      content: 'always run build before committing',
    });
    const memoryEntry = insertMemory(CORTEX, {
      ts: '2026-05-02T00:00:00.000Z', author: 'test',
      content: 'auth uses Ed25519',
    });
    db.prepare('UPDATE memories SET embedding = ?, kind = ? WHERE id = ?')
      .run(toBlob(axis(0)), 'retro', retroEntry.id);
    db.prepare('UPDATE memories SET embedding = ?, kind = ? WHERE id = ?')
      .run(toBlob(axis(0)), 'memory', memoryEntry.id);
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    const results = await handleRecall({ cortex: CORTEX, query: 'test', kind: 'retro' });
    const ids = results.map(r => r.id);
    expect(ids).toContain(retroEntry.id);
    expect(ids).not.toContain(memoryEntry.id);
  });

  it('--kind memory returns only memory entries', async () => {
    const db = getCortexDb(CORTEX);
    const retroEntry = insertMemory(CORTEX, {
      ts: '2026-05-01T00:00:00.000Z', author: 'test', content: 'retro observation',
    });
    const memoryEntry = insertMemory(CORTEX, {
      ts: '2026-05-02T00:00:00.000Z', author: 'test', content: 'memory observation',
    });
    db.prepare('UPDATE memories SET embedding = ?, kind = ? WHERE id = ?')
      .run(toBlob(axis(0)), 'retro', retroEntry.id);
    db.prepare('UPDATE memories SET embedding = ?, kind = ? WHERE id = ?')
      .run(toBlob(axis(0)), 'memory', memoryEntry.id);
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    const results = await handleRecall({ cortex: CORTEX, query: 'observation', kind: 'memory' });
    const ids = results.map(r => r.id);
    expect(ids).not.toContain(retroEntry.id);
    expect(ids).toContain(memoryEntry.id);
  });

  it('invalid --kind throws with clear error message', async () => {
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    await expect(handleRecall({ cortex: CORTEX, query: 'test', kind: 'invalid' }))
      .rejects.toThrow("error: kind must be one of memory, retro, event, got 'invalid'");
  });

  // ── --topic filter (topics_json column — migration 14) ──────────────

  it('--topic returns only entries whose topics_json contains the topic', async () => {
    const db = getCortexDb(CORTEX);
    try { db.prepare('ALTER TABLE memories ADD COLUMN topics_json TEXT').run(); } catch { /* already exists */ }
    const matchEntry = insertMemory(CORTEX, {
      ts: '2026-05-01T00:00:00.000Z', author: 'test',
      content: 'auth approach uses Ed25519',
    });
    const noMatchEntry = insertMemory(CORTEX, {
      ts: '2026-05-02T00:00:00.000Z', author: 'test', content: 'unrelated observation',
    });
    db.prepare('UPDATE memories SET embedding = ?, topics_json = ? WHERE id = ?')
      .run(toBlob(axis(0)), JSON.stringify(['auth', 'security']), matchEntry.id);
    db.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
      .run(toBlob(axis(0)), noMatchEntry.id);
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    const results = await handleRecall({ cortex: CORTEX, query: 'auth', topic: 'auth' });
    const ids = results.map(r => r.id);
    expect(ids).toContain(matchEntry.id);
    expect(ids).not.toContain(noMatchEntry.id);
  });

  it('--topic is case-insensitive (SECURITY matches stored security)', async () => {
    const db = getCortexDb(CORTEX);
    try { db.prepare('ALTER TABLE memories ADD COLUMN topics_json TEXT').run(); } catch { /* already exists */ }
    const matchEntry = insertMemory(CORTEX, {
      ts: '2026-05-01T00:00:00.000Z', author: 'test', content: 'security topic entry',
    });
    db.prepare('UPDATE memories SET embedding = ?, topics_json = ? WHERE id = ?')
      .run(toBlob(axis(0)), JSON.stringify(['security']), matchEntry.id);
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    // Pass uppercase — should match because both sides use lower() before comparison.
    const results = await handleRecall({ cortex: CORTEX, query: 'security', topic: 'SECURITY' });
    expect(results.map(r => r.id)).toContain(matchEntry.id);
  });

  it('--topic returns populated topics array on each entry', async () => {
    const db = getCortexDb(CORTEX);
    try { db.prepare('ALTER TABLE memories ADD COLUMN topics_json TEXT').run(); } catch { /* already exists */ }
    const entry = insertMemory(CORTEX, {
      ts: '2026-05-01T00:00:00.000Z', author: 'test', content: 'deployment process entry',
    });
    db.prepare('UPDATE memories SET embedding = ?, topics_json = ? WHERE id = ?')
      .run(toBlob(axis(0)), JSON.stringify(['deploy', 'ci']), entry.id);
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    const results = await handleRecall({ cortex: CORTEX, query: 'deploy', topic: 'deploy' });
    expect(results).toHaveLength(1);
    expect(results[0].topics).toEqual(['deploy', 'ci']);
  });

  // ── --since filter ──────────────────────────────────────────

  it('--since filters out entries before the given date', async () => {
    const db = getCortexDb(CORTEX);
    const oldEntry = insertMemory(CORTEX, { ts: '2026-01-01T00:00:00.000Z', author: 'test', content: 'old entry from January' });
    const newEntry = insertMemory(CORTEX, { ts: '2026-05-01T00:00:00.000Z', author: 'test', content: 'new entry from May' });
    db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(toBlob(axis(0)), oldEntry.id);
    db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(toBlob(axis(0)), newEntry.id);
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    const results = await handleRecall({ cortex: CORTEX, query: 'entry', since: '2026-03-01' });
    const ids = results.map(r => r.id);
    expect(ids).not.toContain(oldEntry.id);
    expect(ids).toContain(newEntry.id);
  });

  it('--since with future date returns empty results', async () => {
    const db = getCortexDb(CORTEX);
    const entry = insertMemory(CORTEX, { ts: '2026-05-01T00:00:00.000Z', author: 'test', content: 'any content' });
    db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(toBlob(axis(0)), entry.id);
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    const results = await handleRecall({ cortex: CORTEX, query: 'content', since: '2030-01-01' });
    expect(results).toHaveLength(0);
  });

  it('invalid --since throws with clear error message', async () => {
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    await expect(handleRecall({ cortex: CORTEX, query: 'test', since: 'not-a-date' }))
      .rejects.toThrow('error: since must be an ISO-8601 date');
  });

  // ── all three filters combined ─────────────────────────────────────────

  it('--kind + --topic + --since combined returns only matching entries', async () => {
    const db = getCortexDb(CORTEX);
    try { db.prepare('ALTER TABLE memories ADD COLUMN topics_json TEXT').run(); } catch { /* already exists */ }

    // This entry matches all three filters.
    const matchEntry = insertMemory(CORTEX, { ts: '2026-05-10T00:00:00.000Z', author: 'test', content: 'recent retro about auth' });
    const wrongKind = insertMemory(CORTEX, { ts: '2026-05-10T00:00:00.000Z', author: 'test', content: 'recent memory about auth' });
    const wrongTopic = insertMemory(CORTEX, { ts: '2026-05-10T00:00:00.000Z', author: 'test', content: 'recent retro about deploy' });
    const tooOld = insertMemory(CORTEX, { ts: '2026-01-01T00:00:00.000Z', author: 'test', content: 'old retro about auth' });

    db.prepare('UPDATE memories SET embedding = ?, kind = ?, topics_json = ? WHERE id = ?')
      .run(toBlob(axis(0)), 'retro', JSON.stringify(['auth', 'security']), matchEntry.id);
    db.prepare('UPDATE memories SET embedding = ?, kind = ?, topics_json = ? WHERE id = ?')
      .run(toBlob(axis(0)), 'memory', JSON.stringify(['auth']), wrongKind.id);
    db.prepare('UPDATE memories SET embedding = ?, kind = ?, topics_json = ? WHERE id = ?')
      .run(toBlob(axis(0)), 'retro', JSON.stringify(['deploy']), wrongTopic.id);
    db.prepare('UPDATE memories SET embedding = ?, kind = ?, topics_json = ? WHERE id = ?')
      .run(toBlob(axis(0)), 'retro', JSON.stringify(['auth']), tooOld.id);

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    const results = await handleRecall({
      cortex: CORTEX, query: 'auth retro', kind: 'retro', topic: 'auth', since: '2026-03-01',
    });
    const ids = results.map(r => r.id);
    expect(ids).toContain(matchEntry.id);
    expect(ids).not.toContain(wrongKind.id);
    expect(ids).not.toContain(wrongTopic.id);
    expect(ids).not.toContain(tooOld.id);
  });

  // ── full entry shape (Bug 2 fix) ──────────────────────────────────────────

  it('recall result includes activity_seq, compacted_from, supersedes fields', async () => {
    const db = getCortexDb(CORTEX);
    const entry = insertMemory(CORTEX, {
      ts: '2026-05-01T00:00:00.000Z', author: 'test', content: 'shape test entry',
    });
    db.prepare('UPDATE memories SET embedding = ?, kind = ? WHERE id = ?')
      .run(toBlob(axis(0)), 'memory', entry.id);
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    const results = await handleRecall({ cortex: CORTEX, query: 'shape test' });
    expect(results).toHaveLength(1);
    const r = results[0];
    expect('activity_seq' in r).toBe(true);
    expect('compacted_from' in r).toBe(true);
    expect('supersedes' in r).toBe(true);
    // For a raw entry with no compaction_links, compacted_from is null and supersedes is []
    expect(r.compacted_from).toBeNull();
    expect(r.supersedes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// validateKind / validateSince unit tests
// ---------------------------------------------------------------------------

describe('validateKind (AGT-320)', () => {
  it('accepts memory', () => expect(() => validateKind('memory')).not.toThrow());
  it('accepts retro',  () => expect(() => validateKind('retro')).not.toThrow());
  it('accepts event',  () => expect(() => validateKind('event')).not.toThrow());
  it('rejects invalid value', () => {
    expect(() => validateKind('note')).toThrow("error: kind must be one of memory, retro, event, got 'note'");
  });
  it('rejects empty string', () => {
    expect(() => validateKind('')).toThrow('error: kind must be one of memory, retro, event');
  });
});

describe('validateSince (AGT-320)', () => {
  it('accepts date-only', () => expect(() => validateSince('2026-05-01')).not.toThrow());
  it('accepts full ISO-8601 with Z', () => expect(() => validateSince('2026-05-01T00:00:00Z')).not.toThrow());
  it('accepts full ISO-8601 with offset', () => expect(() => validateSince('2026-05-01T00:00:00+05:30')).not.toThrow());
  it('rejects plain text', () => {
    expect(() => validateSince('not-a-date')).toThrow('error: since must be an ISO-8601 date');
  });
  it('rejects partial string', () => {
    expect(() => validateSince('2026-05')).toThrow('error: since must be an ISO-8601 date');
  });
  it('rejects empty string', () => {
    expect(() => validateSince('')).toThrow('error: since must be an ISO-8601 date');
  });
});
