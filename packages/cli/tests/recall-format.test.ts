/**
 * Golden-output test for recall default formatting — AGT-318.
 *
 * Captures the exact string produced by formatRecallOutput for 3
 * representative recall results and asserts it byte-for-byte.
 * If the format changes intentionally, update the golden fixture below.
 */

import { describe, it, expect } from 'vitest';
import {
  formatRecallOutput,
  cortexSet,
  truncateUnicode,
  DEFAULT_RECALL_LIMIT,
} from '../src/lib/recall-format.js';
import type { RecallEntry } from '../src/daemon/recall.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal RecallEntry factory — only fields the formatter uses. */
function entry(
  overrides: Partial<RecallEntry> & Pick<RecallEntry, 'id' | 'ts' | 'kind' | 'content' | 'cortex'>,
): RecallEntry {
  return {
    topics: [],
    similarity: 0,
    score: 0,
    activity_seq: null,
    compacted_from: null,
    supersedes: [],
    ...overrides,
  };
}

// Three representative entries (one per kind).
const RETRO_ENTRY = entry({
  id: 'r1',
  ts: '2026-05-01T12:00:00Z',
  kind: 'retro',
  content: 'Always run npm run build before committing to catch type errors early.',
  cortex: 'think-cli',
});

const EVENT_ENTRY = entry({
  id: 'e1',
  ts: '2026-05-10T08:30:00Z',
  kind: 'event',
  content: 'Shipped AGT-307: cortex provenance on every recall result.',
  cortex: 'think-cli',
});

const MEMORY_ENTRY = entry({
  id: 'm1',
  ts: '2026-05-15T20:45:00Z',
  kind: 'memory',
  content: 'Vector recall is sub-100ms because the embedding model is resident in the daemon.',
  cortex: 'think-cli',
});

const THREE_ENTRIES = [RETRO_ENTRY, EVENT_ENTRY, MEMORY_ENTRY];

// ---------------------------------------------------------------------------
// Golden output tests
// ---------------------------------------------------------------------------

describe('formatRecallOutput — golden output (AGT-318)', () => {
  it('single-cortex: retro then event then memory, no truncation needed', () => {
    const cortexes = cortexSet(THREE_ENTRIES);
    const out = formatRecallOutput(THREE_ENTRIES, cortexes);
    const expected = [
      '── retros (1) ──',
      '2026-05-01  [retro]  Always run npm run build before committing to catch type errors early.',
      '',
      '── events (1) ──',
      '2026-05-10  [event]  Shipped AGT-307: cortex provenance on every recall result.',
      '',
      '── memories (1) ──',
      '2026-05-15  [memory]  Vector recall is sub-100ms because the embedding model is resident in the daemon.',
    ].join('\n');
    expect(out).toBe(expected);
  });

  it('multi-cortex: cortex name included in each entry tag', () => {
    const retroA = entry({ id: 'r1', ts: '2026-04-01T00:00:00Z', kind: 'retro', content: 'retro from cortex-a', cortex: 'cortex-a' });
    const memoryB = entry({ id: 'm1', ts: '2026-04-02T00:00:00Z', kind: 'memory', content: 'memory from cortex-b', cortex: 'cortex-b' });
    const entries = [retroA, memoryB];
    const cortexes = cortexSet(entries);
    const out = formatRecallOutput(entries, cortexes);
    const expected = [
      '── retros (1) ──',
      '2026-04-01  [cortex-a/retro]  retro from cortex-a',
      '',
      '── memories (1) ──',
      '2026-04-02  [cortex-b/memory]  memory from cortex-b',
    ].join('\n');
    expect(out).toBe(expected);
  });

  it('empty results: note: no entries matched in <cortex>', () => {
    const out = formatRecallOutput([], new Set(['think-cli']), {});
    expect(out).toBe('note: no entries matched in think-cli');
  });
});

// ---------------------------------------------------------------------------
// truncateUnicode edge cases
// ---------------------------------------------------------------------------

describe('truncateUnicode', () => {
  it('short string returned unchanged', () => {
    expect(truncateUnicode('hello', 200)).toBe('hello');
  });

  it('string exactly at limit returned unchanged', () => {
    const s = 'a'.repeat(200);
    expect(truncateUnicode(s, 200)).toBe(s);
  });

  it('string over limit is truncated at unicode scalar boundary with ellipsis', () => {
    const s = 'a'.repeat(201);
    const result = truncateUnicode(s, 200);
    expect([...result].length).toBe(201); // 200 chars + ellipsis char
    expect(result.endsWith('…')).toBe(true);
  });

  it('emoji counted as 1 scalar value, not 2 code units', () => {
    // Each emoji is 2 UTF-16 code units but 1 Unicode scalar value.
    const emoji = '🔥'; // fire emoji
    const s = emoji.repeat(200);
    // s.length is 400 (code units), but scalar count is 200
    const result = truncateUnicode(s, 200);
    // Should NOT be truncated: exactly 200 scalars
    expect(result).toBe(s);
  });

  it('emoji string over scalar limit truncated correctly', () => {
    const emoji = '🔥'; // fire emoji
    const s = emoji.repeat(201);
    const result = truncateUnicode(s, 200);
    expect(result.endsWith('…')).toBe(true);
    expect([...result].length).toBe(201); // 200 scalars + ellipsis
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_RECALL_LIMIT
// ---------------------------------------------------------------------------

describe('DEFAULT_RECALL_LIMIT', () => {
  it('is 8', () => {
    expect(DEFAULT_RECALL_LIMIT).toBe(8);
  });
});
