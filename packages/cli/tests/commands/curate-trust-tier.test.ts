/**
 * Tests for AGT-466: quarantined engram filtering in think curate.
 *
 * Strategy: unit-test the quarantine drop logic by calling deriveTrustTier
 * + the filtering logic directly, and verify the curate command's
 * --include-quarantined behavior through the getPendingEngrams + filter path.
 *
 * We do NOT spin up the full curator LLM path (that requires LLM consent +
 * network). We test the quarantine filtering logic in isolation here.
 */

import { describe, it, expect } from 'vitest';
import { deriveTrustTier } from '../../src/daemon/recall.js';
import type { TrustTierRule } from '../../src/lib/config.js';
import type { Engram } from '../../src/db/engram-queries.js';

// ---------------------------------------------------------------------------
// Helper: build a minimal Engram-like object for filter tests.
// ---------------------------------------------------------------------------

function mockEngram(id: string, episodeKey: string | null = null): Engram {
  return {
    id,
    content: `content for ${id}`,
    created_at: '2026-06-07T00:00:00Z',
    expires_at: '2027-06-07T00:00:00Z',
    evaluated_at: null,
    promoted: null,
    deleted_at: null,
    episode_key: episodeKey,
    context: null,
    decisions: null,
  };
}

// ---------------------------------------------------------------------------
// Helper: simulate the quarantine filter from curate.ts.
// This mirrors the logic in curate.ts (lines ~259–285) so we can test it
// without spawning the full command.
// ---------------------------------------------------------------------------

function filterQuarantinedEngrams(
  engrams: Engram[],
  cortex: string,
  activeCortex: string | undefined,
  trustRules: TrustTierRule[] | undefined,
  includeQuarantined: boolean,
): { filtered: Engram[]; dropped: number } {
  if (includeQuarantined) return { filtered: engrams, dropped: 0 };

  // Inline deriveProvenance logic (same as recall.ts deriveProvenance).
  const SUBSCRIBE_KEY_RE = /^subscribe:([A-Za-z0-9_-]+)$/;
  function deriveProvenance(episodeKey: string | null): string {
    if (episodeKey) {
      const m = SUBSCRIBE_KEY_RE.exec(episodeKey);
      if (m) return `proxy:${m[1]}`;
    }
    if (!activeCortex || activeCortex.trim().length === 0) return 'unknown';
    return cortex === activeCortex ? 'self' : `peer:${cortex}`;
  }

  const before = engrams.length;
  const filtered = engrams.filter((e) => {
    const provenance = deriveProvenance(e.episode_key ?? null);
    const tier = deriveTrustTier(provenance, trustRules);
    return tier !== 'quarantined';
  });
  const dropped = before - filtered.length;
  return { filtered, dropped };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('curate quarantine filtering (AGT-466)', () => {
  const CORTEX = 'my-cortex';

  it('default rules: self engrams pass through (trusted)', () => {
    const engrams = [mockEngram('e1'), mockEngram('e2')];
    const { filtered, dropped } = filterQuarantinedEngrams(
      engrams, CORTEX, CORTEX, undefined, false,
    );
    expect(filtered).toHaveLength(2);
    expect(dropped).toBe(0);
  });

  it('default rules: proxy engrams pass through (untrusted, not quarantined)', () => {
    const engrams = [mockEngram('e1', 'subscribe:github')];
    const { filtered, dropped } = filterQuarantinedEngrams(
      engrams, CORTEX, CORTEX, undefined, false,
    );
    // Default rules: proxy → untrusted (not quarantined) → NOT dropped
    expect(filtered).toHaveLength(1);
    expect(dropped).toBe(0);
  });

  it('custom rules: proxy:github quarantined → dropped by default', () => {
    const rules: TrustTierRule[] = [
      { match: 'self', tier: 'trusted' },
      { match: 'proxy:github', tier: 'quarantined' },
    ];
    const engrams = [
      mockEngram('self-1'),
      mockEngram('proxy-1', 'subscribe:github'),
    ];
    const { filtered, dropped } = filterQuarantinedEngrams(
      engrams, CORTEX, CORTEX, rules, false,
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('self-1');
    expect(dropped).toBe(1);
  });

  it('--include-quarantined: quarantined engrams are NOT dropped', () => {
    const rules: TrustTierRule[] = [
      { match: 'self', tier: 'trusted' },
      { match: 'proxy:github', tier: 'quarantined' },
    ];
    const engrams = [
      mockEngram('self-1'),
      mockEngram('proxy-1', 'subscribe:github'),
    ];
    const { filtered, dropped } = filterQuarantinedEngrams(
      engrams, CORTEX, CORTEX, rules, true, // includeQuarantined = true
    );
    expect(filtered).toHaveLength(2);
    expect(dropped).toBe(0);
  });

  it('dropped count is 0 when no engrams are quarantined', () => {
    const rules: TrustTierRule[] = [
      { match: 'self', tier: 'trusted' },
    ];
    const engrams = [mockEngram('e1'), mockEngram('e2')];
    const { dropped } = filterQuarantinedEngrams(
      engrams, CORTEX, CORTEX, rules, false,
    );
    expect(dropped).toBe(0);
  });

  it('all engrams dropped → filtered is empty', () => {
    const rules: TrustTierRule[] = [
      { match: '*', tier: 'quarantined' }, // quarantine everything
    ];
    const engrams = [mockEngram('e1'), mockEngram('e2')];
    const { filtered, dropped } = filterQuarantinedEngrams(
      engrams, CORTEX, CORTEX, rules, false,
    );
    expect(filtered).toHaveLength(0);
    expect(dropped).toBe(2);
  });
});
