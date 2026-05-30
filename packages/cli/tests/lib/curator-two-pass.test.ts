import { describe, it, expect } from 'vitest';
import {
  runCurationTierA,
  runEventDetection,
  runLocalTwoPassCuration,
  assembleEventDetectionPrompt,
  assembleCurationPrompt,
  type StructuredPrompt,
} from '../../src/lib/curator.js';
import type { LlmClient, LlmRequest, LlmResponse } from '../../src/lib/llm/client.js';
import type { Engram } from '../../src/db/engram-queries.js';

// A scripted client: returns a queued response per call, recording each request
// so tests can assert which schema/prompt each pass used. No network, no SDK.
function scripted(...texts: string[]): LlmClient & { reqs: LlmRequest[] } {
  const reqs: LlmRequest[] = [];
  let i = 0;
  return {
    name: 'scripted',
    reqs,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      reqs.push(req);
      return { text: texts[i++] ?? '{}' };
    },
  };
}

function engram(id: string, content: string): Engram {
  return {
    id, content, created_at: '2026-01-01T00:00:00Z', expires_at: '2026-02-01T00:00:00Z',
    evaluated_at: null, promoted: null, deleted_at: null, episode_key: null, context: null, decisions: null,
  };
}

const PROMPT: StructuredPrompt = { systemPrompt: 'sys', userMessage: 'user' };

describe('runCurationTierA', () => {
  it('parses memories + purges and uses the tier-A schema', async () => {
    const c = scripted(JSON.stringify({
      memories: [{ content: 'shipped X', source_ids: ['e1'] }],
      purge_ids: ['e2'],
    }));
    const res = await runCurationTierA(PROMPT, c);
    expect(res.memories).toHaveLength(1);
    expect(res.memories[0].source_ids).toEqual(['e1']);
    expect(res.purgeIds).toEqual(['e2']);
    expect(c.reqs[0].schema?.name).toBe('curation_tier_a');
  });

  it('tolerates a bare-array (memories only) response', async () => {
    const c = scripted(JSON.stringify([{ content: 'm', source_ids: [] }]));
    const res = await runCurationTierA(PROMPT, c);
    expect(res.memories).toHaveLength(1);
    expect(res.purgeIds).toEqual([]);
  });
});

describe('runEventDetection', () => {
  it('parses long_term_events with the event schema', async () => {
    const c = scripted(JSON.stringify({
      long_term_events: [
        { kind: 'adoption', title: 'Adopted X', content: 'We adopted X.', topics: ['x'], source_memory_ids: ['m0'] },
      ],
    }));
    const events = await runEventDetection(PROMPT, c);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('adoption');
    expect(c.reqs[0].schema?.name).toBe('event_detection');
  });

  it('drops events with an invalid kind', async () => {
    const c = scripted(JSON.stringify({
      long_term_events: [{ kind: 'banana', title: 't', content: 'c' }],
    }));
    expect(await runEventDetection(PROMPT, c)).toHaveLength(0);
  });
});

describe('assembleEventDetectionPrompt', () => {
  it('labels memories with m<N> ids the model can cite', () => {
    const p = assembleEventDetectionPrompt({
      memories: [
        { ts: '', author: 'a', content: 'first', source_ids: ['e1'], kind: 'memory', compacted_from: null, supersedes: [], topics: [] },
        { ts: '', author: 'a', content: 'second', source_ids: ['e2'], kind: 'memory', compacted_from: null, supersedes: [], topics: [] },
      ],
    });
    expect(p.userMessage).toContain('(id: m0) first');
    expect(p.userMessage).toContain('(id: m1) second');
  });
});

describe('runLocalTwoPassCuration', () => {
  function curationPrompt(engrams: Engram[]) {
    return assembleCurationPrompt({
      recentMemories: [], longtermSummary: null, recentLongTermEvents: [],
      curatorMd: null, pendingEngrams: engrams, author: 'me',
    });
  }

  it('runs tier A then tier B, remapping m<N> event refs to real engram ids', async () => {
    const c = scripted(
      JSON.stringify({ memories: [{ content: 'adopted local-first', source_ids: ['e-aaa', 'e-bbb'] }], purge_ids: ['e-noise'] }),
      JSON.stringify({ long_term_events: [{ kind: 'adoption', title: 'Adopted local-first', content: 'We did.', topics: ['llm'], source_memory_ids: ['m0'] }] }),
    );
    const res = await runLocalTwoPassCuration(curationPrompt([engram('e-aaa', 'x'), engram('e-bbb', 'y'), engram('e-noise', 'test')]), [], c);

    expect(c.reqs).toHaveLength(2); // two passes
    expect(res.memories).toHaveLength(1);
    expect(res.purgeIds).toEqual(['e-noise']);
    expect(res.longTermEvents).toHaveLength(1);
    // m0 → memory[0].source_ids (the real engrams that formed it)
    expect(res.longTermEvents[0].source_memory_ids).toEqual(['e-aaa', 'e-bbb']);
  });

  it('skips the tier-B call entirely when tier A promotes nothing', async () => {
    const c = scripted(JSON.stringify({ memories: [], purge_ids: ['e-noise'] }));
    const res = await runLocalTwoPassCuration(curationPrompt([engram('e-noise', 'test')]), [], c);
    expect(c.reqs).toHaveLength(1); // tier B never called
    expect(res.memories).toHaveLength(0);
    expect(res.purgeIds).toEqual(['e-noise']);
    expect(res.longTermEvents).toEqual([]);
  });

  it('tier A uses the tier-A system prompt, not the combined one', async () => {
    const c = scripted(JSON.stringify({ memories: [], purge_ids: [] }));
    const prompt = curationPrompt([engram('e1', 'x')]);
    await runLocalTwoPassCuration(prompt, [], c);
    expect(c.reqs[0].system).toBe(prompt.tierASystemPrompt);
    expect(c.reqs[0].system).not.toContain('long-term event'); // tier A omits tier B guidance
  });
});

describe('assembleCurationPrompt', () => {
  it('returns a tierASystemPrompt that carries the same tuning suffix', () => {
    const p = assembleCurationPrompt({
      recentMemories: [], longtermSummary: null, recentLongTermEvents: [],
      curatorMd: null, pendingEngrams: [], author: 'me', selectivity: 'high',
    });
    expect(p.tierASystemPrompt).toContain('Additional instructions:');
    expect(p.tierASystemPrompt).toContain('Be very selective');
    expect(p.systemPrompt).toContain('Be very selective');
  });
});
