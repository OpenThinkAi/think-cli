/**
 * Provider registry + egress-consent tests.
 *
 * The centrepiece is `egress gate`: before this change, consent was attached to
 * the Anthropic client, so pointing the OpenAI-compatible client (then called
 * "local") at a public API shipped the entire cortex envelope with no gate at
 * all. Those tests are regression guards for a data-disclosure bug, not
 * feature tests — treat a failure there as a leak, not a nit.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  RegistryLlmClient,
  RouterLlmClient,
  resolveRegistry,
  resolveProviderConfig,
  selectProviderName,
  inferOffMachine,
  isLocalCurationActive,
  DEFAULT_CTX_BUDGET,
  type ResolvedProvider,
  type ResolvedLocalConfig,
} from '../../src/lib/llm/router.js';
import {
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
  LlmSkippedError,
  LlmTimeoutError,
  LlmContextOverflowError,
} from '../../src/lib/llm/client.js';
import type { LlmConfig } from '../../src/lib/config.js';

function fakeClient(name: string, text = '{}'): LlmClient & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    name,
    calls,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      calls.push(req);
      return { text };
    },
  };
}

function throwingClient(name: string, err: Error): LlmClient & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    name,
    calls,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      calls.push(req);
      throw err;
    },
  };
}

const req = (): LlmRequest => ({
  system: 'sys',
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 100,
});

/** A request that estimates well over a 1000-token budget. */
const bigReq = (): LlmRequest => ({
  system: 'x'.repeat(8000),
  messages: [{ role: 'user', content: 'y'.repeat(8000) }],
  maxTokens: 100,
});

const LOCAL_CFG: LlmConfig = {
  providers: {
    qwen: { kind: 'openai', endpoint: 'http://127.0.0.1:8000/v1', model: 'qwen' },
  },
  default: 'qwen',
};

const REMOTE_CFG: LlmConfig = {
  providers: {
    openai: { kind: 'openai', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o' },
  },
  default: 'openai',
};

afterEach(() => {
  delete process.env.THINK_LLM_PROVIDER;
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------

describe('inferOffMachine', () => {
  it.each(['http://localhost:8000/v1', 'http://127.0.0.1:8000/v1', 'http://[::1]:8000/v1'])(
    'treats loopback %s as on-machine',
    (url) => expect(inferOffMachine(url)).toBe(false),
  );

  it.each([
    'https://api.openai.com/v1',
    'https://api.deepseek.com/v1',
    'http://192.168.1.50:8000/v1',
  ])('treats %s as off-machine', (url) => expect(inferOffMachine(url)).toBe(true));

  it('treats an unparseable endpoint as off-machine (fail closed)', () => {
    expect(inferOffMachine('not a url')).toBe(true);
  });

  it('returns false for an empty endpoint (nothing configured, nothing sent)', () => {
    expect(inferOffMachine('')).toBe(false);
  });
});

describe('resolveProviderConfig', () => {
  it('infers offMachine from the endpoint when not declared', () => {
    expect(resolveProviderConfig('a', { kind: 'openai', endpoint: 'https://api.openai.com/v1' }).offMachine).toBe(true);
    expect(resolveProviderConfig('b', { kind: 'openai', endpoint: 'http://localhost:1/v1' }).offMachine).toBe(false);
  });

  it('honours an explicit offMachine:false for a trusted LAN host', () => {
    const p = resolveProviderConfig('lan', {
      kind: 'openai',
      endpoint: 'http://192.168.1.50:8000/v1',
      offMachine: false,
    });
    expect(p.offMachine).toBe(false);
  });

  it('forces offMachine for anthropic regardless of declaration', () => {
    const p = resolveProviderConfig('claude', { kind: 'anthropic', offMachine: false });
    expect(p.offMachine).toBe(true);
  });

  it('reads the key from apiKeyEnv in preference to a literal apiKey', () => {
    vi.stubEnv('MY_KEY', 'from-env');
    const p = resolveProviderConfig('x', {
      kind: 'openai',
      endpoint: 'http://localhost:1/v1',
      apiKey: 'literal',
      apiKeyEnv: 'MY_KEY',
    });
    expect(p.apiKey).toBe('from-env');
  });

  it('defaults ctxBudget when absent', () => {
    expect(resolveProviderConfig('x', { kind: 'openai', endpoint: 'http://localhost:1/v1' }).ctxBudget).toBe(
      DEFAULT_CTX_BUDGET,
    );
  });
});

describe('selectProviderName', () => {
  const registry = resolveRegistry({
    providers: {
      a: { kind: 'openai', endpoint: 'http://localhost:1/v1', model: 'm' },
      b: { kind: 'anthropic' },
    },
    default: 'a',
    operations: { summary: 'b' },
  });
  const cfg: LlmConfig = {
    providers: {},
    default: 'a',
    operations: { summary: 'b' },
  };

  it('prefers a per-operation mapping over the default', () => {
    expect(selectProviderName('summary', cfg, registry)).toBe('b');
  });

  it('falls back to the default for unmapped operations', () => {
    expect(selectProviderName('curation', cfg, registry)).toBe('a');
  });

  it('uses the sole provider when exactly one is registered and no default is set', () => {
    const one = resolveRegistry({ providers: { only: { kind: 'anthropic' } } });
    expect(selectProviderName('curation', {}, one)).toBe('only');
  });

  it('lets THINK_LLM_PROVIDER override when it names a registered provider', () => {
    process.env.THINK_LLM_PROVIDER = 'b';
    expect(selectProviderName('curation', cfg, registry)).toBe('b');
  });

  it('ignores THINK_LLM_PROVIDER when it names nothing in the registry', () => {
    process.env.THINK_LLM_PROVIDER = 'nope';
    expect(selectProviderName('curation', cfg, registry, () => {})).toBe('a');
  });

  it('WARNS when a legacy THINK_LLM_PROVIDER value is ignored in registry mode', () => {
    // 'local' is meaningful in legacy mode and meaningless here. Silently
    // dropping it makes the registry look broken to anyone with it in a profile.
    process.env.THINK_LLM_PROVIDER = 'local';
    const warnings: string[] = [];
    expect(selectProviderName('curation', cfg, registry, (m) => warnings.push(m))).toBe('a');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/THINK_LLM_PROVIDER="local"/);
    expect(warnings[0]).toMatch(/must match a provider name/);
  });

  it('does not warn for "auto", which is legitimately a no-op here', () => {
    process.env.THINK_LLM_PROVIDER = 'auto';
    const warnings: string[] = [];
    selectProviderName('curation', cfg, registry, (m) => warnings.push(m));
    expect(warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Egress gate — regression guards for a data-disclosure bug.
// ---------------------------------------------------------------------------

describe('RegistryLlmClient egress gate', () => {
  it('REFUSES to send to an off-machine provider without consent, and calls nothing', async () => {
    const spy = fakeClient('openai');
    const c = new RegistryLlmClient({
      operation: 'curation',
      registry: resolveRegistry(REMOTE_CFG),
      llm: REMOTE_CFG,
      clientFor: () => spy,
      consent: () => false,
    });
    await expect(c.complete(req())).rejects.toBeInstanceOf(LlmSkippedError);
    // The whole point: no bytes left the machine.
    expect(spy.calls).toHaveLength(0);
  });

  it('names the destination in the refusal so the user knows what nearly happened', async () => {
    const c = new RegistryLlmClient({
      operation: 'curation',
      registry: resolveRegistry(REMOTE_CFG),
      llm: REMOTE_CFG,
      clientFor: () => fakeClient('openai'),
      consent: () => false,
    });
    await expect(c.complete(req())).rejects.toThrow(/api\.openai\.com/);
  });

  it('allows the same off-machine provider once consent is granted', async () => {
    const spy = fakeClient('openai');
    const c = new RegistryLlmClient({
      operation: 'curation',
      registry: resolveRegistry(REMOTE_CFG),
      llm: REMOTE_CFG,
      clientFor: () => spy,
      consent: () => true,
    });
    await expect(c.complete(req())).resolves.toEqual({ text: '{}' });
    expect(spy.calls).toHaveLength(1);
  });

  it('needs NO consent for a loopback provider — nothing leaves the machine', async () => {
    const spy = fakeClient('qwen');
    const c = new RegistryLlmClient({
      operation: 'curation',
      registry: resolveRegistry(LOCAL_CFG),
      llm: LOCAL_CFG,
      clientFor: () => spy,
      consent: () => false,
    });
    await expect(c.complete(req())).resolves.toEqual({ text: '{}' });
    expect(spy.calls).toHaveLength(1);
  });

  it('gates egress BEFORE the size check, so an oversized off-machine task still sends nothing', async () => {
    const cfg: LlmConfig = {
      providers: { openai: { kind: 'openai', endpoint: 'https://api.openai.com/v1', model: 'm', ctxBudget: 10 } },
      default: 'openai',
      fallback: 'openai',
    };
    const spy = fakeClient('openai');
    const c = new RegistryLlmClient({
      operation: 'curation',
      registry: resolveRegistry(cfg),
      llm: cfg,
      clientFor: () => spy,
      consent: () => false,
    });
    await expect(c.complete(bigReq())).rejects.toBeInstanceOf(LlmSkippedError);
    expect(spy.calls).toHaveLength(0);
  });
});

describe('RouterLlmClient (legacy) egress gate', () => {
  const remoteLocal: ResolvedLocalConfig = {
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    apiKey: 'k',
    ctxBudget: 100000,
  };
  const loopbackLocal: ResolvedLocalConfig = {
    endpoint: 'http://localhost:9999/v1',
    model: 'qwen',
    apiKey: 'k',
    ctxBudget: 100000,
  };

  it('refuses a REMOTE cortex.local endpoint without consent (the original hole)', async () => {
    const spy = fakeClient('local');
    const c = new RouterLlmClient({
      provider: 'auto',
      local: remoteLocal,
      localClient: () => spy,
      anthropicClient: () => fakeClient('anthropic'),
      consent: () => false,
    });
    await expect(c.complete(req())).rejects.toBeInstanceOf(LlmSkippedError);
    expect(spy.calls).toHaveLength(0);
  });

  it('still allows a loopback cortex.local endpoint without consent', async () => {
    const spy = fakeClient('local');
    const c = new RouterLlmClient({
      provider: 'auto',
      local: loopbackLocal,
      localClient: () => spy,
      anthropicClient: () => fakeClient('anthropic'),
      consent: () => false,
    });
    await expect(c.complete(req())).resolves.toEqual({ text: '{}' });
    expect(spy.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Failure shaping
// ---------------------------------------------------------------------------

describe('timeout is not an outage', () => {
  const timeout = new LlmTimeoutError('endpoint did not respond within 900s', 'http://localhost:8000/v1', 900_000);

  it('registry: reports a timeout as a skip that names the timeoutMs knob', async () => {
    const c = new RegistryLlmClient({
      operation: 'curation',
      registry: resolveRegistry(LOCAL_CFG),
      llm: LOCAL_CFG,
      clientFor: () => throwingClient('qwen', timeout),
      consent: () => false,
    });
    const err = await c.complete(req()).catch((e) => e);
    expect(err).toBeInstanceOf(LlmSkippedError);
    expect(err.message).toMatch(/timeoutMs/);
    // Must NOT tell the user the server is down — it isn't.
    expect(err.message).not.toMatch(/is it running/);
  });

  it('legacy: same treatment', async () => {
    const c = new RouterLlmClient({
      provider: 'local',
      local: { endpoint: 'http://localhost:9999/v1', model: 'q', apiKey: 'k', ctxBudget: 100000 },
      localClient: () => throwingClient('local', timeout),
      anthropicClient: () => fakeClient('anthropic'),
      consent: () => false,
    });
    const err = await c.complete(req()).catch((e) => e);
    expect(err).toBeInstanceOf(LlmSkippedError);
    expect(err.message).toMatch(/timeoutMs/);
  });
});

describe('RegistryLlmClient fallback', () => {
  const cfg: LlmConfig = {
    providers: {
      qwen: { kind: 'openai', endpoint: 'http://127.0.0.1:8000/v1', model: 'q', ctxBudget: 1000 },
      claude: { kind: 'anthropic' },
    },
    default: 'qwen',
    fallback: 'claude',
  };

  it('falls back to the configured provider when over budget, with consent', async () => {
    const anthropic = fakeClient('claude', 'from-claude');
    const c = new RegistryLlmClient({
      operation: 'curation',
      registry: resolveRegistry(cfg),
      llm: cfg,
      clientFor: (p) => (p.kind === 'anthropic' ? anthropic : fakeClient('qwen')),
      consent: () => true,
      warn: () => {},
    });
    await expect(c.complete(bigReq())).resolves.toEqual({ text: 'from-claude' });
    expect(anthropic.calls).toHaveLength(1);
  });

  it('skips instead of falling back to an off-machine provider without consent', async () => {
    const anthropic = fakeClient('claude');
    const c = new RegistryLlmClient({
      operation: 'curation',
      registry: resolveRegistry(cfg),
      llm: cfg,
      clientFor: (p) => (p.kind === 'anthropic' ? anthropic : fakeClient('qwen')),
      consent: () => false,
      warn: () => {},
    });
    await expect(c.complete(bigReq())).rejects.toBeInstanceOf(LlmSkippedError);
    expect(anthropic.calls).toHaveLength(0);
  });

  it('skips when no fallback is configured', async () => {
    const noFb: LlmConfig = { ...cfg, fallback: undefined };
    const c = new RegistryLlmClient({
      operation: 'curation',
      registry: resolveRegistry(noFb),
      llm: noFb,
      clientFor: () => fakeClient('qwen'),
      consent: () => true,
    });
    await expect(c.complete(bigReq())).rejects.toThrow(/no fallback provider is configured/);
  });

  it('routes a runtime context overflow to the fallback too', async () => {
    const anthropic = fakeClient('claude', 'from-claude');
    const c = new RegistryLlmClient({
      operation: 'curation',
      registry: resolveRegistry(cfg),
      llm: cfg,
      clientFor: (p) =>
        p.kind === 'anthropic' ? anthropic : throwingClient('qwen', new LlmContextOverflowError('too big')),
      consent: () => true,
      warn: () => {},
    });
    await expect(c.complete(req())).resolves.toEqual({ text: 'from-claude' });
  });

  it('skips with an actionable message when no provider is selected', async () => {
    const ambiguous: LlmConfig = {
      providers: {
        a: { kind: 'openai', endpoint: 'http://localhost:1/v1', model: 'm' },
        b: { kind: 'openai', endpoint: 'http://localhost:2/v1', model: 'm' },
      },
    };
    const c = new RegistryLlmClient({
      operation: 'curation',
      registry: resolveRegistry(ambiguous),
      llm: ambiguous,
      clientFor: () => fakeClient('x'),
      consent: () => true,
    });
    await expect(c.complete(req())).rejects.toThrow(/no LLM provider selected/);
  });
});

describe('isLocalCurationActive with a registry', () => {
  it('true when curation resolves to an openai-compatible provider', () => {
    expect(isLocalCurationActive({ llm: LOCAL_CFG })).toBe(true);
  });

  it('false when curation resolves to anthropic', () => {
    const cfg: LlmConfig = { providers: { c: { kind: 'anthropic' } }, default: 'c' };
    expect(isLocalCurationActive({ llm: cfg })).toBe(false);
  });

  it('registry config wins over the legacy local block', () => {
    const cfg: LlmConfig = { providers: { c: { kind: 'anthropic' } }, default: 'c' };
    expect(
      isLocalCurationActive({
        llm: cfg,
        llmProvider: 'local',
        local: { endpoint: 'http://localhost:1/v1', model: 'm' },
      }),
    ).toBe(false);
  });
});
