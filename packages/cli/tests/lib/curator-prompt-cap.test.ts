import { describe, it, expect } from 'vitest';
import {
  assembleCurationPrompt,
  DEFAULT_CURATOR_PROMPT_CHAR_CAP,
} from '../../src/lib/curator.js';
import type { MemoryEntry } from '../../src/lib/curator.js';
import type { Engram } from '../../src/db/engram-queries.js';

// AGT-065 AC #3: hard ceiling on assembled prompt size. Trim recent
// memories oldest-first when the cap is reached. Pending engrams +
// long-term events + curator-md are NOT trimmed — they're load-bearing
// for the curator's evaluation.
describe('assembleCurationPrompt — curator prompt cap (AGT-065 AC #3)', () => {
  function makeMemory(ts: string, content: string): MemoryEntry {
    return { ts, author: 'test', content, source_ids: [] };
  }

  const noEngrams: Engram[] = [];

  it('returns droppedRecentMemories: 0 when total size is under the cap', () => {
    const memories = [
      makeMemory('2026-05-01T00:00:00Z', 'short content one'),
      makeMemory('2026-05-02T00:00:00Z', 'short content two'),
    ];
    const prompt = assembleCurationPrompt({
      recentMemories: memories,
      longtermSummary: null,
      curatorMd: null,
      pendingEngrams: noEngrams,
      author: 'test',
    });
    expect(prompt.droppedRecentMemories ?? 0).toBe(0);
    expect(prompt.userMessage).toContain('short content one');
    expect(prompt.userMessage).toContain('short content two');
  });

  it('drops oldest recent memories first when the cap is reached', () => {
    // Each memory ~1100 chars; 30 of them ≈ 33k chars on the recent-memories
    // line. Setting the cap to 5000 forces ~26 drops, oldest-first.
    const memories: MemoryEntry[] = [];
    for (let i = 0; i < 30; i++) {
      const ts = `2026-05-${String(i + 1).padStart(2, '0')}T00:00:00Z`;
      memories.push(makeMemory(ts, 'x'.repeat(1000) + ` (#${i})`));
    }
    const prompt = assembleCurationPrompt({
      recentMemories: memories,
      longtermSummary: null,
      curatorMd: null,
      pendingEngrams: noEngrams,
      author: 'test',
      promptCharCap: 5000,
    });

    expect(prompt.droppedRecentMemories).toBeGreaterThan(0);
    // Newest entry (#29) survives — drop is oldest-first
    expect(prompt.userMessage).toContain('(#29)');
    // Oldest entry (#0) is dropped
    expect(prompt.userMessage).not.toContain('(#0)');
  });

  it('respects the default cap (50k chars) when no override is provided', () => {
    expect(DEFAULT_CURATOR_PROMPT_CHAR_CAP).toBe(50_000);

    // 200 memories × ~500 chars = 100k chars on the recent-memories line —
    // well over the default cap. Some must drop.
    const memories: MemoryEntry[] = [];
    for (let i = 0; i < 200; i++) {
      const ts = `2026-05-01T${String(i % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`;
      memories.push(makeMemory(ts, 'y'.repeat(500)));
    }
    const prompt = assembleCurationPrompt({
      recentMemories: memories,
      longtermSummary: null,
      curatorMd: null,
      pendingEngrams: noEngrams,
      author: 'test',
    });
    expect(prompt.droppedRecentMemories).toBeGreaterThan(0);
  });

  it('does not trim pending engrams or curator-md to fit under the cap', () => {
    // The cap only applies to recent-memories. Pending engrams stay intact
    // even if they push the total well over the cap — they're what the
    // curator is evaluating.
    const fatEngram: Engram = {
      id: 'eng-1',
      content: 'z'.repeat(10_000),
      created_at: '2026-05-09T00:00:00Z',
      expires_at: '2026-05-23T00:00:00Z',
      evaluated_at: null,
      promoted: null,
      deleted_at: null,
      episode_key: null,
      context: null,
      decisions: null,
    };
    const prompt = assembleCurationPrompt({
      recentMemories: [],
      longtermSummary: null,
      curatorMd: 'a'.repeat(5_000),
      pendingEngrams: [fatEngram],
      author: 'test',
      promptCharCap: 100, // absurdly small
    });
    // Pending engram content survives
    expect(prompt.userMessage).toContain('z'.repeat(100));
    // Curator-md survives
    expect(prompt.userMessage).toContain('a'.repeat(100));
  });
});
