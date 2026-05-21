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
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
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
  cortexDir: string;
  obj: Record<string, unknown>;
}

function makeAppendCollector(): { calls: AppendCall[]; fn: (cortexDir: string, obj: Record<string, unknown>) => void } {
  const calls: AppendCall[] = [];
  return {
    calls,
    fn: (cortexDir, obj) => calls.push({ cortexDir, obj }),
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

  it('creates the cortex dir and writes a `000001.jsonl` with one line per memory', () => {
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
      // Use the real appendFn (do not pass a test seam).
      notifyPush: () => {},
    });

    const cortexDir = join(thinkHome, 'repo', CORTEX);
    expect(existsSync(cortexDir)).toBe(true);

    const files = readdirSync(cortexDir).filter(f => f.endsWith('.jsonl')).sort();
    expect(files).toEqual(['000001.jsonl']);

    const raw = readFileSync(join(cortexDir, '000001.jsonl'), 'utf-8');
    const lines = raw.split('\n').filter(l => l.length > 0);
    expect(lines).toHaveLength(2);

    const parsed = lines.map(l => JSON.parse(l));
    expect(parsed[0].content).toBe('first');
    expect(parsed[1].content).toBe('second');
    expect(parsed[0].episode_key).toBe('evt-disk-1');
    expect(parsed[1].episode_key).toBe('evt-disk-1');
    expect(parsed[0].source_ids).toEqual(['evt-disk-1']);
    expect(parsed[1].source_ids).toEqual(['evt-disk-1']);
    expect(parsed[0].id).toBe(result.ids[0]);
    expect(parsed[1].id).toBe(result.ids[1]);
  });
});
