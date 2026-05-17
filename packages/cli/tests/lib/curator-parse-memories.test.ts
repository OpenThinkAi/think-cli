import { describe, it, expect } from 'vitest';
import { parseMemoriesJsonl } from '../../src/lib/curator.js';

describe('parseMemoriesJsonl — kind discriminator (AGT-266)', () => {
  it('defaults missing kind to "memory" for v2-shaped entries', () => {
    const v2Line = JSON.stringify({
      ts: '2026-05-12T19:00:00Z',
      author: 'Matt',
      content: 'shipped a thing',
      source_ids: ['e1'],
    });
    const [entry] = parseMemoriesJsonl(v2Line);
    expect(entry.kind).toBe('memory');
    expect(entry.content).toBe('shipped a thing');
  });

  it('propagates each of the three v3 kinds when present', () => {
    const lines = [
      { ts: 't1', author: 'a', content: 'm', source_ids: [], kind: 'memory' },
      { ts: 't2', author: 'a', content: 'r', source_ids: [], kind: 'retro' },
      { ts: 't3', author: 'a', content: 'e', source_ids: [], kind: 'event' },
    ]
      .map(o => JSON.stringify(o))
      .join('\n');
    const entries = parseMemoriesJsonl(lines);
    expect(entries.map(e => e.kind)).toEqual(['memory', 'retro', 'event']);
  });

  it('falls back to "memory" on off-spec kind values', () => {
    const line = JSON.stringify({
      ts: 't',
      author: 'a',
      content: 'c',
      source_ids: [],
      kind: 'bogus',
    });
    const [entry] = parseMemoriesJsonl(line);
    expect(entry.kind).toBe('memory');
  });
});
