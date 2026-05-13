import { describe, it, expect } from 'vitest';
import { extractFirstFencedBlock } from '../../src/lib/curator.js';

// AGT-222: Sonnet occasionally wraps the curation JSON in a fenced code block
// and appends prose commentary after the closing fence. The prior fence-strip
// anchored the closing fence at end-of-string, so trailing prose left the
// fence in place and `JSON.parse` choked. extractFirstFencedBlock scans for
// the first opening fence and takes everything up to the next closing fence,
// regardless of what surrounds the block.
describe('extractFirstFencedBlock (AGT-222)', () => {
  it('returns input trimmed when there is no fence', () => {
    expect(extractFirstFencedBlock('{"memories":[]}')).toBe('{"memories":[]}');
    expect(extractFirstFencedBlock('  {"a":1}  ')).toBe('{"a":1}');
  });

  it('strips a json-tagged fenced block with no surrounding content', () => {
    const input = '```json\n{"memories":[]}\n```';
    expect(extractFirstFencedBlock(input)).toBe('{"memories":[]}');
  });

  it('strips an untagged fenced block', () => {
    const input = '```\n{"memories":[]}\n```';
    expect(extractFirstFencedBlock(input)).toBe('{"memories":[]}');
  });

  it('strips a fenced block followed by prose commentary (the AGT-222 bug)', () => {
    const input = [
      '```json',
      '{"memories":[{"ts":"2026-05-12T00:00:00Z","content":"x","source_ids":["e1"]}],"purge_ids":[],"long_term_events":[]}',
      '```',
      '',
      'Note: I evaluated 3 engrams and promoted one. The other two are still maturing so I left them pending.',
    ].join('\n');
    const got = extractFirstFencedBlock(input);
    expect(() => JSON.parse(got)).not.toThrow();
    expect(JSON.parse(got).memories).toHaveLength(1);
  });

  it('strips a fenced block preceded by prose', () => {
    const input = [
      'Here is the curation result you asked for:',
      '```json',
      '{"memories":[],"purge_ids":[],"long_term_events":[]}',
      '```',
    ].join('\n');
    const got = extractFirstFencedBlock(input);
    expect(JSON.parse(got)).toEqual({ memories: [], purge_ids: [], long_term_events: [] });
  });

  it('strips a fenced block surrounded by prose on both sides', () => {
    const input = [
      'Sure thing.',
      '```json',
      '{"content":"a narrative"}',
      '```',
      'Let me know if you want me to redo it.',
    ].join('\n');
    const got = extractFirstFencedBlock(input);
    expect(JSON.parse(got)).toEqual({ content: 'a narrative' });
  });

  it('takes only the first fenced block when multiple are present', () => {
    const input = [
      '```json',
      '{"memories":[{"ts":"t1","content":"first","source_ids":[]}],"purge_ids":[],"long_term_events":[]}',
      '```',
      '',
      'And an alternate version:',
      '```json',
      '{"memories":[],"purge_ids":["e9"],"long_term_events":[]}',
      '```',
    ].join('\n');
    const got = extractFirstFencedBlock(input);
    const parsed = JSON.parse(got);
    expect(parsed.memories[0].content).toBe('first');
    expect(parsed.purge_ids).toEqual([]);
  });

  it('accepts language tags other than json (jsonc, json5, lowercase only)', () => {
    expect(extractFirstFencedBlock('```jsonc\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractFirstFencedBlock('```json5\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('falls back to content-after-opener when the closing fence is missing (truncated response)', () => {
    const input = '```json\n{"memories":[]}';
    expect(extractFirstFencedBlock(input)).toBe('{"memories":[]}');
  });

  it('returns plain text (for runConsolidation-style responses) when no fence is used', () => {
    const summary = 'Q2 focused on shipping the curator pipeline. Adoption of stamp-cli landed mid-quarter.';
    expect(extractFirstFencedBlock(summary)).toBe(summary);
  });

  it('strips fences around plain-text consolidation summaries', () => {
    const input = '```\nA concise paragraph summarising the quarter.\n```';
    expect(extractFirstFencedBlock(input)).toBe('A concise paragraph summarising the quarter.');
  });
});
