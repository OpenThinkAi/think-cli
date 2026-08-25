/**
 * `strictSchema` — server-side shape enforcement, and the failure taxonomy the
 * daemon workers depend on.
 *
 * The point of these tests is that porting an operation onto `LlmClient` must
 * not silently weaken it. Two ops (compaction, supersession) previously called
 * the Messages API directly with forced tool_use, and treated a malformed
 * response as a bug rather than a retry. If `strictSchema` ever stops forcing
 * tool_use, or the error taxonomy blurs, those ops degrade quietly — the exact
 * failure mode this suite exists to catch.
 */

import { describe, it, expect, vi } from 'vitest';
import { AnthropicLlmClient } from '../../src/lib/llm/anthropic.js';
import {
  LlmStructuredOutputError,
  type LlmRequest,
} from '../../src/lib/llm/client.js';

vi.mock('../../src/lib/llm-consent.js', () => ({
  requireLlmConsent: vi.fn(),
  hasLlmConsent: vi.fn(() => true),
  LlmConsentError: class LlmConsentError extends Error {},
}));

const SCHEMA = {
  name: 'submit_thing',
  description: 'Submit the thing.',
  schema: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
  },
};

const strictReq = (): LlmRequest => ({
  system: 'sys',
  messages: [{ role: 'user', content: 'go' }],
  maxTokens: 500,
  schema: SCHEMA,
  strictSchema: true,
});

function toolUseResponse(input: unknown, stop_reason = 'tool_use') {
  return { content: [{ type: 'tool_use', name: 'submit_thing', input }], stop_reason };
}

describe('strictSchema forces tool_use on Anthropic', () => {
  it('sends the schema as a forced tool and returns the validated input as json', async () => {
    const create = vi.fn(async () => toolUseResponse({ value: 'ok' }));
    const c = new AnthropicLlmClient({ messagesCreate: create });

    const res = await c.complete(strictReq());

    const body = create.mock.calls[0][0] as Record<string, any>;
    expect(body.tools[0].name).toBe('submit_thing');
    expect(body.tool_choice).toMatchObject({ type: 'tool', name: 'submit_thing' });
    // Parallel tool use would let the model emit two payloads; the caller
    // reads exactly one.
    expect(body.tool_choice.disable_parallel_tool_use).toBe(true);

    expect(res.json).toEqual({ value: 'ok' });
    // text mirrors json so callers that parse text keep working.
    expect(JSON.parse(res.text)).toEqual({ value: 'ok' });
  });

  it('does NOT force tool_use without strictSchema — the tuned prompt path is preserved', async () => {
    const create = vi.fn(async () => toolUseResponse({ value: 'ok' }));
    async function* fakeQuery() {
      yield { result: 'plain text answer' } as never;
    }
    const c = new AnthropicLlmClient({
      queryFn: fakeQuery as never,
      messagesCreate: create,
    });

    const res = await c.complete({ ...strictReq(), strictSchema: false });

    expect(create).not.toHaveBeenCalled();
    expect(res.text).toBe('plain text answer');
    expect(res.json).toBeUndefined();
  });

  it('applies cache_control to the system block only when cacheSystem is set', async () => {
    const create = vi.fn(async () => toolUseResponse({ value: 'ok' }));
    const c = new AnthropicLlmClient({ messagesCreate: create });

    await c.complete({ ...strictReq(), cacheSystem: true });
    expect((create.mock.calls[0][0] as any).system[0].cache_control).toEqual({ type: 'ephemeral' });

    await c.complete(strictReq());
    expect((create.mock.calls[1][0] as any).system[0].cache_control).toBeUndefined();
  });
});

describe('failure taxonomy', () => {
  it('missing tool_use → LlmStructuredOutputError with truncated=false (retryable)', async () => {
    const create = vi.fn(async () => ({
      content: [{ type: 'text', text: 'i forgot the tool' }],
      stop_reason: 'end_turn',
    }));
    const c = new AnthropicLlmClient({ messagesCreate: create });

    const err = await c.complete(strictReq()).catch((e) => e);
    expect(err).toBeInstanceOf(LlmStructuredOutputError);
    expect(err.truncated).toBe(false);
  });

  it('missing tool_use because of max_tokens → truncated=true (NOT retryable)', async () => {
    const create = vi.fn(async () => ({ content: [], stop_reason: 'max_tokens' }));
    const c = new AnthropicLlmClient({ messagesCreate: create });

    const err = await c.complete(strictReq()).catch((e) => e);
    expect(err).toBeInstanceOf(LlmStructuredOutputError);
    expect(err.truncated).toBe(true);
    // The message must name the budget, since that is the fix.
    expect(err.message).toMatch(/max_tokens=500/);
  });

  it('a transport error propagates untouched — never mistaken for a shape failure', async () => {
    const boom = new Error('529 overloaded');
    const create = vi.fn(async () => {
      throw boom;
    });
    const c = new AnthropicLlmClient({ messagesCreate: create });

    const err = await c.complete(strictReq()).catch((e) => e);
    expect(err).toBe(boom);
    expect(err).not.toBeInstanceOf(LlmStructuredOutputError);
  });

  it('flags truncation on an otherwise valid response', async () => {
    const create = vi.fn(async () => toolUseResponse({ value: 'ok' }, 'max_tokens'));
    const c = new AnthropicLlmClient({ messagesCreate: create });
    const res = await c.complete(strictReq());
    expect(res.truncated).toBe(true);
  });
});
