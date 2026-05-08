import { describe, it, expect } from 'vitest';
import { parseRetrosJsonl, serializeRetroForSync } from '../../src/lib/retro-jsonl.js';
import type { RetroRow } from '../../src/db/retro-queries.js';

function makeRow(overrides: Partial<RetroRow> = {}): RetroRow {
  return {
    id: '01923456-789a-7bcd-8def-0123456789ab',
    content: 'always wrap migrations in a transaction',
    kind: 'convention',
    cortex_name: 'test-cortex',
    created_at: '2026-05-08T12:00:00.000Z',
    occurrences: 1,
    tombstoned_at: null,
    tombstone_reason: null,
    sync_version: 1,
    promoted: 0,
    last_recalled_at: null,
    recalled_count: 0,
    origin_peer_id: 'peer-aaaa-1111',
    ...overrides,
  };
}

describe('serializeRetroForSync', () => {
  it('round-trips id, content, kind, created_at, occurrences, origin_peer_id', () => {
    const row = makeRow();
    const line = serializeRetroForSync(row);
    const [entry] = parseRetrosJsonl(line);
    expect(entry.id).toBe(row.id);
    expect(entry.content).toBe(row.content);
    expect(entry.kind).toBe(row.kind);
    expect(entry.created_at).toBe(row.created_at);
    expect(entry.occurrences).toBe(row.occurrences);
    expect(entry.origin_peer_id).toBe(row.origin_peer_id);
  });

  it('includes origin_peer_id only when set (omit-when-falsy)', () => {
    const withPeer = JSON.parse(serializeRetroForSync(makeRow({ origin_peer_id: 'peer-x' })));
    expect(withPeer.origin_peer_id).toBe('peer-x');

    const withoutPeer = JSON.parse(serializeRetroForSync(makeRow({ origin_peer_id: null })));
    expect('origin_peer_id' in withoutPeer).toBe(false);
  });

  it('omits local-only relegation signal from the wire format', () => {
    const wire = JSON.parse(serializeRetroForSync(makeRow({
      promoted: 1,
      last_recalled_at: '2026-05-09T00:00:00.000Z',
      recalled_count: 4,
      sync_version: 12,
    })));
    expect('promoted' in wire).toBe(false);
    expect('last_recalled_at' in wire).toBe(false);
    expect('recalled_count' in wire).toBe(false);
    expect('sync_version' in wire).toBe(false);
  });

  it('serializes tombstone_at + tombstone_reason when set', () => {
    const wire = JSON.parse(serializeRetroForSync(makeRow({
      tombstoned_at: '2026-05-09T00:00:00.000Z',
      tombstone_reason: 'merged_into:other-id',
    })));
    expect(wire.tombstoned_at).toBe('2026-05-09T00:00:00.000Z');
    expect(wire.tombstone_reason).toBe('merged_into:other-id');
  });
});

describe('parseRetrosJsonl', () => {
  it('returns empty array on empty/whitespace input', () => {
    expect(parseRetrosJsonl('')).toEqual([]);
    expect(parseRetrosJsonl('   \n  \n')).toEqual([]);
  });

  it('lands missing origin_peer_id as undefined (not re-stamped)', () => {
    const line = JSON.stringify({
      id: 'legacy-id',
      content: 'pre-v10 line with no origin',
      kind: null,
      created_at: '2026-05-08T00:00:00.000Z',
      occurrences: 1,
    });
    const [entry] = parseRetrosJsonl(line);
    expect(entry.origin_peer_id).toBeUndefined();
  });

  it('preserves wire-format origin_peer_id without re-stamping', () => {
    const externalPeer = 'peer-from-another-machine';
    const line = JSON.stringify({
      id: 'wire-id',
      content: 'cross-peer line',
      kind: 'invariant',
      created_at: '2026-05-08T00:00:00.000Z',
      occurrences: 2,
      origin_peer_id: externalPeer,
    });
    const [entry] = parseRetrosJsonl(line);
    expect(entry.origin_peer_id).toBe(externalPeer);
  });

  it('skips lines missing required fields (id, content, created_at)', () => {
    const lines = [
      JSON.stringify({ content: 'no id', created_at: 't' }),
      JSON.stringify({ id: 'x', created_at: 't' }), // no content
      JSON.stringify({ id: 'y', content: 'no created_at' }),
      JSON.stringify({ id: 'z', content: 'good', created_at: 't' }),
    ].join('\n');
    const entries = parseRetrosJsonl(lines);
    expect(entries.map(e => e.id)).toEqual(['z']);
  });

  it('coerces unknown kind to null', () => {
    const line = JSON.stringify({
      id: 'k',
      content: 'bad kind',
      kind: 'totally-made-up',
      created_at: '2026-05-08T00:00:00.000Z',
      occurrences: 1,
    });
    const [entry] = parseRetrosJsonl(line);
    expect(entry.kind).toBeNull();
  });

  it('skips malformed JSON lines without crashing', () => {
    const lines = [
      '{not json',
      JSON.stringify({ id: 'good', content: 'ok', created_at: 'now', occurrences: 1 }),
    ].join('\n');
    const entries = parseRetrosJsonl(lines);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('good');
  });

  it('tolerates unknown fields without dropping the row', () => {
    const line = JSON.stringify({
      id: 'forward-compat',
      content: 'with extras',
      kind: null,
      created_at: '2026-05-08T00:00:00.000Z',
      occurrences: 1,
      origin_peer_id: 'peer-x',
      future_field: 'whatever',
      another_extra: { nested: true },
    });
    const [entry] = parseRetrosJsonl(line);
    expect(entry.id).toBe('forward-compat');
    expect(entry.origin_peer_id).toBe('peer-x');
  });
});
