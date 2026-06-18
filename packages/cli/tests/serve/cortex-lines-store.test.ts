import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Database } from '../../src/serve/db.js';
import {
  appendCortexLine,
  readCortexLines,
  maxCortexSeq,
} from '../../src/serve/cortex-lines-store.js';
import { deterministicId } from '../../src/lib/deterministic-id.js';
import { ensureSchema } from '../../src/serve/db/schema.js';
import type { WireMemoryLine } from '../../src/sync/hub-protocol.js';

let db: Database;

beforeEach(() => {
  // Each test owns a fresh in-memory DB. openDb runs ensureSchema, so this
  // also exercises the additive CREATE TABLE for cortex_lines.
  db = openDb(':memory:');
});

function line(content: string, overrides: Partial<WireMemoryLine> = {}): WireMemoryLine {
  return {
    ts: '2026-06-18T00:00:00.000Z',
    author: 'tester',
    content,
    source_ids: [],
    kind: 'memory',
    ...overrides,
  };
}

describe('appendCortexLine', () => {
  it('returns the assigned per-cortex seq, starting at 1', () => {
    const r = appendCortexLine(db, 'team', line('first'));
    expect(r.server_seq).toBe(1);
    expect(r.inserted).toBe(true);
    expect(r.id).toBe(deterministicId('2026-06-18T00:00:00.000Z', 'tester', 'first'));
  });

  it('assigns a strictly monotonic seq within a cortex', () => {
    const a = appendCortexLine(db, 'team', line('a'));
    const b = appendCortexLine(db, 'team', line('b'));
    const c = appendCortexLine(db, 'team', line('c'));
    expect(a.server_seq).toBe(1);
    expect(b.server_seq).toBe(2);
    expect(c.server_seq).toBe(3);
    expect(maxCortexSeq(db, 'team')).toBe(3);
  });

  it('gives each cortex an independent sequence space', () => {
    const a1 = appendCortexLine(db, 'alpha', line('a1'));
    const b1 = appendCortexLine(db, 'beta', line('b1'));
    const a2 = appendCortexLine(db, 'alpha', line('a2'));
    const b2 = appendCortexLine(db, 'beta', line('b2'));
    // Both cortexes start their own sequence at 1 — not comparable across.
    expect(a1.server_seq).toBe(1);
    expect(a2.server_seq).toBe(2);
    expect(b1.server_seq).toBe(1);
    expect(b2.server_seq).toBe(2);
    expect(maxCortexSeq(db, 'alpha')).toBe(2);
    expect(maxCortexSeq(db, 'beta')).toBe(2);
  });

  it('is idempotent: a replayed line returns its original seq and does not duplicate', () => {
    appendCortexLine(db, 'team', line('filler')); // seq 1
    const first = appendCortexLine(db, 'team', line('payload')); // seq 2
    expect(first.server_seq).toBe(2);
    expect(first.inserted).toBe(true);

    // Re-append the exact same content-derived line.
    const replay = appendCortexLine(db, 'team', line('payload'));
    expect(replay.inserted).toBe(false);
    expect(replay.server_seq).toBe(2); // original seq, NOT a new one
    expect(replay.id).toBe(first.id);

    // No duplicate row, and the high-water mark did not advance past the
    // last genuinely-new line.
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM cortex_lines WHERE cortex = ?')
      .get('team') as { n: number };
    expect(count.n).toBe(2);
    expect(maxCortexSeq(db, 'team')).toBe(2);

    // A genuinely new line after a replay still gets the next seq.
    const next = appendCortexLine(db, 'team', line('after-replay'));
    expect(next.server_seq).toBe(3);
  });

  it('persists and round-trips the optional wire fields', () => {
    appendCortexLine(
      db,
      'team',
      line('rich', {
        source_ids: ['e1', 'e2'],
        episode_key: 'github:org/repo#1',
        decisions: ['decided X'],
        origin_peer_id: 'peer-7',
      }),
    );
    const [stored] = readCortexLines(db, 'team');
    expect(stored.source_ids).toEqual(['e1', 'e2']);
    expect(stored.episode_key).toBe('github:org/repo#1');
    expect(stored.decisions).toEqual(['decided X']);
    expect(stored.origin_peer_id).toBe('peer-7');
    expect(stored.kind).toBe('memory');
  });

  it('omits optional fields that were not stored (mirrors wire line shape)', () => {
    appendCortexLine(db, 'team', line('plain'));
    const [stored] = readCortexLines(db, 'team');
    expect('episode_key' in stored).toBe(false);
    expect('decisions' in stored).toBe(false);
    expect('origin_peer_id' in stored).toBe(false);
    expect(stored.source_ids).toEqual([]);
  });
});

describe('readCortexLines', () => {
  it('returns only lines with server_seq > cursor, in ascending order', () => {
    for (let i = 1; i <= 5; i++) appendCortexLine(db, 'team', line(`m${i}`));

    const all = readCortexLines(db, 'team', 0);
    expect(all.map((l) => l.server_seq)).toEqual([1, 2, 3, 4, 5]);

    const past2 = readCortexLines(db, 'team', 2);
    expect(past2.map((l) => l.server_seq)).toEqual([3, 4, 5]);
    expect(past2[0].content).toBe('m3');
  });

  it('caps the page at the requested limit', () => {
    for (let i = 1; i <= 5; i++) appendCortexLine(db, 'team', line(`m${i}`));
    const page = readCortexLines(db, 'team', 0, 2);
    expect(page).toHaveLength(2);
    expect(page.map((l) => l.server_seq)).toEqual([1, 2]);

    // Cursor advances to the last seq in the page; the next page continues.
    const next = readCortexLines(db, 'team', page[page.length - 1].server_seq, 2);
    expect(next.map((l) => l.server_seq)).toEqual([3, 4]);
  });

  it('does not bleed lines across cortexes', () => {
    appendCortexLine(db, 'alpha', line('a'));
    appendCortexLine(db, 'beta', line('b'));
    const alpha = readCortexLines(db, 'alpha', 0);
    expect(alpha).toHaveLength(1);
    expect(alpha[0].content).toBe('a');
  });

  it('returns an empty array past the high-water mark', () => {
    appendCortexLine(db, 'team', line('only'));
    expect(readCortexLines(db, 'team', 99)).toEqual([]);
  });
});

describe('additive schema (AC4: existing serve is unregressed)', () => {
  it('leaves the pre-existing serve tables intact alongside cortex_lines', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    // The store table exists...
    expect(names).toContain('cortex_lines');
    // ...and so do all the single-tenant serve tables it must not regress.
    expect(names).toContain('subscriptions');
    expect(names).toContain('events');
    expect(names).toContain('source_credentials');
    expect(names).toContain('proxy_kv');
  });

  it('re-running ensureSchema is a no-op (idempotent CREATE IF NOT EXISTS)', () => {
    appendCortexLine(db, 'team', line('survivor'));
    // openDb already ran ensureSchema once; re-invoke it on the same handle to
    // prove the CREATE IF NOT EXISTS path is idempotent and preserves data.
    expect(() => ensureSchema(db)).not.toThrow();
    expect(maxCortexSeq(db, 'team')).toBe(1);
  });
});
