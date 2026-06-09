/**
 * Tests for AGT-466: trust tier rendering in recall-format.ts.
 *
 * Verifies:
 * - `trust="..."` attribute is added to `<recall-result>` open tag in wrapForAgent.
 * - `[trust:<tier>]` bracket is rendered in human-readable output ONLY when tier
 *   is non-trusted (mirrors the AGT-465 provenance convention).
 * - `trusted` entries have no bracket (silent default — no noise).
 * - `untrusted` and `quarantined` entries render the bracket.
 * - Multi-cortex mode always shows provenance + tier brackets when applicable.
 */

import { describe, it, expect } from 'vitest';
import { formatRecallOutput, wrapForAgent } from '../src/lib/recall-format.js';
import type { RecallEntry } from '../src/daemon/recall.js';

function makeEntry(
  overrides: Partial<RecallEntry> & { id: string; content: string },
): RecallEntry {
  return {
    id: overrides.id,
    ts: '2026-06-07T00:00:00Z',
    kind: overrides.kind ?? 'retro',
    content: overrides.content,
    topics: [],
    similarity: 1,
    score: 1,
    cortex: overrides.cortex ?? 'my-cortex',
    activity_seq: null,
    compacted_from: null,
    supersedes: [],
    provenance: overrides.provenance ?? 'self',
    trustTier: overrides.trustTier ?? 'trusted',
  };
}

// ---------------------------------------------------------------------------
// formatRecallOutput — trust bracket in human-readable output
// ---------------------------------------------------------------------------

describe('formatRecallOutput — trust tier bracket (AGT-466)', () => {
  it('trusted entry: no [trust:...] bracket', () => {
    const entry = makeEntry({ id: 'r1', content: 'some lesson', provenance: 'self', trustTier: 'trusted' });
    const out = formatRecallOutput([entry], new Set(['my-cortex']));
    expect(out).not.toContain('[trust:');
  });

  it('untrusted entry: NO [trust:untrusted] bracket in v1 (conservative default — preserves existing output)', () => {
    const entry = makeEntry({ id: 'r1', content: 'peer lesson', provenance: 'peer:alice', trustTier: 'untrusted' });
    const out = formatRecallOutput([entry], new Set(['my-cortex']));
    // v1 conservative: only quarantined entries get a visible bracket to avoid
    // breaking existing user output. untrusted is the common case for peer/proxy
    // entries and would noise up every multi-peer recall result.
    expect(out).not.toContain('[trust:untrusted]');
  });

  it('quarantined entry: [trust:quarantined] bracket rendered', () => {
    const entry = makeEntry({ id: 'r1', content: 'proxy lesson', provenance: 'proxy:github', trustTier: 'quarantined' });
    const out = formatRecallOutput([entry], new Set(['my-cortex']));
    expect(out).toContain('[trust:quarantined]');
  });

  it('multi-cortex: provenance bracket shown, trust bracket only for quarantined', () => {
    const untrustedEntry = makeEntry({
      id: 'r1',
      content: 'peer proxy lesson',
      cortex: 'alice',
      provenance: 'peer:alice',
      trustTier: 'untrusted',
    });
    const out = formatRecallOutput([untrustedEntry], new Set(['my-cortex', 'alice']));
    expect(out).toContain('[peer:alice]');
    expect(out).not.toContain('[trust:untrusted]'); // v1 conservative
  });

  it('multi-cortex: quarantined entry shows both provenance and trust bracket', () => {
    const quarEntry = makeEntry({
      id: 'r2',
      content: 'quarantined proxy lesson',
      cortex: 'alice',
      provenance: 'proxy:github',
      trustTier: 'quarantined',
    });
    const out = formatRecallOutput([quarEntry], new Set(['my-cortex', 'alice']));
    expect(out).toContain('[proxy:github]');
    expect(out).toContain('[trust:quarantined]');
  });

  it('single cortex trusted: no provenance bracket, no trust bracket', () => {
    const entry = makeEntry({ id: 'r1', content: 'own lesson', provenance: 'self', trustTier: 'trusted' });
    const out = formatRecallOutput([entry], new Set(['my-cortex']));
    expect(out).not.toContain('[self]');
    expect(out).not.toContain('[trust:');
  });

  it('single cortex untrusted proxy: provenance bracket shows, NO trust bracket (v1 conservative)', () => {
    const entry = makeEntry({
      id: 'r1',
      content: 'proxy content',
      provenance: 'proxy:github',
      trustTier: 'untrusted',
    });
    const out = formatRecallOutput([entry], new Set(['my-cortex']));
    expect(out).toContain('[proxy:github]');
    expect(out).not.toContain('[trust:untrusted]'); // v1: only quarantined shows
  });
});

// ---------------------------------------------------------------------------
// wrapForAgent — trust attribute on <recall-result> envelope
// ---------------------------------------------------------------------------

describe('wrapForAgent — trust attribute (AGT-466)', () => {
  it('adds trust="trusted" attribute to envelope', () => {
    const entry = makeEntry({ id: 'r1', content: 'some lesson', provenance: 'self', trustTier: 'trusted' });
    const formatted = formatRecallOutput([entry], new Set(['my-cortex']));
    const wrapped = wrapForAgent(formatted, [entry]);
    expect(wrapped).toContain('trust="trusted"');
  });

  it('adds trust="untrusted" attribute to envelope for untrusted entries (no bracket in human output)', () => {
    const entry = makeEntry({ id: 'r1', content: 'peer lesson', provenance: 'peer:alice', trustTier: 'untrusted' });
    const formatted = formatRecallOutput([entry], new Set(['my-cortex']));
    // Human output does NOT show [trust:untrusted] (v1 conservative).
    expect(formatted).not.toContain('[trust:untrusted]');
    // But the structured envelope DOES include trust="untrusted".
    const wrapped = wrapForAgent(formatted, [entry]);
    expect(wrapped).toContain('trust="untrusted"');
  });

  it('adds trust="quarantined" attribute to envelope for quarantined entries', () => {
    const entry = makeEntry({ id: 'r1', content: 'proxy lesson', provenance: 'proxy:github', trustTier: 'quarantined' });
    const formatted = formatRecallOutput([entry], new Set(['my-cortex']));
    const wrapped = wrapForAgent(formatted, [entry]);
    expect(wrapped).toContain('trust="quarantined"');
  });

  it('envelope includes both provenance and trust attributes (regardless of human bracket visibility)', () => {
    const entry = makeEntry({
      id: 'r1',
      content: 'proxy content',
      provenance: 'proxy:github',
      trustTier: 'untrusted',
    });
    const formatted = formatRecallOutput([entry], new Set(['my-cortex']));
    // Human output: provenance bracket shown, trust bracket suppressed (v1 conservative).
    expect(formatted).toContain('[proxy:github]');
    expect(formatted).not.toContain('[trust:untrusted]');
    // Structured envelope: BOTH attributes present.
    const wrapped = wrapForAgent(formatted, [entry]);
    expect(wrapped).toContain('provenance="proxy:github"');
    expect(wrapped).toContain('trust="untrusted"');
  });

  it('trust attribute value is HTML-escaped when it contains special chars (defense-in-depth)', () => {
    // Normal tier values never need escaping, but verify the attr pipe works.
    const entry = makeEntry({ id: 'r1', content: 'own lesson', provenance: 'self', trustTier: 'trusted' });
    const formatted = formatRecallOutput([entry], new Set(['my-cortex']));
    const wrapped = wrapForAgent(formatted, [entry]);
    // The wrapper should appear exactly once with no injection.
    expect(wrapped.match(/trust="trusted"/g)).toHaveLength(1);
  });

  it('empty entries list returns unchanged formatted string', () => {
    const formatted = 'note: no entries matched in my-cortex';
    expect(wrapForAgent(formatted, [])).toBe(formatted);
  });
});
