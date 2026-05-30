import { describe, it, expect } from 'vitest';
import { runCuration, type StructuredPrompt } from '../../src/lib/curator.js';
import type { LlmClient, LlmRequest, LlmResponse } from '../../src/lib/llm/client.js';

// runCuration now takes an injected LlmClient — these tests drive it with a
// fake so curation parsing is exercised with zero network and zero SDK.

const PROMPT: StructuredPrompt = { systemPrompt: 'sys', userMessage: 'user' };

function client(text: string): LlmClient & { last?: LlmRequest } {
  const c: LlmClient & { last?: LlmRequest } = {
    name: 'fake',
    async complete(req: LlmRequest): Promise<LlmResponse> {
      c.last = req;
      return { text };
    },
  };
  return c;
}

describe('runCuration with injected LlmClient', () => {
  it('passes the curation schema and prompt through to the client', async () => {
    const c = client(JSON.stringify({ memories: [], purge_ids: [], long_term_events: [] }));
    await runCuration(PROMPT, c);
    expect(c.last?.system).toBe('sys');
    expect(c.last?.messages[0].content).toBe('user');
    expect(c.last?.schema?.name).toBe('curation_result');
  });

  it('parses the object shape into a CurationResult', async () => {
    const c = client(JSON.stringify({
      memories: [{ ts: '2026-01-01T00:00:00Z', author: 'me', content: 'shipped X', source_ids: ['e1'] }],
      purge_ids: ['e2'],
      long_term_events: [],
    }));
    const res = await runCuration(PROMPT, c);
    expect(res.memories).toHaveLength(1);
    expect(res.memories[0].content).toBe('shipped X');
    expect(res.purgeIds).toEqual(['e2']);
  });

  it('tolerates a fenced JSON response (local servers sometimes wrap)', async () => {
    const c = client('```json\n{"memories":[],"purge_ids":[],"long_term_events":[]}\n```');
    const res = await runCuration(PROMPT, c);
    expect(res.memories).toHaveLength(0);
  });

  it('accepts a bare-array legacy response', async () => {
    const c = client(JSON.stringify([{ content: 'm1', source_ids: [] }]));
    const res = await runCuration(PROMPT, c);
    expect(res.memories).toHaveLength(1);
    expect(res.purgeIds).toEqual([]);
  });

  it('throws on empty text', async () => {
    await expect(runCuration(PROMPT, client(''))).rejects.toThrow(/No result/);
  });

  it('propagates a skip from the client (router decided to skip)', async () => {
    const { LlmSkippedError } = await import('../../src/lib/llm/client.js');
    const skipping: LlmClient = {
      name: 'fake',
      async complete(): Promise<LlmResponse> { throw new LlmSkippedError('too big, no consent'); },
    };
    await expect(runCuration(PROMPT, skipping)).rejects.toBeInstanceOf(LlmSkippedError);
  });
});
