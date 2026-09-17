/**
 * Tests for the daemon-unreachable write fallback — AGT-1298.
 *
 * The contract this file pins:
 *   - the entry lands in the cortex's `l1_outbox`, never in `engrams`;
 *   - the line is byte-shaped exactly like the daemon's (shared
 *     `lib/l1-entry.ts` builder), so the drain and the boot indexer can read
 *     it without a special case;
 *   - a write that cannot be made durable throws (callers exit non-zero);
 *   - the one-line stderr note is emitted on every successful write.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeDaemonDownEntry } from '../../src/lib/l1-fallback.js';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';

let thinkHome: string;
let originalHome: string | undefined;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  originalHome = process.env.THINK_HOME;
  thinkHome = mkdtempSync(join(tmpdir(), 'think-l1-fallback-'));
  process.env.THINK_HOME = thinkHome;
  closeAllCortexDbs();

  const configDir = join(thinkHome, 'config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({ peerId: 'fallback-test-peer', cortex: { author: 'test-author' } }),
    { mode: 0o600 },
  );

  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  closeAllCortexDbs();
  if (originalHome === undefined) delete process.env.THINK_HOME;
  else process.env.THINK_HOME = originalHome;
  rmSync(thinkHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Parse the pending outbox lines for a cortex. */
function outbox(cortex: string): Record<string, unknown>[] {
  const rows = getCortexDb(cortex)
    .prepare('SELECT line FROM l1_outbox ORDER BY id ASC')
    .all() as unknown as { line: string }[];
  return rows.map(r => JSON.parse(r.line) as Record<string, unknown>);
}

describe('writeDaemonDownEntry', () => {
  it('enqueues a full v3 L1 entry and nothing else', () => {
    const { id, ts } = writeDaemonDownEntry({
      cortex: 'personal',
      content: 'the daemon was down when this was written',
      kind: 'memory',
      topics: ['daemon', 'offline'],
    });

    const entries = outbox('personal');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      id,
      ts,
      author: 'test-author',
      origin_peer_id: 'fallback-test-peer',
      kind: 'memory',
      content: 'the daemon was down when this was written',
      topics: ['daemon', 'offline'],
      supersedes: [],
      compacted_from: null,
      decisions: [],
      source_ids: [],
      deleted_at: null,
    });

    // Never the v2 tier.
    const engrams = getCortexDb('personal')
      .prepare('SELECT COUNT(*) as count FROM engrams')
      .get() as { count: number };
    expect(engrams.count).toBe(0);
  });

  it('preserves each kind', () => {
    writeDaemonDownEntry({ cortex: 'k', content: 'a memory entry', kind: 'memory' });
    writeDaemonDownEntry({ cortex: 'k', content: 'an event entry', kind: 'event' });
    writeDaemonDownEntry({ cortex: 'k', content: 'a retro entry', kind: 'retro' });

    expect(outbox('k').map(e => e.kind)).toEqual(['memory', 'event', 'retro']);
  });

  it('writes the one-line note to stderr on every write', () => {
    writeDaemonDownEntry({ cortex: 'noted', content: 'something worth noting', kind: 'memory' });

    const written = stderrSpy.mock.calls.flat().join('');
    expect(written).toContain('daemon unavailable');
    expect(written).toContain('indexed on next daemon start');
    expect(written.trim().split('\n')).toHaveLength(1);
  });

  it('throws on an unsafe cortex name (nothing written, caller exits non-zero)', () => {
    expect(() => writeDaemonDownEntry({ cortex: '../escape', content: 'nope', kind: 'memory' }))
      .toThrow();
  });

  it('throws on empty content and on content over the 64 KB daemon cap', () => {
    expect(() => writeDaemonDownEntry({ cortex: 'c', content: '   ', kind: 'memory' }))
      .toThrow(/content/);
    expect(() =>
      writeDaemonDownEntry({ cortex: 'c', content: 'x'.repeat(64 * 1024 + 1), kind: 'memory' }),
    ).toThrow(/64 KB/);
  });

  it('throws on more topics than the daemon would accept', () => {
    expect(() =>
      writeDaemonDownEntry({
        cortex: 'c',
        content: 'too many topics',
        kind: 'memory',
        topics: Array.from({ length: 21 }, (_, i) => `t${i}`),
      }),
    ).toThrow(/topics/);
  });

  it('mints monotonic uuidv7 ids so outbox FIFO order matches write order', () => {
    const first = writeDaemonDownEntry({ cortex: 'ordered', content: 'first entry here', kind: 'memory' });
    const second = writeDaemonDownEntry({ cortex: 'ordered', content: 'second entry here', kind: 'memory' });

    expect(first.id < second.id).toBe(true);
    expect(outbox('ordered').map(e => e.id)).toEqual([first.id, second.id]);
  });
});
