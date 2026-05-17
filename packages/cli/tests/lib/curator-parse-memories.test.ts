import { describe, it, expect } from 'vitest';
import { parseMemoriesJsonl } from '../../src/lib/curator.js';

describe('parseMemoriesJsonl — compaction fields (AGT-267)', () => {
  it('defaults compacted_from to null, supersedes to [], topics to [] for v2-shaped entries', () => {
    const v2Line = JSON.stringify({
      ts: '2026-05-12T19:00:00Z',
      author: 'Matt',
      content: 'shipped a thing',
      source_ids: ['e1'],
    });
    const [entry] = parseMemoriesJsonl(v2Line);
    expect(entry.compacted_from).toBeNull();
    expect(entry.supersedes).toEqual([]);
    expect(entry.topics).toEqual([]);
  });

  it('reads compacted_from as an array when present', () => {
    const line = JSON.stringify({
      ts: '2026-05-12T19:00:00Z',
      author: 'Matt',
      content: 'compacted entry',
      source_ids: [],
      compacted_from: ['raw-id-1', 'raw-id-2'],
      supersedes: ['old-id-1'],
      topics: ['infrastructure', 'k8s'],
    });
    const [entry] = parseMemoriesJsonl(line);
    expect(entry.compacted_from).toEqual(['raw-id-1', 'raw-id-2']);
    expect(entry.supersedes).toEqual(['old-id-1']);
    expect(entry.topics).toEqual(['infrastructure', 'k8s']);
  });

  it('coerces null compacted_from on the wire to null (raw entry)', () => {
    const line = JSON.stringify({
      ts: '2026-05-12T19:00:00Z',
      author: 'Matt',
      content: 'raw entry with explicit null',
      source_ids: [],
      compacted_from: null,
      supersedes: [],
      topics: [],
    });
    const [entry] = parseMemoriesJsonl(line);
    expect(entry.compacted_from).toBeNull();
  });
});

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
