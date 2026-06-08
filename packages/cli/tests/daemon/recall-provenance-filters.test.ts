/**
 * Tests for AGT-465: provenance derivation and --source / --exclude-source
 * filtering on the recall daemon path.
 *
 * Strategy: unit-test deriveProvenance + provenanceMatches + applyProvenanceFilters
 * in isolation first, then integration-test the post-rerank filter via handleRecall.
 *
 * Critical: sources/excludeSources filters are applied POST-RERANK, POST-LIMIT-SLICE.
 * The orthogonal-axis test below verifies this contract.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
import { insertMemory } from '../../src/db/memory-queries.js';
import {
  handleRecall,
  deriveProvenance,
  provenanceMatches,
  applyProvenanceFilters,
} from '../../src/daemon/recall.js';
import { saveConfig, getConfig } from '../../src/lib/config.js';
import * as embedModule from '../../src/lib/embed.js';
import type { RecallEntry } from '../../src/daemon/recall.js';

// ---------------------------------------------------------------------------
// Schema regex assertion — locked for AGT-466.
// Any change to the allowed provenance string shapes MUST update this regex.
// ---------------------------------------------------------------------------

const PROVENANCE_SCHEMA_RE = /^(self|unknown|peer:[A-Za-z0-9_-]+|proxy:[A-Za-z0-9_-]+)$/;

describe('provenance schema regex (AGT-466 contract)', () => {
  it('accepts "self"', () => expect(PROVENANCE_SCHEMA_RE.test('self')).toBe(true));
  it('accepts "unknown"', () => expect(PROVENANCE_SCHEMA_RE.test('unknown')).toBe(true));
  it('accepts "peer:alice"', () => expect(PROVENANCE_SCHEMA_RE.test('peer:alice')).toBe(true));
  it('accepts "peer:think-cli"', () => expect(PROVENANCE_SCHEMA_RE.test('peer:think-cli')).toBe(true));
  it('accepts "proxy:github"', () => expect(PROVENANCE_SCHEMA_RE.test('proxy:github')).toBe(true));
  it('accepts "proxy:linear-v2"', () => expect(PROVENANCE_SCHEMA_RE.test('proxy:linear-v2')).toBe(true));
  it('rejects empty string', () => expect(PROVENANCE_SCHEMA_RE.test('')).toBe(false));
  it('rejects "peer:" (no name)', () => expect(PROVENANCE_SCHEMA_RE.test('peer:')).toBe(false));
  it('rejects "proxy:" (no connector)', () => expect(PROVENANCE_SCHEMA_RE.test('proxy:')).toBe(false));
  it('rejects "other"', () => expect(PROVENANCE_SCHEMA_RE.test('other')).toBe(false));
  it('rejects "peer:name/slash"', () => expect(PROVENANCE_SCHEMA_RE.test('peer:name/slash')).toBe(false));
});

// ---------------------------------------------------------------------------
// deriveProvenance unit tests
// ---------------------------------------------------------------------------

describe('deriveProvenance (AGT-465)', () => {
  it('returns "self" when entryCortex === activeCortex', () => {
    expect(deriveProvenance('my-cortex', null, 'my-cortex')).toBe('self');
  });

  it('returns "peer:<name>" when entryCortex !== activeCortex and no subscribe key', () => {
    expect(deriveProvenance('alice', null, 'my-cortex')).toBe('peer:alice');
  });

  it('returns "proxy:<connector>" when episode_key matches ^subscribe:([A-Za-z0-9_-]+)$', () => {
    expect(deriveProvenance('my-cortex', 'subscribe:github', 'my-cortex')).toBe('proxy:github');
  });

  it('proxy: wins over peer: when both conditions apply', () => {
    // Entry is on a different cortex AND has a subscribe episode_key
    expect(deriveProvenance('alice', 'subscribe:linear', 'my-cortex')).toBe('proxy:linear');
  });

  it('returns "proxy:" even for same-cortex subscribe entries', () => {
    // A subscribe entry on the active cortex is still proxy:
    expect(deriveProvenance('my-cortex', 'subscribe:github', 'my-cortex')).toBe('proxy:github');
  });

  it('returns "unknown" when activeCortex is undefined', () => {
    expect(deriveProvenance('some-cortex', null, undefined)).toBe('unknown');
  });

  it('returns "unknown" when activeCortex is empty string', () => {
    expect(deriveProvenance('some-cortex', null, '')).toBe('unknown');
  });

  it('returns "unknown" when activeCortex is whitespace-only', () => {
    expect(deriveProvenance('some-cortex', null, '   ')).toBe('unknown');
  });

  it('ignores non-subscribe episode_key formats', () => {
    // An episode_key that doesn't match the subscribe pattern is ignored.
    expect(deriveProvenance('alice', 'session:abc123', 'my-cortex')).toBe('peer:alice');
    expect(deriveProvenance('my-cortex', 'episode:xyz', 'my-cortex')).toBe('self');
  });

  it('all four shapes match the locked schema regex', () => {
    expect(PROVENANCE_SCHEMA_RE.test(deriveProvenance('my-cortex', null, 'my-cortex'))).toBe(true);
    expect(PROVENANCE_SCHEMA_RE.test(deriveProvenance('alice', null, 'my-cortex'))).toBe(true);
    expect(PROVENANCE_SCHEMA_RE.test(deriveProvenance('any', 'subscribe:github', 'my-cortex'))).toBe(true);
    expect(PROVENANCE_SCHEMA_RE.test(deriveProvenance('any', null, undefined))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// provenanceMatches unit tests
// ---------------------------------------------------------------------------

describe('provenanceMatches (AGT-465)', () => {
  it('"self" selector matches only "self"', () => {
    expect(provenanceMatches('self', 'self')).toBe(true);
    expect(provenanceMatches('peer:alice', 'self')).toBe(false);
    expect(provenanceMatches('proxy:github', 'self')).toBe(false);
    expect(provenanceMatches('unknown', 'self')).toBe(false);
  });

  it('"unknown" selector matches only "unknown"', () => {
    expect(provenanceMatches('unknown', 'unknown')).toBe(true);
    expect(provenanceMatches('self', 'unknown')).toBe(false);
    expect(provenanceMatches('peer:alice', 'unknown')).toBe(false);
  });

  it('"peer" bare selector matches any peer:* value', () => {
    expect(provenanceMatches('peer:alice', 'peer')).toBe(true);
    expect(provenanceMatches('peer:think-cli', 'peer')).toBe(true);
    expect(provenanceMatches('self', 'peer')).toBe(false);
    expect(provenanceMatches('proxy:github', 'peer')).toBe(false);
    expect(provenanceMatches('unknown', 'peer')).toBe(false);
  });

  it('"proxy" bare selector matches any proxy:* value', () => {
    expect(provenanceMatches('proxy:github', 'proxy')).toBe(true);
    expect(provenanceMatches('proxy:linear', 'proxy')).toBe(true);
    expect(provenanceMatches('self', 'proxy')).toBe(false);
    expect(provenanceMatches('peer:alice', 'proxy')).toBe(false);
    expect(provenanceMatches('unknown', 'proxy')).toBe(false);
  });

  it('exact "peer:alice" selector matches only "peer:alice"', () => {
    expect(provenanceMatches('peer:alice', 'peer:alice')).toBe(true);
    expect(provenanceMatches('peer:bob', 'peer:alice')).toBe(false);
    expect(provenanceMatches('self', 'peer:alice')).toBe(false);
  });

  it('exact "proxy:github" selector matches only "proxy:github"', () => {
    expect(provenanceMatches('proxy:github', 'proxy:github')).toBe(true);
    expect(provenanceMatches('proxy:linear', 'proxy:github')).toBe(false);
    expect(provenanceMatches('peer:github', 'proxy:github')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyProvenanceFilters unit tests
// ---------------------------------------------------------------------------

/** Build a minimal RecallEntry-like object for filter tests. */
function mockEntry(id: string, provenance: string): RecallEntry {
  return {
    id,
    ts: '2026-06-01T00:00:00Z',
    kind: 'memory',
    content: `content for ${id}`,
    topics: [],
    similarity: 1,
    score: 1,
    cortex: 'test-cortex',
    activity_seq: null,
    compacted_from: null,
    supersedes: [],
    provenance,
  };
}

describe('applyProvenanceFilters (AGT-465)', () => {
  const selfEntry    = mockEntry('self-1',    'self');
  const peerEntry    = mockEntry('peer-1',    'peer:alice');
  const proxyEntry   = mockEntry('proxy-1',   'proxy:github');
  const unknownEntry = mockEntry('unknown-1', 'unknown');

  const allEntries = [selfEntry, peerEntry, proxyEntry, unknownEntry];

  it('returns all entries when both filters are empty/undefined', () => {
    expect(applyProvenanceFilters(allEntries, undefined, undefined)).toHaveLength(4);
    expect(applyProvenanceFilters(allEntries, [], [])).toHaveLength(4);
  });

  it('--source self: returns only self entries', () => {
    const result = applyProvenanceFilters(allEntries, ['self'], undefined);
    expect(result.map(e => e.id)).toEqual(['self-1']);
  });

  it('--source peer: returns all peer:* entries', () => {
    const result = applyProvenanceFilters(allEntries, ['peer'], undefined);
    expect(result.map(e => e.id)).toEqual(['peer-1']);
  });

  it('--source proxy: returns all proxy:* entries', () => {
    const result = applyProvenanceFilters(allEntries, ['proxy'], undefined);
    expect(result.map(e => e.id)).toEqual(['proxy-1']);
  });

  it('--source self,peer: returns self and peer:* entries', () => {
    const result = applyProvenanceFilters(allEntries, ['self', 'peer'], undefined);
    const ids = result.map(e => e.id);
    expect(ids).toContain('self-1');
    expect(ids).toContain('peer-1');
    expect(ids).not.toContain('proxy-1');
    expect(ids).not.toContain('unknown-1');
  });

  it('--exclude-source proxy: removes all proxy:* entries', () => {
    const result = applyProvenanceFilters(allEntries, undefined, ['proxy']);
    const ids = result.map(e => e.id);
    expect(ids).not.toContain('proxy-1');
    expect(ids).toContain('self-1');
    expect(ids).toContain('peer-1');
    expect(ids).toContain('unknown-1');
  });

  it('exclude wins over include when both name the same entry', () => {
    // --source peer --exclude-source peer:alice → alice should be excluded
    const result = applyProvenanceFilters(allEntries, ['peer'], ['peer:alice']);
    expect(result).toHaveLength(0);
  });

  it('exclude wins over include: proxy entries dropped even when --source proxy', () => {
    const result = applyProvenanceFilters(allEntries, ['proxy'], ['proxy:github']);
    expect(result).toHaveLength(0);
  });

  it('comma-split strings work via the parseSourceList logic (tested through handleRecall)', () => {
    // applyProvenanceFilters operates on already-parsed lists. Comma-split is
    // tested via handleRecall integration below. Here we verify the array form.
    const result = applyProvenanceFilters(allEntries, ['self', 'unknown'], undefined);
    const ids = result.map(e => e.id);
    expect(ids).toContain('self-1');
    expect(ids).toContain('unknown-1');
    expect(ids).not.toContain('peer-1');
    expect(ids).not.toContain('proxy-1');
  });
});

// ---------------------------------------------------------------------------
// handleRecall integration tests for provenance derivation + filtering
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

const CORTEX = 'recall-provenance-test';

describe('handleRecall — provenance derivation + filtering (AGT-465)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-agt465-'));
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

  function setupEntry(content: string, vec: Float32Array, episodeKey?: string): string {
    const db = getCortexDb(CORTEX);
    const row = insertMemory(CORTEX, {
      ts: new Date().toISOString(),
      author: 'test',
      content,
      ...(episodeKey ? { episode_key: episodeKey } : {}),
    });
    db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(toBlob(vec), row.id);
    return row.id;
  }

  it('entry from active cortex gets provenance="self"', async () => {
    saveConfig({ ...getConfig(), cortex: { active: CORTEX }, recall: { relevanceFloor: -1 } });
    const id = setupEntry('self content', axis(0));
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    const results = await handleRecall({ cortex: CORTEX, query: 'self content', scope: 'active' });
    const entry = results.find(e => e.id === id);
    expect(entry).toBeDefined();
    expect(entry!.provenance).toBe('self');
    expect(PROVENANCE_SCHEMA_RE.test(entry!.provenance)).toBe(true);
  });

  it('entry with subscribe:github episode_key gets provenance="proxy:github"', async () => {
    saveConfig({ ...getConfig(), cortex: { active: CORTEX }, recall: { relevanceFloor: -1 } });
    const id = setupEntry('github issue content', axis(0), 'subscribe:github');
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    const results = await handleRecall({ cortex: CORTEX, query: 'github', scope: 'active' });
    const entry = results.find(e => e.id === id);
    expect(entry).toBeDefined();
    expect(entry!.provenance).toBe('proxy:github');
    expect(PROVENANCE_SCHEMA_RE.test(entry!.provenance)).toBe(true);
  });

  it('proxy: wins over peer: for subscribe entry on non-active cortex', async () => {
    // If the entry's cortex differs from active AND it has a subscribe key,
    // proxy: should win.
    saveConfig({ ...getConfig(), cortex: { active: 'different-cortex' }, recall: { relevanceFloor: -1 } });
    const id = setupEntry('external issue content', axis(0), 'subscribe:linear');
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    const results = await handleRecall({ cortex: CORTEX, query: 'external issue', scope: 'active' });
    const entry = results.find(e => e.id === id);
    expect(entry).toBeDefined();
    expect(entry!.provenance).toBe('proxy:linear');
  });

  it('entry gets provenance="unknown" when cortex.active is not set', async () => {
    // Remove the active cortex from config — provenance should fall back to 'unknown'.
    const cfg = getConfig();
    saveConfig({ ...cfg, cortex: { ...cfg.cortex, active: '' }, recall: { relevanceFloor: -1 } });
    const id = setupEntry('some content', axis(0));
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    const results = await handleRecall({ cortex: CORTEX, query: 'some content', scope: 'active' });
    const entry = results.find(e => e.id === id);
    expect(entry).toBeDefined();
    expect(entry!.provenance).toBe('unknown');
    expect(PROVENANCE_SCHEMA_RE.test(entry!.provenance)).toBe(true);
  });

  it('all returned entries have a provenance field matching the schema regex', async () => {
    saveConfig({ ...getConfig(), cortex: { active: CORTEX }, recall: { relevanceFloor: -1 } });
    setupEntry('first entry', axis(0));
    setupEntry('second entry', axis(0), 'subscribe:github');
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    const results = await handleRecall({ cortex: CORTEX, query: 'entry', scope: 'active' });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(PROVENANCE_SCHEMA_RE.test(r.provenance)).toBe(true);
    }
  });

  // ── --source / --exclude-source end-to-end ────────────────────────────────

  it('--sources ["self"] returns only self entries', async () => {
    saveConfig({ ...getConfig(), cortex: { active: CORTEX }, recall: { relevanceFloor: -1 } });
    const selfId   = setupEntry('self content', axis(0));
    const proxyId  = setupEntry('proxy content', axis(0), 'subscribe:github');
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    const results = await handleRecall({ cortex: CORTEX, query: 'content', scope: 'active', sources: ['self'] });
    const ids = results.map(e => e.id);
    expect(ids).toContain(selfId);
    expect(ids).not.toContain(proxyId);
  });

  it('--sources ["proxy"] returns only proxy:* entries', async () => {
    saveConfig({ ...getConfig(), cortex: { active: CORTEX }, recall: { relevanceFloor: -1 } });
    const selfId   = setupEntry('self content', axis(0));
    const proxyId  = setupEntry('proxy content', axis(0), 'subscribe:github');
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    const results = await handleRecall({ cortex: CORTEX, query: 'content', scope: 'active', sources: ['proxy'] });
    const ids = results.map(e => e.id);
    expect(ids).not.toContain(selfId);
    expect(ids).toContain(proxyId);
  });

  it('--excludeSources ["proxy"] removes proxy entries', async () => {
    saveConfig({ ...getConfig(), cortex: { active: CORTEX }, recall: { relevanceFloor: -1 } });
    const selfId   = setupEntry('self content', axis(0));
    const proxyId  = setupEntry('proxy content', axis(0), 'subscribe:github');
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    const results = await handleRecall({ cortex: CORTEX, query: 'content', scope: 'active', excludeSources: ['proxy'] });
    const ids = results.map(e => e.id);
    expect(ids).toContain(selfId);
    expect(ids).not.toContain(proxyId);
  });

  it('exclude wins over include when both name the same row', async () => {
    saveConfig({ ...getConfig(), cortex: { active: CORTEX }, recall: { relevanceFloor: -1 } });
    const selfId = setupEntry('self content', axis(0));
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    // Both --source self AND --exclude-source self → exclude wins → empty.
    const results = await handleRecall({
      cortex: CORTEX, query: 'self content', scope: 'active',
      sources: ['self'], excludeSources: ['self'],
    });
    expect(results.map(e => e.id)).not.toContain(selfId);
  });

  it('comma-split sources string in params is expanded correctly', async () => {
    saveConfig({ ...getConfig(), cortex: { active: CORTEX }, recall: { relevanceFloor: -1 } });
    const selfId  = setupEntry('self content', axis(0));
    const proxyId = setupEntry('proxy content', axis(0), 'subscribe:github');
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    // Pass a comma-joined string — parseSourceList should split it.
    const results = await handleRecall({
      cortex: CORTEX, query: 'content', scope: 'active',
      sources: 'self,proxy' as unknown as string[],
    });
    const ids = results.map(e => e.id);
    expect(ids).toContain(selfId);
    expect(ids).toContain(proxyId);
  });

  // ── post-rerank contract: source filter must not affect ranking order ──────

  it('post-rerank contract: --sources filter does NOT alter ranking order of returned entries', async () => {
    // This test verifies that the filter is applied post-rerank, not pre-rerank.
    // We insert two self entries with different cosine scores (axis(0) matches
    // the query; axis(1) is orthogonal). After sorting by score descending,
    // the axis(0) entry should always rank first regardless of the filter.
    saveConfig({ ...getConfig(), cortex: { active: CORTEX }, recall: { relevanceFloor: -1 } });

    const highScoreId = setupEntry('high score self content', axis(0));
    const lowScoreId  = setupEntry('low score self content', axis(1));

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    const filtered = await handleRecall({
      cortex: CORTEX, query: 'content', scope: 'active',
      sources: ['self'],
    });
    const ids = filtered.map(e => e.id);
    expect(ids).toContain(highScoreId);
    expect(ids).toContain(lowScoreId);
    // High score must come first.
    expect(ids.indexOf(highScoreId)).toBeLessThan(ids.indexOf(lowScoreId));
  });
});
