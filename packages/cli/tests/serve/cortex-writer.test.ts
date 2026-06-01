/**
 * AGT-384 — proxy cortex-writer.
 *
 * AC coverage:
 *   1. Module `serve/cortex-writer.ts` exports `writeMemoriesForEvent`.
 *   2. Each memory becomes one JSONL line with the AC #2 field set:
 *      id (uuidv7), ts, author = "proxy", origin_peer_id, episode_key,
 *      source_ids = [event.id], topics, content, supersedes: [],
 *      compacted_from: null.
 *   3. Push-debouncer is notified after appending.
 *   4. Mock event + 2-memory output → JSONL gets exactly 2 new lines,
 *      same episode_key, distinct ids, both stamped with the proxy peer-id.
 *
 * The tests use the module's `appendFn` and `notifyPush` test seams to
 * avoid touching `~/.think/repo` and to avoid invoking any real git
 * subprocess. A separate test exercises the live `appendFn` path under
 * a tmp `THINK_HOME` to confirm the file lands in the expected on-disk
 * location.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeMemoriesForEvent,
  type TerminalEventForWrite,
  type CuratedMemory,
} from '../../src/serve/cortex-writer.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROXY_PEER_ID = 'proxy-anglepoint-test01';
const CORTEX = 'anglepoint-team';

function makeEvent(overrides: Partial<TerminalEventForWrite> = {}): TerminalEventForWrite {
  return {
    id: 'github:org/repo#536',
    episodeKey: 'github:org/repo#536',
    ...overrides,
  };
}

interface AppendCall {
  obj: Record<string, unknown>;
}

function makeAppendCollector(): { calls: AppendCall[]; fn: (obj: Record<string, unknown>) => void } {
  const calls: AppendCall[] = [];
  return {
    calls,
    fn: (obj) => calls.push({ obj }),
  };
}

// ---------------------------------------------------------------------------
// AC #4 — the canonical "2-memory event" assertion
// ---------------------------------------------------------------------------

describe('writeMemoriesForEvent — AC #4 (2-memory shared-episode)', () => {
  it('produces exactly 2 JSONL lines sharing episode_key, with distinct ids, both stamped with the proxy peer-id', () => {
    const append = makeAppendCollector();
    const notifyCalls: string[] = [];
    const event = makeEvent({ id: 'github:org/repo#536', episodeKey: 'github:org/repo#536' });
    const memories: CuratedMemory[] = [
      { content: 'Topic A narrative.', topics: ['topic-a'] },
      { content: 'Topic B narrative.', topics: ['topic-b', 'topic-c'] },
    ];

    const result = writeMemoriesForEvent({
      event,
      memories,
      cortexName: CORTEX,
      peerId: PROXY_PEER_ID,
      appendFn: append.fn,
      notifyPush: (c) => notifyCalls.push(c),
    });

    // Exactly 2 lines were appended.
    expect(append.calls).toHaveLength(2);

    // Both lines share episode_key.
    expect(append.calls[0].obj.episode_key).toBe('github:org/repo#536');
    expect(append.calls[1].obj.episode_key).toBe('github:org/repo#536');

    // Distinct ids.
    const id0 = append.calls[0].obj.id as string;
    const id1 = append.calls[1].obj.id as string;
    expect(id0).not.toBe(id1);
    // Both look like uuidv7s.
    expect(id0).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    // Both carry the proxy peer-id.
    expect(append.calls[0].obj.origin_peer_id).toBe(PROXY_PEER_ID);
    expect(append.calls[1].obj.origin_peer_id).toBe(PROXY_PEER_ID);

    // Result echoes the ids in order.
    expect(result.ids).toEqual([id0, id1]);
  });
});

// ---------------------------------------------------------------------------
// AC #2 — per-field shape of each JSONL line
// ---------------------------------------------------------------------------

describe('writeMemoriesForEvent — AC #2 (JSONL field shape)', () => {
  it('writes the full AC field set with correct values', () => {
    const append = makeAppendCollector();
    const event = makeEvent({ id: 'evt-123', episodeKey: 'linear:TEAM-7' });
    const memories: CuratedMemory[] = [
      { content: 'A self-contained narrative.', topics: ['design', 'rfc'] },
    ];

    writeMemoriesForEvent({
      event,
      memories,
      cortexName: CORTEX,
      peerId: PROXY_PEER_ID,
      now: () => '2026-05-20T12:00:00.000Z',
      appendFn: append.fn,
      notifyPush: () => {},
    });

    expect(append.calls).toHaveLength(1);
    const line = append.calls[0].obj;
    expect(line.ts).toBe('2026-05-20T12:00:00.000Z');
    expect(line.author).toBe('proxy');
    expect(line.origin_peer_id).toBe(PROXY_PEER_ID);
    expect(line.episode_key).toBe('linear:TEAM-7');
    expect(line.source_ids).toEqual(['evt-123']);
    expect(line.topics).toEqual(['design', 'rfc']);
    expect(line.content).toBe('A self-contained narrative.');
    expect(line.supersedes).toEqual([]);
    expect(line.compacted_from).toBeNull();
    // id must be present and look like a uuidv7.
    expect(line.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('shares the same ts across all sibling memories in one call', () => {
    const append = makeAppendCollector();
    const memories: CuratedMemory[] = [
      { content: 'm1', topics: [] },
      { content: 'm2', topics: [] },
      { content: 'm3', topics: [] },
    ];
    writeMemoriesForEvent({
      event: makeEvent(),
      memories,
      cortexName: CORTEX,
      peerId: PROXY_PEER_ID,
      now: () => '2026-05-20T12:00:00.000Z',
      appendFn: append.fn,
      notifyPush: () => {},
    });
    expect(append.calls.map(c => c.obj.ts)).toEqual([
      '2026-05-20T12:00:00.000Z',
      '2026-05-20T12:00:00.000Z',
      '2026-05-20T12:00:00.000Z',
    ]);
  });

  it('does NOT include schema placeholders outside the AC list (no kind / deleted_at / decisions)', () => {
    // Proxy-authored terminal-event memories are immutable siblings; the v3
    // entry-model placeholders that compaction/supersession use elsewhere
    // are intentionally absent. Asserting their absence pins the shape so
    // a casual edit can't silently broaden it.
    const append = makeAppendCollector();
    writeMemoriesForEvent({
      event: makeEvent(),
      memories: [{ content: 'm', topics: [] }],
      cortexName: CORTEX,
      peerId: PROXY_PEER_ID,
      appendFn: append.fn,
      notifyPush: () => {},
    });
    const line = append.calls[0].obj;
    expect(line).not.toHaveProperty('kind');
    expect(line).not.toHaveProperty('deleted_at');
    expect(line).not.toHaveProperty('decisions');
  });
});

// ---------------------------------------------------------------------------
// AC #3 — push-debouncer notify
// ---------------------------------------------------------------------------

describe('writeMemoriesForEvent — AC #3 (push-debouncer notify)', () => {
  it('notifies the push-debouncer exactly once per call, regardless of memory count', () => {
    const notifyCalls: string[] = [];
    writeMemoriesForEvent({
      event: makeEvent(),
      memories: [
        { content: 'a', topics: [] },
        { content: 'b', topics: [] },
        { content: 'c', topics: [] },
      ],
      cortexName: CORTEX,
      peerId: PROXY_PEER_ID,
      appendFn: () => {},
      notifyPush: (c) => notifyCalls.push(c),
    });
    expect(notifyCalls).toEqual([CORTEX]);
  });

  it('does NOT notify when memories is empty (no-op call)', () => {
    const notifyCalls: string[] = [];
    const append = makeAppendCollector();
    const result = writeMemoriesForEvent({
      event: makeEvent(),
      memories: [],
      cortexName: CORTEX,
      peerId: PROXY_PEER_ID,
      appendFn: append.fn,
      notifyPush: (c) => notifyCalls.push(c),
    });
    expect(append.calls).toHaveLength(0);
    expect(notifyCalls).toEqual([]);
    expect(result.ids).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('writeMemoriesForEvent — validation', () => {
  it('rejects an empty peerId', () => {
    expect(() =>
      writeMemoriesForEvent({
        event: makeEvent(),
        memories: [{ content: 'm', topics: [] }],
        cortexName: CORTEX,
        peerId: '',
        appendFn: () => {},
        notifyPush: () => {},
      }),
    ).toThrow(/non-empty/);
  });

  it('rejects a whitespace-only peerId', () => {
    expect(() =>
      writeMemoriesForEvent({
        event: makeEvent(),
        memories: [{ content: 'm', topics: [] }],
        cortexName: CORTEX,
        peerId: '   \t\n',
        appendFn: () => {},
        notifyPush: () => {},
      }),
    ).toThrow(/non-empty/);
  });

  it('rejects an invalid cortex name (path traversal / disallowed chars)', () => {
    expect(() =>
      writeMemoriesForEvent({
        event: makeEvent(),
        memories: [{ content: 'm', topics: [] }],
        cortexName: '../etc/passwd',
        peerId: PROXY_PEER_ID,
        appendFn: () => {},
        notifyPush: () => {},
      }),
    ).toThrow(/Invalid cortex name/);
  });

  it('trims surrounding whitespace from peerId before stamping', () => {
    const append = makeAppendCollector();
    writeMemoriesForEvent({
      event: makeEvent(),
      memories: [{ content: 'm', topics: [] }],
      cortexName: CORTEX,
      peerId: '  proxy-padded  ',
      appendFn: append.fn,
      notifyPush: () => {},
    });
    expect(append.calls[0].obj.origin_peer_id).toBe('proxy-padded');
  });
});

// ---------------------------------------------------------------------------
// On-disk integration — exercises the real `appendToL1Page` under tmp HOME
// ---------------------------------------------------------------------------

describe('writeMemoriesForEvent — real on-disk append', () => {
  let thinkHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    thinkHome = mkdtempSync(join(tmpdir(), 'think-cortex-writer-test-'));
    process.env.THINK_HOME = thinkHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(thinkHome, { recursive: true, force: true });
  });

  it('enqueues one l1_outbox line per memory (the real, non-stubbed path)', async () => {
    const event = makeEvent({ id: 'evt-disk-1', episodeKey: 'evt-disk-1' });
    const memories: CuratedMemory[] = [
      { content: 'first', topics: ['a'] },
      { content: 'second', topics: ['b'] },
    ];

    const result = writeMemoriesForEvent({
      event,
      memories,
      cortexName: CORTEX,
      peerId: PROXY_PEER_ID,
      // Use the real outbox path (do not pass an appendFn test seam). The push-
      // debouncer's plumbing drain appends these to the cortex branch — no
      // worktree write here (#70 Option B / AGT-458).
      notifyPush: () => {},
    });

    const { getCortexDb, closeAllCortexDbs } = await import('../../src/db/engrams.js');
    const db = getCortexDb(CORTEX);
    const rows = db.prepare('SELECT entry_id, line FROM l1_outbox ORDER BY id ASC').all() as
      { entry_id: string; line: string }[];
    expect(rows).toHaveLength(2);

    const parsed = rows.map((r) => JSON.parse(r.line) as Record<string, unknown>);
    expect(parsed[0].content).toBe('first');
    expect(parsed[1].content).toBe('second');
    expect(parsed[0].episode_key).toBe('evt-disk-1');
    expect(parsed[1].episode_key).toBe('evt-disk-1');
    expect(parsed[0].source_ids).toEqual(['evt-disk-1']);
    expect(parsed[1].source_ids).toEqual(['evt-disk-1']);
    expect(parsed[0].id).toBe(result.ids[0]);
    expect(parsed[1].id).toBe(result.ids[1]);

    // The cortex worktree dir must NOT have been written by the proxy path.
    const cortexDir = join(thinkHome, 'repo', CORTEX);
    expect(existsSync(cortexDir)).toBe(false);

    closeAllCortexDbs();
  });
});

// ---------------------------------------------------------------------------
// ts = occurredAt ?? now()  (default-now-with-override; drives recall recency)
// ---------------------------------------------------------------------------

describe('writeMemoriesForEvent — memory ts source', () => {
  it('stamps ts from occurredAt when provided (overrides the now seam)', () => {
    const append = makeAppendCollector();
    writeMemoriesForEvent({
      event: makeEvent(),
      memories: [{ content: 'a historical PR', topics: [] }],
      cortexName: CORTEX,
      peerId: PROXY_PEER_ID,
      occurredAt: '2021-03-04T09:00:00.000Z', // a years-old source date
      now: () => '2026-05-23T00:00:00.000Z', // would-be insertion time
      appendFn: append.fn,
      notifyPush: () => {},
    });
    // The memory carries the SOURCE date, not "now" — so a backfilled old
    // item sorts to its real chronological position in recall.
    expect(append.calls[0].obj.ts).toBe('2021-03-04T09:00:00.000Z');
  });

  it('falls back to now() when occurredAt is unset', () => {
    const append = makeAppendCollector();
    writeMemoriesForEvent({
      event: makeEvent(),
      memories: [{ content: 'a live PR', topics: [] }],
      cortexName: CORTEX,
      peerId: PROXY_PEER_ID,
      // occurredAt intentionally omitted
      now: () => '2026-05-23T00:00:00.000Z',
      appendFn: append.fn,
      notifyPush: () => {},
    });
    expect(append.calls[0].obj.ts).toBe('2026-05-23T00:00:00.000Z');
  });

  it('falls back to now() when occurredAt is not a parseable date (defends against bad connectors)', () => {
    const append = makeAppendCollector();
    writeMemoriesForEvent({
      event: makeEvent(),
      memories: [{ content: 'garbage-dated', topics: [] }],
      cortexName: CORTEX,
      peerId: PROXY_PEER_ID,
      occurredAt: 'not-a-date', // non-parseable → guard rejects it
      now: () => '2026-05-23T00:00:00.000Z',
      appendFn: append.fn,
      notifyPush: () => {},
    });
    expect(append.calls[0].obj.ts).toBe('2026-05-23T00:00:00.000Z');
  });

  it('applies the same occurredAt to every memory in a multi-memory event', () => {
    const append = makeAppendCollector();
    writeMemoriesForEvent({
      event: makeEvent(),
      memories: [
        { content: 'segment one', topics: [] },
        { content: 'segment two', topics: [] },
      ],
      cortexName: CORTEX,
      peerId: PROXY_PEER_ID,
      occurredAt: '2022-11-01T00:00:00.000Z',
      now: () => '2026-05-23T00:00:00.000Z',
      appendFn: append.fn,
      notifyPush: () => {},
    });
    expect(append.calls).toHaveLength(2);
    expect(append.calls[0].obj.ts).toBe('2022-11-01T00:00:00.000Z');
    expect(append.calls[1].obj.ts).toBe('2022-11-01T00:00:00.000Z');
  });
});
