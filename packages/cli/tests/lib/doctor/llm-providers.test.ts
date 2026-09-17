/**
 * Unit tests for checkLlmProviders() — AGT-1308 AC1/AC5.
 *
 * `undici`'s fetch is mocked outright, so this suite never opens a socket and
 * never reaches a model server. The two behaviours it pins are the ones the
 * ticket names: warn (not fail) when a fallback is configured, and a liveness
 * probe that carries no cortex content and no credential.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('undici', () => ({
  fetch: vi.fn(),
  Agent: class {},
}));

import { fetch as undiciFetch } from 'undici';
import {
  checkLlmProviders,
  probeProviderEndpoint,
  LLM_PROVIDERS_CHECK_ID,
  PROBE_TIMEOUT_MS,
  type ProviderProbe,
} from '../../../src/lib/doctor/llm-providers.js';
import type { ResolvedProvider } from '../../../src/lib/llm/router.js';

const mockedFetch = vi.mocked(undiciFetch);

function provider(partial: Partial<ResolvedProvider> & { name: string }): ResolvedProvider {
  return {
    kind: 'openai',
    endpoint: 'http://127.0.0.1:8000/v1',
    model: 'test-model',
    apiKey: 'secret-key-do-not-send',
    offMachine: false,
    ctxBudget: 28_000,
    timeoutMs: 900_000,
    disableThinking: false,
    ...partial,
  };
}

function reachable(name: string): ProviderProbe {
  return { name, status: 'reachable', detail: 'HTTP 200' };
}

function unreachable(name: string): ProviderProbe {
  return { name, status: 'unreachable', detail: 'ECONNREFUSED' };
}

describe('checkLlmProviders (AGT-1308)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes when nothing is configured', async () => {
    const result = await checkLlmProviders({
      providers: [],
      probe: async () => {
        throw new Error('nothing to probe');
      },
    });

    expect(result).toEqual({
      id: LLM_PROVIDERS_CHECK_ID,
      status: 'pass',
      detail: 'No LLM provider configured.',
      fixable: false,
    });
  });

  it('passes when every configured provider answers', async () => {
    const result = await checkLlmProviders({
      providers: [provider({ name: 'qwen' }), provider({ name: 'deepseek' })],
      probe: async (p) => reachable(p.name),
    });

    expect(result.status).toBe('pass');
    expect(result.detail).toContain('2 providers reachable');
  });

  it('warns, never fails, when a provider is down but a fallback is configured', async () => {
    // This is the work Mac: compaction points at a local server that is often
    // down, and `cortex.llm.fallback` is the user saying "go elsewhere".
    const result = await checkLlmProviders({
      providers: [provider({ name: 'qwen' })],
      hasFallback: true,
      probe: async (p) => unreachable(p.name),
    });

    expect(result.status).toBe('warn');
    expect(result.fixable).toBe(false);
    expect(result.detail).toContain('qwen');
    expect(result.detail).toContain('A fallback is configured');
  });

  it('fails when a provider is down and there is nowhere to fall back to', async () => {
    const result = await checkLlmProviders({
      providers: [provider({ name: 'qwen' }), provider({ name: 'claude', kind: 'anthropic' })],
      hasFallback: false,
      probe: async (p) => (p.name === 'qwen' ? unreachable(p.name) : reachable(p.name)),
    });

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('1 provider unreachable');
    expect(result.detail).toContain('cortex.llm.fallback');
    // Never fixable: doctor cannot start a model server, and must not rewrite
    // someone's provider config to route around one.
    expect(result.fixable).toBe(false);
  });

  it('passes the short probe deadline down, not the provider timeout', async () => {
    const seen: number[] = [];
    await checkLlmProviders({
      providers: [provider({ name: 'qwen', timeoutMs: 900_000 })],
      probe: async (p, timeoutMs) => {
        seen.push(timeoutMs);
        return reachable(p.name);
      },
    });

    expect(seen).toEqual([PROBE_TIMEOUT_MS]);
    expect(PROBE_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });
});

describe('probeProviderEndpoint (AGT-1308 AC5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is a bare GET of /models — no body, no headers, no API key', async () => {
    mockedFetch.mockResolvedValue({ status: 200 } as never);

    const probe = await probeProviderEndpoint(provider({ name: 'qwen' }), 1_234);

    expect(probe.status).toBe('reachable');
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockedFetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8000/v1/models');
    expect(init?.method).toBe('GET');
    expect(init).not.toHaveProperty('body');
    expect(init).not.toHaveProperty('headers');
    // The provider's key is never sent: an HTTP status already proves liveness.
    expect(JSON.stringify(init ?? {})).not.toContain('secret-key-do-not-send');
  });

  it('bounds the request with the caller-supplied deadline', async () => {
    mockedFetch.mockResolvedValue({ status: 200 } as never);

    await probeProviderEndpoint(provider({ name: 'qwen' }), 1_234);

    const init = mockedFetch.mock.calls[0][1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('counts any HTTP status as reachable — even 401', async () => {
    mockedFetch.mockResolvedValue({ status: 401 } as never);

    const probe = await probeProviderEndpoint(provider({ name: 'qwen' }));

    expect(probe.status).toBe('reachable');
    expect(probe.detail).toContain('HTTP 401');
  });

  it('collapses a duplicated slash in the configured endpoint', async () => {
    mockedFetch.mockResolvedValue({ status: 200 } as never);

    await probeProviderEndpoint(provider({ name: 'qwen', endpoint: 'http://127.0.0.1:8000/v1/' }));

    expect(mockedFetch.mock.calls[0][0]).toBe('http://127.0.0.1:8000/v1/models');
  });

  it('reports a transport error as unreachable, naming the endpoint', async () => {
    mockedFetch.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:8000'));

    const probe = await probeProviderEndpoint(provider({ name: 'qwen' }));

    expect(probe.status).toBe('unreachable');
    expect(probe.detail).toContain('http://127.0.0.1:8000/v1');
    expect(probe.detail).toContain('ECONNREFUSED');
  });

  it('skips a transport with no liveness endpoint instead of calling it unreachable', async () => {
    const probe = await probeProviderEndpoint(
      provider({ name: 'claude', kind: 'anthropic', endpoint: '' }),
    );

    expect(probe.status).toBe('skipped');
    expect(probe.detail).toContain('anthropic transport');
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('reports an openai provider with no endpoint as unreachable', async () => {
    const probe = await probeProviderEndpoint(provider({ name: 'broken', endpoint: '' }));

    expect(probe).toEqual({
      name: 'broken',
      status: 'unreachable',
      detail: 'no endpoint configured',
    });
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});
