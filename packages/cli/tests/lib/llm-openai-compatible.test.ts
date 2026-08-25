/**
 * Transport-level tests for the OpenAI-compatible client: the request deadline
 * and the reasoning-suppression flag.
 *
 * The timeout test is a regression guard. Previously this client passed no
 * signal, so Node/undici aborted at its own default and the abort surfaced as
 * `LlmUnavailableError` — "is it running?" for a server that was running fine
 * and still generating. Distinguishing the two is the whole point.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  OpenAiCompatibleLlmClient,
  DEFAULT_TIMEOUT_MS,
} from '../../src/lib/llm/openai-compatible.js';
import { LlmTimeoutError, LlmUnavailableError, type LlmRequest } from '../../src/lib/llm/client.js';

const req: LlmRequest = {
  system: 'sys',
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 100,
};

function okResponse(content = 'result') {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('OpenAiCompatibleLlmClient timeout', () => {
  it('raises LlmTimeoutError — NOT LlmUnavailableError — when the deadline passes', async () => {
    // A fetch that never settles until aborted, i.e. a healthy but slow server.
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
      });
    }) as unknown as typeof fetch;

    const c = new OpenAiCompatibleLlmClient({
      endpoint: 'http://localhost:8000/v1',
      model: 'm',
      fetchImpl,
      timeoutMs: 20,
    });

    const err = await c.complete(req).catch((e) => e);
    expect(err).toBeInstanceOf(LlmTimeoutError);
    expect(err).not.toBeInstanceOf(LlmUnavailableError);
    expect(err.timeoutMs).toBe(20);
    expect(err.endpoint).toBe('http://localhost:8000/v1');
    // The message must point at tuning, not at a dead process.
    expect(err.message).toMatch(/still be generating|raise timeoutMs/i);
  });

  it('passes an AbortSignal on every request', async () => {
    const fetchImpl = vi.fn(async () => okResponse()) as unknown as typeof fetch;
    const c = new OpenAiCompatibleLlmClient({
      endpoint: 'http://localhost:8000/v1',
      model: 'm',
      fetchImpl,
    });
    await c.complete(req);
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeDefined();
  });

  it('still reports a genuine connection failure as LlmUnavailableError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    const c = new OpenAiCompatibleLlmClient({
      endpoint: 'http://localhost:8000/v1',
      model: 'm',
      fetchImpl,
    });
    const err = await c.complete(req).catch((e) => e);
    expect(err).toBeInstanceOf(LlmUnavailableError);
    expect(err).not.toBeInstanceOf(LlmTimeoutError);
  });

  it('defaults the deadline well above undici\'s 300s, which is what broke it', () => {
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(300_000);
  });

  it('does not leave a pending timer that would keep the process alive', async () => {
    const fetchImpl = vi.fn(async () => okResponse()) as unknown as typeof fetch;
    const c = new OpenAiCompatibleLlmClient({
      endpoint: 'http://localhost:8000/v1',
      model: 'm',
      fetchImpl,
      timeoutMs: 60_000,
    });
    const before = process.getActiveResourcesInfo?.().filter((r) => r === 'Timeout').length ?? 0;
    await c.complete(req);
    const after = process.getActiveResourcesInfo?.().filter((r) => r === 'Timeout').length ?? 0;
    expect(after).toBeLessThanOrEqual(before);
  });
});

describe('OpenAiCompatibleLlmClient disableThinking', () => {
  async function bodyFor(disableThinking: boolean | undefined) {
    const fetchImpl = vi.fn(async () => okResponse()) as unknown as typeof fetch;
    const c = new OpenAiCompatibleLlmClient({
      endpoint: 'http://localhost:8000/v1',
      model: 'm',
      fetchImpl,
      disableThinking,
    });
    await c.complete(req);
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    return JSON.parse(init.body as string);
  }

  it('sends chat_template_kwargs.enable_thinking=false when enabled', async () => {
    expect(await bodyFor(true)).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
  });

  it('omits the field entirely by default (no behaviour change for existing users)', async () => {
    expect(await bodyFor(undefined)).not.toHaveProperty('chat_template_kwargs');
  });
});

describe('OpenAiCompatibleLlmClient never sends tools', () => {
  it('omits the tools field — mlx_lm.server crashes when it is present', async () => {
    const fetchImpl = vi.fn(async () => okResponse()) as unknown as typeof fetch;
    const c = new OpenAiCompatibleLlmClient({
      endpoint: 'http://localhost:8000/v1',
      model: 'm',
      fetchImpl,
    });
    await c.complete({
      ...req,
      schema: { name: 's', schema: { type: 'object', properties: {} } },
    });
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body).not.toHaveProperty('tools');
    expect(body.response_format.type).toBe('json_schema');
  });

  it('uses the configured label as the client name for logs', () => {
    const c = new OpenAiCompatibleLlmClient({
      endpoint: 'http://localhost:8000/v1',
      model: 'm',
      label: 'qwen',
    });
    expect(c.name).toBe('qwen');
  });
});
