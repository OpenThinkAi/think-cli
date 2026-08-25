/**
 * Regression guard for the 2.6.0 timeout bug.
 *
 * `timeoutMs` was advertised as the request deadline but could not exceed
 * ~300s: Node's built-in fetch applies its own `headersTimeout`, and an
 * `AbortSignal` cannot raise it — a signal bounds a request from above, it does
 * not extend one. Long local generations therefore died at 304s reporting
 * "can't reach your LLM server — is it running?" about a server that was
 * healthy and still producing tokens.
 *
 * Measured before the fix: `threw after 301s, signal.aborted=false,
 * cause=UND_ERR_HEADERS_TIMEOUT` — our deadline never fired.
 *
 * Three things must stay true, and all three are pinned here:
 *   1. both undici ceilings are set to 0, so `timeoutMs` is the only deadline;
 *   2. the dispatcher rides ONLY our own undici fetch — Node's global fetch
 *      rejects a standalone-undici dispatcher with `UND_ERR_INVALID_ARG`, so
 *      attaching it to an injected fetch would break that caller;
 *   3. an undici timeout is classified as a TIMEOUT rather than an unreachable
 *      server, so the error names the knob instead of blaming the process.
 *
 * These are unit tests and cannot catch the whole bug: if someone swaps undici's
 * `fetch` back for the global one, every assertion here still passes while real
 * requests start dying at 300s again. The only check that covers that is an
 * actual request longer than 300s, which is why this fix was validated against a
 * server that deliberately withholds its response for 330s.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  OpenAiCompatibleLlmClient,
  NO_CEILING_AGENT_OPTIONS,
} from '../../src/lib/llm/openai-compatible.js';
import {
  LlmTimeoutError,
  LlmUnavailableError,
  type LlmRequest,
} from '../../src/lib/llm/client.js';

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

function clientWith(fetchImpl: typeof fetch, timeoutMs?: number) {
  return new OpenAiCompatibleLlmClient({
    endpoint: 'http://localhost:8000/v1',
    model: 'm',
    fetchImpl,
    timeoutMs,
  });
}

/** Reproduce the exact error shape Node throws: TypeError with a coded cause. */
function undiciFailure(code: string) {
  return Object.assign(new TypeError('fetch failed'), { cause: { code } });
}

describe('undici ceiling cannot silently cap timeoutMs', () => {
  it('disables BOTH undici ceilings, so timeoutMs is the only deadline', () => {
    // 0 means "no ceiling". Any non-zero value here silently re-caps every
    // request at that number, which is the bug this release fixes.
    expect(NO_CEILING_AGENT_OPTIONS.headersTimeout).toBe(0);
    expect(NO_CEILING_AGENT_OPTIONS.bodyTimeout).toBe(0);
  });

  it('does NOT attach the dispatcher to an injected fetch', async () => {
    // Node's global fetch rejects a standalone-undici dispatcher with
    // UND_ERR_INVALID_ARG. Attaching it unconditionally would break any caller
    // who injects the global fetch, so the dispatcher rides only our own.
    const fetchImpl = vi.fn(async () => okResponse()) as unknown as typeof fetch;
    await clientWith(fetchImpl).complete(req);
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as
      RequestInit & { dispatcher?: unknown };
    expect(init.dispatcher).toBeUndefined();
  });

  it('still passes our own AbortSignal — timeoutMs remains the real deadline', async () => {
    const fetchImpl = vi.fn(async () => okResponse()) as unknown as typeof fetch;
    await clientWith(fetchImpl).complete(req);
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeDefined();
  });
});

describe('failure classification', () => {
  it('UND_ERR_HEADERS_TIMEOUT is a timeout, not an unreachable server', async () => {
    const fetchImpl = vi.fn(async () => {
      throw undiciFailure('UND_ERR_HEADERS_TIMEOUT');
    }) as unknown as typeof fetch;

    const err = await clientWith(fetchImpl, 900_000).complete(req).catch((e) => e);
    expect(err).toBeInstanceOf(LlmTimeoutError);
    expect(err).not.toBeInstanceOf(LlmUnavailableError);
    // The old message sent people to debug a process that was working fine.
    expect(err.message).not.toMatch(/is it running/i);
  });

  it('UND_ERR_BODY_TIMEOUT is treated the same way', async () => {
    const fetchImpl = vi.fn(async () => {
      throw undiciFailure('UND_ERR_BODY_TIMEOUT');
    }) as unknown as typeof fetch;
    await expect(clientWith(fetchImpl).complete(req)).rejects.toBeInstanceOf(LlmTimeoutError);
  });

  it('a genuine connection refusal is still reported as unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw undiciFailure('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const err = await clientWith(fetchImpl).complete(req).catch((e) => e);
    expect(err).toBeInstanceOf(LlmUnavailableError);
    expect(err).not.toBeInstanceOf(LlmTimeoutError);
  });

  it('our own abort is still a timeout that names the configured budget', async () => {
    const fetchImpl = vi.fn((_u: string, init?: RequestInit) => {
      return new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
      });
    }) as unknown as typeof fetch;

    const err = await clientWith(fetchImpl, 20).complete(req).catch((e) => e);
    expect(err).toBeInstanceOf(LlmTimeoutError);
    expect(err.timeoutMs).toBe(20);
  });
});
