import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// AGT-383: tests for `runTerminalEventCuration` — the Phase-1 entry point of
// think-proxy-events. We mock the Anthropic Agent SDK at the module boundary
// so we can drive the model's "response" deterministically and assert the
// segmentation, validation, and one-retry behaviours.
//
// Mock pattern mirrors tests/commands/long-term.test.ts: replace the SDK's
// `query` export with a spy whose impl yields a synthetic generator. The
// wrapper at lib/claude-sdk.ts re-exports the SDK's `query` after a consent
// check, so the spy still gets hit through the wrapper.
const querySpy = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: querySpy,
}));

// Import AFTER the mock so module-level imports of `query` bind to the spy.
const { runTerminalEventCuration, assembleTerminalEventPrompt } = await import('../../src/lib/curator.js');

/** Build an async generator that yields one synthetic "result" message,
 * matching the shape the curator code reads (it pulls `message.result`). */
function generatorYielding(result: string): AsyncGenerator<{ result: string }> {
  return (async function* gen() {
    yield { result };
  })();
}

describe('runTerminalEventCuration (AGT-383)', () => {
  let originalConsent: string | undefined;

  beforeEach(() => {
    // `query` is gated by THINK_LLM_CONSENT; the gate is mechanical and runs
    // before forwarding to the (mocked) SDK. Opt in for the test session.
    originalConsent = process.env.THINK_LLM_CONSENT;
    process.env.THINK_LLM_CONSENT = '1';
    querySpy.mockReset();
  });

  afterEach(() => {
    if (originalConsent === undefined) delete process.env.THINK_LLM_CONSENT;
    else process.env.THINK_LLM_CONSENT = originalConsent;
    vi.restoreAllMocks();
  });

  it('single-topic event → 1 memory (AC #4)', async () => {
    const response = JSON.stringify({
      memories: [
        {
          content:
            'Engineers merged PR #536, the OAuth refresh-token-rotation hotfix. The race condition between concurrent refresh requests was resolved by serializing per-user token writes through a Redis lock.',
          topics: ['oauth', 'auth-bugfix'],
        },
      ],
    });
    querySpy.mockReturnValueOnce(generatorYielding(response));

    const result = await runTerminalEventCuration({
      event: {
        id: 'github:anglepoint/ui-host#536',
        title: 'Fix OAuth refresh token race',
        payload:
          'PR #536 — single-issue fix to the OAuth refresh-token endpoint. Reviewers approved; merged 2026-05-19.',
      },
      episodeKey: 'github:anglepoint/ui-host#536',
      sourceTags: ['github', 'pull-request'],
    });

    expect(result.memories).toHaveLength(1);
    expect(result.memories[0].content).toMatch(/OAuth/i);
    expect(result.memories[0].topics).toEqual(['oauth', 'auth-bugfix']);
    expect(querySpy).toHaveBeenCalledTimes(1);
  });

  it('multi-topic event → N memories with non-overlapping topic tags (AC #4)', async () => {
    // A 3-hour planning meeting split into three distinct topical memories.
    const response = JSON.stringify({
      memories: [
        {
          content:
            'The team decided to migrate logging infrastructure from self-hosted Loki to Datadog by end of Q3. Cost analysis showed Datadog comes out cheaper above 200GB/day ingestion and removes operational burden on the platform team.',
          topics: ['infrastructure', 'logging'],
        },
        {
          content:
            'Hiring plan for H2: two senior backend roles greenlit, one staff platform role deferred to 2027 pending revenue review. Recruiting will prioritize backend candidates with payments-domain experience.',
          topics: ['hiring', 'h2-planning'],
        },
        {
          content:
            'Product pivoted the Q4 roadmap away from the multi-tenant SSO project toward an enterprise audit-log API. SSO is unblocked but lower-priority customer signal; audit-log API has three signed LOIs.',
          topics: ['product-roadmap', 'enterprise'],
        },
      ],
    });
    querySpy.mockReturnValueOnce(generatorYielding(response));

    const result = await runTerminalEventCuration({
      event: {
        id: 'meeting:granola:abc-123',
        title: 'Engineering planning sync 2026-05-19',
        payload: 'long multi-topic transcript here — infra + hiring + roadmap…',
        metadata: { attendees: ['matt', 'jacob', 'sasha'], duration_min: 180 },
      },
      episodeKey: 'meeting:granola:abc-123',
    });

    expect(result.memories).toHaveLength(3);

    // Each memory has its own content + at least one topic.
    for (const m of result.memories) {
      expect(typeof m.content).toBe('string');
      expect(m.content.length).toBeGreaterThan(0);
      expect(m.topics.length).toBeGreaterThanOrEqual(1);
    }

    // Topics across memories are non-overlapping (AC #4 explicitly).
    const allTopics = result.memories.flatMap(m => m.topics);
    const unique = new Set(allTopics);
    expect(unique.size).toBe(allTopics.length);

    expect(querySpy).toHaveBeenCalledTimes(1);
  });

  it('malformed JSON on first call → exactly one retry that succeeds (AC #3)', async () => {
    const malformed = 'not actually json at all { definitely broken';
    const valid = JSON.stringify({
      memories: [
        { content: 'A clean second-try memory.', topics: ['recovery'] },
      ],
    });
    querySpy
      .mockReturnValueOnce(generatorYielding(malformed))
      .mockReturnValueOnce(generatorYielding(valid));

    const result = await runTerminalEventCuration({
      event: { payload: 'some payload' },
      episodeKey: 'meeting:test:retry',
    });

    expect(result.memories).toHaveLength(1);
    expect(result.memories[0].topics).toEqual(['recovery']);
    expect(querySpy).toHaveBeenCalledTimes(2);
  });

  it('shape-invalid response on first call → retries once (AC #3)', async () => {
    // First response is valid JSON but the wrong shape — missing topics array.
    const wrongShape = JSON.stringify({ memories: [{ content: 'no topics field' }] });
    const valid = JSON.stringify({
      memories: [{ content: 'fixed up on retry', topics: ['ok'] }],
    });
    querySpy
      .mockReturnValueOnce(generatorYielding(wrongShape))
      .mockReturnValueOnce(generatorYielding(valid));

    const result = await runTerminalEventCuration({
      event: { payload: 'p' },
      episodeKey: 'k',
    });

    expect(result.memories).toHaveLength(1);
    expect(querySpy).toHaveBeenCalledTimes(2);
  });

  it('malformed on both attempts → throws (AC #3)', async () => {
    querySpy
      .mockReturnValueOnce(generatorYielding('garbage'))
      .mockReturnValueOnce(generatorYielding('also garbage'));

    await expect(
      runTerminalEventCuration({
        event: { payload: 'p' },
        episodeKey: 'k',
      }),
    ).rejects.toThrow(/Terminal-event curation failed after one retry/);

    expect(querySpy).toHaveBeenCalledTimes(2);
  });

  it('empty memories array is treated as malformed and triggers retry', async () => {
    const empty = JSON.stringify({ memories: [] });
    const valid = JSON.stringify({
      memories: [{ content: 'one memory at last', topics: ['t'] }],
    });
    querySpy
      .mockReturnValueOnce(generatorYielding(empty))
      .mockReturnValueOnce(generatorYielding(valid));

    const result = await runTerminalEventCuration({
      event: { payload: 'p' },
      episodeKey: 'k',
    });

    expect(result.memories).toHaveLength(1);
    expect(querySpy).toHaveBeenCalledTimes(2);
  });

  it('strips fenced code blocks before parsing (Sonnet sometimes wraps)', async () => {
    // Same fenced-block edge case the v2 curator handles (AGT-222). We rely
    // on `extractFirstFencedBlock`, but this test pins the behaviour for the
    // terminal-event path explicitly.
    const wrapped = [
      '```json',
      JSON.stringify({ memories: [{ content: 'fenced reply', topics: ['fence'] }] }),
      '```',
      '',
      'Trailing commentary after the close fence.',
    ].join('\n');
    querySpy.mockReturnValueOnce(generatorYielding(wrapped));

    const result = await runTerminalEventCuration({
      event: { payload: 'p' },
      episodeKey: 'k',
    });

    expect(result.memories).toHaveLength(1);
    expect(result.memories[0].content).toBe('fenced reply');
    expect(querySpy).toHaveBeenCalledTimes(1);
  });

  it('passes the assembled prompt and the right model to the SDK', async () => {
    const response = JSON.stringify({
      memories: [{ content: 'ok', topics: ['t'] }],
    });
    querySpy.mockReturnValueOnce(generatorYielding(response));

    await runTerminalEventCuration({
      event: {
        id: 'github:org/repo#1',
        title: 'Test PR',
        payload: 'PAYLOAD-BODY',
      },
      episodeKey: 'github:org/repo#1',
      sourceTags: ['github'],
    });

    expect(querySpy).toHaveBeenCalledTimes(1);
    const call = querySpy.mock.calls[0][0];
    expect(call.options.model).toBe('claude-sonnet-4-6');
    expect(call.options.tools).toEqual([]);
    expect(call.options.persistSession).toBe(false);
    // System prompt mentions the segmentation contract; user message embeds
    // the payload and the episode key.
    expect(call.options.systemPrompt).toMatch(/segment/i);
    expect(call.prompt).toContain('PAYLOAD-BODY');
    expect(call.prompt).toContain('github:org/repo#1');
  });
});

describe('assembleTerminalEventPrompt (AGT-383)', () => {
  it('wraps the payload and header in <data> tags and embeds episode key', () => {
    const { systemPrompt, userMessage } = assembleTerminalEventPrompt({
      event: {
        id: 'linear:TEAM-9',
        title: 'Decide on cortex naming',
        payload: 'discussion of cortex-naming convention',
        metadata: { author: 'matt' },
      },
      episodeKey: 'linear:TEAM-9',
      sourceTags: ['linear', 'decision'],
    });

    expect(systemPrompt).toMatch(/terminal events/i);
    expect(systemPrompt).toMatch(/self-contained/i);
    expect(userMessage).toContain('<data source="event-header">');
    expect(userMessage).toContain('<data source="event-payload">');
    expect(userMessage).toContain('linear:TEAM-9');
    expect(userMessage).toContain('Decide on cortex naming');
    expect(userMessage).toContain('discussion of cortex-naming convention');
    expect(userMessage).toContain('source_tags: linear, decision');
    expect(userMessage).toContain('"author":"matt"');
  });
});
