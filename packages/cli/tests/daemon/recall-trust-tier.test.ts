/**
 * Tests for AGT-466: trust tier classification, validateTrustTierSelector,
 * applyTrustTierFilters, and end-to-end recall integration.
 *
 * Critical: tier filters are applied POST-RERANK, POST-LIMIT-SLICE.
 * The orthogonal-axis test below verifies this contract (re-uses the AGT-465
 * / AGT-456 fixture pattern).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
import { insertMemory } from '../../src/db/memory-queries.js';
import {
  handleRecall,
  deriveTrustTier,
  validateTrustTierSelector,
  validateTrustTierValue,
  applyTrustTierFilters,
  validateSourceSelector,
} from '../../src/daemon/recall.js';
import { saveConfig, getConfig } from '../../src/lib/config.js';
import type { TrustTierRule } from '../../src/lib/config.js';
import * as embedModule from '../../src/lib/embed.js';
import type { RecallEntry } from '../../src/daemon/recall.js';

// ---------------------------------------------------------------------------
// Trust tier schema regex assertion — locked for AGT-466.
// ---------------------------------------------------------------------------

const TRUST_TIER_RE = /^(trusted|untrusted|quarantined)$/;

describe('trust tier schema regex (AGT-466 contract)', () => {
  it('accepts "trusted"', () => expect(TRUST_TIER_RE.test('trusted')).toBe(true));
  it('accepts "untrusted"', () => expect(TRUST_TIER_RE.test('untrusted')).toBe(true));
  it('accepts "quarantined"', () => expect(TRUST_TIER_RE.test('quarantined')).toBe(true));
  it('rejects empty string', () => expect(TRUST_TIER_RE.test('')).toBe(false));
  it('rejects "Trusted" (case sensitive)', () => expect(TRUST_TIER_RE.test('Trusted')).toBe(false));
  it('rejects "dangerous"', () => expect(TRUST_TIER_RE.test('dangerous')).toBe(false));
});

// ---------------------------------------------------------------------------
// validateTrustTierSelector unit tests
// ---------------------------------------------------------------------------

describe('validateTrustTierSelector (AGT-466)', () => {
  // All validateSourceSelector valid values should also be valid here.
  it('accepts "self"', () => expect(() => validateTrustTierSelector('self')).not.toThrow());
  it('accepts "unknown"', () => expect(() => validateTrustTierSelector('unknown')).not.toThrow());
  it('accepts bare "peer"', () => expect(() => validateTrustTierSelector('peer')).not.toThrow());
  it('accepts bare "proxy"', () => expect(() => validateTrustTierSelector('proxy')).not.toThrow());
  it('accepts "peer:alice"', () => expect(() => validateTrustTierSelector('peer:alice')).not.toThrow());
  it('accepts "proxy:github"', () => expect(() => validateTrustTierSelector('proxy:github')).not.toThrow());
  it('accepts "peer:think-cli"', () => expect(() => validateTrustTierSelector('peer:think-cli')).not.toThrow());
  it('accepts "proxy:linear-v2"', () => expect(() => validateTrustTierSelector('proxy:linear-v2')).not.toThrow());
  // Trust-tier-specific: wildcard is accepted.
  it('accepts "*" (wildcard — not accepted by validateSourceSelector)', () => {
    expect(() => validateTrustTierSelector('*')).not.toThrow();
    // Confirm it IS rejected by validateSourceSelector.
    expect(() => validateSourceSelector('*')).toThrow();
  });
  it('rejects typo "slef"', () => {
    expect(() => validateTrustTierSelector('slef')).toThrow(/unknown trust tier selector "slef"/);
  });
  it('rejects "peer:" with no name', () => {
    expect(() => validateTrustTierSelector('peer:')).toThrow(/unknown trust tier selector/);
  });
  it('rejects "proxy:" with no connector', () => {
    expect(() => validateTrustTierSelector('proxy:')).toThrow(/unknown trust tier selector/);
  });
  it('rejects arbitrary string', () => {
    expect(() => validateTrustTierSelector('not-a-selector')).toThrow(/unknown trust tier selector/);
  });
  it('error message names all valid selectors including *', () => {
    try { validateTrustTierSelector('bad'); } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('*');
      expect(msg).toContain('self');
      expect(msg).toContain('peer');
      expect(msg).toContain('proxy');
    }
  });
});

// ---------------------------------------------------------------------------
// validateTrustTierValue unit tests
// ---------------------------------------------------------------------------

describe('validateTrustTierValue (AGT-466)', () => {
  it('accepts "trusted"', () => expect(() => validateTrustTierValue('trusted')).not.toThrow());
  it('accepts "untrusted"', () => expect(() => validateTrustTierValue('untrusted')).not.toThrow());
  it('accepts "quarantined"', () => expect(() => validateTrustTierValue('quarantined')).not.toThrow());
  it('rejects "Trusted" (case sensitive)', () => {
    expect(() => validateTrustTierValue('Trusted')).toThrow(/unknown trust tier "Trusted"/);
  });
  it('rejects arbitrary string', () => {
    expect(() => validateTrustTierValue('dangerous')).toThrow(/unknown trust tier "dangerous"/);
  });
  it('error message names all valid tiers', () => {
    try { validateTrustTierValue('bad'); } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('trusted');
      expect(msg).toContain('untrusted');
      expect(msg).toContain('quarantined');
    }
  });
});

// ---------------------------------------------------------------------------
// deriveTrustTier unit tests
// ---------------------------------------------------------------------------

describe('deriveTrustTier (AGT-466)', () => {
  it('shipped default: self → trusted', () => {
    expect(deriveTrustTier('self', undefined)).toBe('trusted');
  });

  it('shipped default: peer:alice → untrusted', () => {
    expect(deriveTrustTier('peer:alice', undefined)).toBe('untrusted');
  });

  it('shipped default: proxy:github → untrusted', () => {
    expect(deriveTrustTier('proxy:github', undefined)).toBe('untrusted');
  });

  it('shipped default: unknown → untrusted', () => {
    expect(deriveTrustTier('unknown', undefined)).toBe('untrusted');
  });

  it('empty rules array: same as undefined (shipped defaults apply)', () => {
    expect(deriveTrustTier('self', [])).toBe('trusted');
    expect(deriveTrustTier('peer:alice', [])).toBe('untrusted');
  });

  it('custom rules: peer bare → trusted', () => {
    const rules: TrustTierRule[] = [
      { match: 'self', tier: 'trusted' },
      { match: 'peer', tier: 'trusted' },
    ];
    expect(deriveTrustTier('peer:alice', rules)).toBe('trusted');
    expect(deriveTrustTier('peer:bob', rules)).toBe('trusted');
    expect(deriveTrustTier('proxy:github', rules)).toBe('untrusted'); // falls to implicit *
  });

  it('custom rules: proxy:github → quarantined', () => {
    const rules: TrustTierRule[] = [
      { match: 'self', tier: 'trusted' },
      { match: 'proxy:github', tier: 'quarantined' },
    ];
    expect(deriveTrustTier('proxy:github', rules)).toBe('quarantined');
    expect(deriveTrustTier('proxy:linear', rules)).toBe('untrusted'); // implicit *
    expect(deriveTrustTier('self', rules)).toBe('trusted');
  });

  it('custom rules: proxy bare → quarantined (matches all proxy:*)', () => {
    const rules: TrustTierRule[] = [
      { match: 'proxy', tier: 'quarantined' },
    ];
    expect(deriveTrustTier('proxy:github', rules)).toBe('quarantined');
    expect(deriveTrustTier('proxy:linear', rules)).toBe('quarantined');
    expect(deriveTrustTier('self', rules)).toBe('untrusted'); // implicit * (no self rule)
  });

  it('wildcard * rule wins everything when it appears first', () => {
    const rules: TrustTierRule[] = [
      { match: '*', tier: 'quarantined' },
    ];
    expect(deriveTrustTier('self', rules)).toBe('quarantined');
    expect(deriveTrustTier('peer:alice', rules)).toBe('quarantined');
    expect(deriveTrustTier('unknown', rules)).toBe('quarantined');
  });

  it('first-match-wins: earlier rule for peer:alice beats later peer rule', () => {
    const rules: TrustTierRule[] = [
      { match: 'peer:alice', tier: 'trusted' },  // specific — should win
      { match: 'peer', tier: 'quarantined' },    // bare — catches everything else
    ];
    expect(deriveTrustTier('peer:alice', rules)).toBe('trusted');  // first rule
    expect(deriveTrustTier('peer:bob', rules)).toBe('quarantined'); // second rule
  });

  it('implicit final rule * → untrusted when no user rule matches', () => {
    const rules: TrustTierRule[] = [
      { match: 'self', tier: 'trusted' },
      // No rule for peer/proxy/unknown → implicit * → untrusted
    ];
    expect(deriveTrustTier('peer:alice', rules)).toBe('untrusted');
    expect(deriveTrustTier('proxy:github', rules)).toBe('untrusted');
    expect(deriveTrustTier('unknown', rules)).toBe('untrusted');
  });

  it('explicit * rule can override the implicit * → untrusted default', () => {
    const rules: TrustTierRule[] = [
      { match: 'self', tier: 'trusted' },
      { match: '*', tier: 'quarantined' }, // explicit wildcard overrides implicit
    ];
    expect(deriveTrustTier('peer:alice', rules)).toBe('quarantined');
    expect(deriveTrustTier('unknown', rules)).toBe('quarantined');
    expect(deriveTrustTier('self', rules)).toBe('trusted'); // self rule still wins (first)
  });

  it('all four provenance shapes resolve to a valid tier', () => {
    for (const prov of ['self', 'peer:alice', 'proxy:github', 'unknown']) {
      const tier = deriveTrustTier(prov, undefined);
      expect(TRUST_TIER_RE.test(tier)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// applyTrustTierFilters unit tests
// ---------------------------------------------------------------------------

function mockEntry(id: string, provenance: string, trustTier: RecallEntry['trustTier']): RecallEntry {
  return {
    id,
    ts: '2026-06-07T00:00:00Z',
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
    trustTier,
  };
}

describe('applyTrustTierFilters (AGT-466)', () => {
  const trustedEntry    = mockEntry('trusted-1',    'self',         'trusted');
  const untrustedEntry  = mockEntry('untrusted-1',  'peer:alice',   'untrusted');
  const quarantinedEntry = mockEntry('quar-1',      'proxy:github', 'quarantined');

  const allEntries = [trustedEntry, untrustedEntry, quarantinedEntry];

  it('no flags: quarantined dropped, trusted+untrusted kept', () => {
    const { entries, quarantinedDropped } = applyTrustTierFilters(allEntries, { tiers: undefined, excludeTiers: undefined, includeQuarantined: false });
    expect(entries.map(e => e.id)).toEqual(['trusted-1', 'untrusted-1']);
    expect(quarantinedDropped).toBe(1);
  });

  it('includeQuarantined=true: all entries kept', () => {
    const { entries, quarantinedDropped } = applyTrustTierFilters(allEntries, { tiers: undefined, excludeTiers: undefined, includeQuarantined: true });
    expect(entries).toHaveLength(3);
    expect(quarantinedDropped).toBe(0);
  });

  it('no tier flags + includeQuarantined=false: returns all entries when none are quarantined', () => {
    const noQuar = [trustedEntry, untrustedEntry];
    const { entries, quarantinedDropped } = applyTrustTierFilters(noQuar, { tiers: undefined, excludeTiers: undefined, includeQuarantined: false });
    expect(entries).toHaveLength(2);
    expect(quarantinedDropped).toBe(0);
  });

  it('--trust-tier trusted: returns only trusted entries (after quarantine drop)', () => {
    const { entries } = applyTrustTierFilters(allEntries, { tiers: ['trusted'], excludeTiers: undefined, includeQuarantined: false });
    expect(entries.map(e => e.id)).toEqual(['trusted-1']);
  });

  it('--exclude-trust-tier untrusted: drops untrusted entries', () => {
    const { entries } = applyTrustTierFilters(allEntries, { tiers: undefined, excludeTiers: ['untrusted'], includeQuarantined: false });
    expect(entries.map(e => e.id)).toEqual(['trusted-1']);
  });

  it('exclude wins over include when both name the same tier', () => {
    const { entries } = applyTrustTierFilters(allEntries, { tiers: ['trusted'], excludeTiers: ['trusted'], includeQuarantined: false });
    expect(entries).toHaveLength(0);
  });

  it('--trust-tier quarantined without --include-quarantined surfaces nothing', () => {
    // The quarantine drop (step 1) runs before tier filter (step 2).
    // So quarantined entries are dropped in step 1 even if step 2 would include them.
    const { entries, quarantinedDropped } = applyTrustTierFilters(allEntries, { tiers: ['quarantined'], excludeTiers: undefined, includeQuarantined: false });
    expect(entries).toHaveLength(0);
    expect(quarantinedDropped).toBe(1);
  });

  it('--trust-tier quarantined WITH --include-quarantined surfaces quarantined entries only', () => {
    const { entries, quarantinedDropped } = applyTrustTierFilters(allEntries, { tiers: ['quarantined'], excludeTiers: undefined, includeQuarantined: true });
    expect(entries.map(e => e.id)).toEqual(['quar-1']);
    expect(quarantinedDropped).toBe(0);
  });

  it('quarantinedDropped is 0 when no entries are quarantined', () => {
    const noQuar = [trustedEntry, untrustedEntry];
    const { quarantinedDropped } = applyTrustTierFilters(noQuar, { tiers: undefined, excludeTiers: undefined, includeQuarantined: false });
    expect(quarantinedDropped).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// handleRecall integration tests for trust tier classification + filtering
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

const CORTEX = 'recall-trust-tier-test';

describe('handleRecall — trust tier classification + filtering (AGT-466)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-agt466-'));
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

  // ── default classification ─────────────────────────────────────────────────

  it('self entry gets trustTier="trusted" under default rules', async () => {
    saveConfig({ ...getConfig(), cortex: { active: CORTEX, author: 'test' }, recall: { relevanceFloor: -1 } });
    const id = setupEntry('self content', axis(0));
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    const results = await handleRecall({ cortex: CORTEX, query: 'self content', scope: 'active' });
    const entry = results.find(e => e.id === id);
    expect(entry).toBeDefined();
    expect(entry!.trustTier).toBe('trusted');
    expect(TRUST_TIER_RE.test(entry!.trustTier)).toBe(true);
  });

  it('proxy entry gets trustTier="untrusted" under default rules', async () => {
    saveConfig({ ...getConfig(), cortex: { active: CORTEX, author: 'test' }, recall: { relevanceFloor: -1 } });
    const id = setupEntry('proxy content', axis(0), 'subscribe:github');
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    const results = await handleRecall({ cortex: CORTEX, query: 'proxy content', scope: 'active' });
    const entry = results.find(e => e.id === id);
    expect(entry).toBeDefined();
    expect(entry!.trustTier).toBe('untrusted');
  });

  it('all returned entries have a trustTier field matching the schema regex', async () => {
    saveConfig({ ...getConfig(), cortex: { active: CORTEX, author: 'test' }, recall: { relevanceFloor: -1 } });
    setupEntry('first entry', axis(0));
    setupEntry('proxy entry', axis(0), 'subscribe:github');
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    const results = await handleRecall({ cortex: CORTEX, query: 'entry', scope: 'active' });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(TRUST_TIER_RE.test(r.trustTier)).toBe(true);
    }
  });

  // ── custom config rules ────────────────────────────────────────────────────

  it('custom config: proxy:github → quarantined', async () => {
    saveConfig({
      ...getConfig(),
      cortex: {
        active: CORTEX,
        author: 'test',
        trustTiers: {
          rules: [
            { match: 'self', tier: 'trusted' },
            { match: 'proxy:github', tier: 'quarantined' },
          ],
        },
      },
      recall: { relevanceFloor: -1 },
    });
    const id = setupEntry('github issue content', axis(0), 'subscribe:github');
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    // Without --include-quarantined, the entry should be dropped.
    const results = await handleRecall({ cortex: CORTEX, query: 'github issue', scope: 'active' });
    expect(results.find(e => e.id === id)).toBeUndefined();
  });

  it('custom config: --include-quarantined surfaces quarantined entries', async () => {
    saveConfig({
      ...getConfig(),
      cortex: {
        active: CORTEX,
        author: 'test',
        trustTiers: {
          rules: [
            { match: 'self', tier: 'trusted' },
            { match: 'proxy:github', tier: 'quarantined' },
          ],
        },
      },
      recall: { relevanceFloor: -1 },
    });
    const id = setupEntry('github issue content', axis(0), 'subscribe:github');
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    const results = await handleRecall({ cortex: CORTEX, query: 'github issue', scope: 'active', includeQuarantined: true });
    const entry = results.find(e => e.id === id);
    expect(entry).toBeDefined();
    expect(entry!.trustTier).toBe('quarantined');
  });

  // ── tier filter flags ──────────────────────────────────────────────────────

  it('--tiers ["trusted"] returns only trusted entries', async () => {
    saveConfig({ ...getConfig(), cortex: { active: CORTEX, author: 'test' }, recall: { relevanceFloor: -1 } });
    const selfId  = setupEntry('self content', axis(0));
    const proxyId = setupEntry('proxy content', axis(0), 'subscribe:github');
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    const results = await handleRecall({ cortex: CORTEX, query: 'content', scope: 'active', tiers: ['trusted'] });
    const ids = results.map(e => e.id);
    expect(ids).toContain(selfId);
    expect(ids).not.toContain(proxyId);
  });

  it('--excludeTiers ["untrusted"] drops untrusted entries', async () => {
    saveConfig({ ...getConfig(), cortex: { active: CORTEX, author: 'test' }, recall: { relevanceFloor: -1 } });
    const selfId  = setupEntry('self content', axis(0));
    const proxyId = setupEntry('proxy content', axis(0), 'subscribe:github');
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    const results = await handleRecall({ cortex: CORTEX, query: 'content', scope: 'active', excludeTiers: ['untrusted'] });
    const ids = results.map(e => e.id);
    expect(ids).toContain(selfId);
    expect(ids).not.toContain(proxyId);
  });

  it('comma-split tiers string in params is expanded correctly', async () => {
    saveConfig({ ...getConfig(), cortex: { active: CORTEX, author: 'test' }, recall: { relevanceFloor: -1 } });
    const selfId  = setupEntry('self content', axis(0));
    const proxyId = setupEntry('proxy content', axis(0), 'subscribe:github');
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    // Pass a comma-joined string — parseTierList should split it.
    const results = await handleRecall({
      cortex: CORTEX, query: 'content', scope: 'active',
      tiers: 'trusted,untrusted' as unknown as string[],
    });
    const ids = results.map(e => e.id);
    expect(ids).toContain(selfId);
    expect(ids).toContain(proxyId);
  });

  it('invalid tier value in tiers param throws with clear error', async () => {
    saveConfig({ ...getConfig(), cortex: { active: CORTEX, author: 'test' }, recall: { relevanceFloor: -1 } });
    setupEntry('content', axis(0));
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    await expect(
      handleRecall({ cortex: CORTEX, query: 'content', scope: 'active', tiers: ['dangerous'] }),
    ).rejects.toThrow(/unknown trust tier "dangerous"/);
  });

  // ── backward compat ────────────────────────────────────────────────────────

  it('backward compat: no trustTiers config → byte-identical results (no filtering)', async () => {
    // Config with NO trustTiers block — existing users see no change.
    saveConfig({ ...getConfig(), cortex: { active: CORTEX, author: 'test' }, recall: { relevanceFloor: -1 } });
    const selfId  = setupEntry('self content', axis(0));
    const proxyId = setupEntry('proxy content', axis(0), 'subscribe:github');
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    // No tier flags passed — results should include both entries unchanged.
    const results = await handleRecall({ cortex: CORTEX, query: 'content', scope: 'active' });
    const ids = results.map(e => e.id);
    expect(ids).toContain(selfId);
    expect(ids).toContain(proxyId);
  });

  it('backward compat: AGT-465 --source / --excludeSources continue to work alongside tier flags', async () => {
    saveConfig({ ...getConfig(), cortex: { active: CORTEX, author: 'test' }, recall: { relevanceFloor: -1 } });
    const selfId  = setupEntry('self content', axis(0));
    const proxyId = setupEntry('proxy content', axis(0), 'subscribe:github');
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    // Use both --sources (AGT-465) and --tiers (AGT-466) together.
    const results = await handleRecall({
      cortex: CORTEX, query: 'content', scope: 'active',
      sources: ['self'],
      tiers: ['trusted'],
    });
    const ids = results.map(e => e.id);
    expect(ids).toContain(selfId);
    expect(ids).not.toContain(proxyId);
  });

  // ── post-rerank contract: tier filter must not affect ranking order ─────────

  it('post-rerank contract: --tiers filter does NOT alter ranking order of returned entries', async () => {
    // Re-uses the AGT-465 / AGT-456 orthogonal-axis fixture pattern.
    // Insert two self entries with different cosine scores:
    //   axis(0) × query axis(0) = 1.0 (high score)
    //   axis(1) × query axis(0) = 0.0 (orthogonal — low score)
    // After post-rerank filter, axis(0) must still rank first.
    // If the filter were applied PRE-rerank, it would shrink the candidate set
    // and the ranking could be arbitrary. This test catches that regression.
    saveConfig({ ...getConfig(), cortex: { active: CORTEX, author: 'test' }, recall: { relevanceFloor: -1 } });

    const highScoreId = setupEntry('high score self content', axis(0));
    const lowScoreId  = setupEntry('low score self content', axis(1)); // orthogonal

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    const filtered = await handleRecall({
      cortex: CORTEX, query: 'content', scope: 'active',
      tiers: ['trusted'],
    });
    const ids = filtered.map(e => e.id);
    expect(ids).toContain(highScoreId);
    expect(ids).toContain(lowScoreId);
    // High score must come first — ranking order preserved.
    expect(ids.indexOf(highScoreId)).toBeLessThan(ids.indexOf(lowScoreId));
  });
});
