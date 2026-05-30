import { describe, it, expect, vi } from 'vitest';
import { LocalLlmClient, isOverflow } from '../../src/lib/llm/local.js';
import { LlmContextOverflowError, LlmUnavailableError, type LlmRequest } from '../../src/lib/llm/client.js';

function req(): LlmRequest {
  return { system: 'sys', messages: [{ role: 'user', content: 'hi' }], maxTokens: 64 };
}

/** Build a fake `fetch` returning a chat-completions body. */
function okFetch(content: string): typeof fetch {
  return vi.fn(async () => new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof fetch;
}

describe('LocalLlmClient', () => {
  it('POSTs to <endpoint>/chat/completions with bearer + model', async () => {
    const spy = vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
      { status: 200 },
    ));
    const c = new LocalLlmClient({
      endpoint: 'http://localhost:1234/v1/', model: 'qwen', apiKey: 'tok', fetchImpl: spy as unknown as typeof fetch,
    });
    const res = await c.complete(req());
    expect(res.text).toBe('ok');
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe('http://localhost:1234/v1/chat/completions'); // trailing slash trimmed
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe('qwen');
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('strips Qwen special tokens from output', async () => {
    const c = new LocalLlmClient({ endpoint: 'http://x/v1', model: 'q', fetchImpl: okFetch('<|im_start|>hello<|im_end|>') });
    const res = await c.complete(req());
    expect(res.text).toBe('hello');
  });

  it('sends response_format json_schema when schema present', async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200 }));
    const c = new LocalLlmClient({ endpoint: 'http://x/v1', model: 'q', fetchImpl: spy as unknown as typeof fetch });
    await c.complete({ ...req(), schema: { name: 'out', schema: { type: 'object' } } });
    const body = JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.name).toBe('out');
    expect(body.response_format.json_schema.strict).toBe(true);
  });

  it('maps 413 to LlmContextOverflowError', async () => {
    const f = vi.fn(async () => new Response('payload too large', { status: 413 }));
    const c = new LocalLlmClient({ endpoint: 'http://x/v1', model: 'q', fetchImpl: f as unknown as typeof fetch });
    await expect(c.complete(req())).rejects.toBeInstanceOf(LlmContextOverflowError);
  });

  it('maps 400 "context length" body to LlmContextOverflowError', async () => {
    const f = vi.fn(async () => new Response('error: maximum context length exceeded', { status: 400 }));
    const c = new LocalLlmClient({ endpoint: 'http://x/v1', model: 'q', fetchImpl: f as unknown as typeof fetch });
    await expect(c.complete(req())).rejects.toBeInstanceOf(LlmContextOverflowError);
  });

  it('treats a generic 400 as a plain error, NOT overflow', async () => {
    const f = vi.fn(async () => new Response('bad request: unknown field', { status: 400 }));
    const c = new LocalLlmClient({ endpoint: 'http://x/v1', model: 'q', fetchImpl: f as unknown as typeof fetch });
    await expect(c.complete(req())).rejects.not.toBeInstanceOf(LlmContextOverflowError);
  });

  it('throws LlmUnavailableError (with endpoint) on transport failure', async () => {
    const f = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const c = new LocalLlmClient({ endpoint: 'http://x/v1', model: 'q', fetchImpl: f as unknown as typeof fetch });
    await expect(c.complete(req())).rejects.toBeInstanceOf(LlmUnavailableError);
    await c.complete(req()).catch((e) => {
      expect(e).toBeInstanceOf(LlmUnavailableError);
      expect((e as LlmUnavailableError).endpoint).toBe('http://x/v1');
      expect((e as Error).message).toMatch(/cannot reach local LLM endpoint/);
    });
  });
});

describe('isOverflow', () => {
  it('413 always', () => expect(isOverflow(413, '')).toBe(true));
  it('400 with hint', () => expect(isOverflow(400, 'context window exceeded')).toBe(true));
  it('400 without hint', () => expect(isOverflow(400, 'missing field foo')).toBe(false));
  it('500 never', () => expect(isOverflow(500, 'context length')).toBe(false));
});
