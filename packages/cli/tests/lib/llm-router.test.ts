import { describe, it, expect, vi } from 'vitest';
import {
  RouterLlmClient,
  resolveLocalConfig,
  resolveProvider,
  DEFAULT_CTX_BUDGET,
  type ResolvedLocalConfig,
} from '../../src/lib/llm/router.js';
import {
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
  LlmContextOverflowError,
  LlmSkippedError,
  LlmUnavailableError,
  estimateTokens,
} from '../../src/lib/llm/client.js';

// ---------------------------------------------------------------------------
// Fake clients — the whole point of the LlmClient boundary. No network, no SDK.
// ---------------------------------------------------------------------------

/** A fake that records calls and returns a canned response. */
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

/** A fake that throws the given error on every call. */
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

const LOCAL: ResolvedLocalConfig = {
  endpoint: 'http://localhost:9999/v1',
  model: 'qwen-test',
  apiKey: 'lm-studio',
  ctxBudget: 1000,
};
const NO_LOCAL: ResolvedLocalConfig = { endpoint: '', model: '', apiKey: 'lm-studio', ctxBudget: 1000 };

function smallReq(): LlmRequest {
  return { system: 'sys', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 };
}
/** A request whose char count estimates well above LOCAL.ctxBudget (1000 tok). */
function bigReq(): LlmRequest {
  return { system: 'x'.repeat(8000), messages: [{ role: 'user', content: 'y'.repeat(8000) }], maxTokens: 100 };
}

describe('estimateTokens', () => {
  it('counts ~chars/4 across system + messages + schema', () => {
    const req: LlmRequest = {
      system: 'a'.repeat(40),
      messages: [{ role: 'user', content: 'b'.repeat(40) }],
      maxTokens: 10,
    };
    expect(estimateTokens(req)).toBe(20); // 80 chars / 4
  });
});

describe('resolveProvider', () => {
  const orig = process.env.THINK_LLM_PROVIDER;
  afterEachRestore('THINK_LLM_PROVIDER', orig);

  it('defaults to auto', () => {
    delete process.env.THINK_LLM_PROVIDER;
    expect(resolveProvider(undefined)).toBe('auto');
  });
  it('honours config', () => {
    delete process.env.THINK_LLM_PROVIDER;
    expect(resolveProvider('local')).toBe('local');
  });
  it('env overrides config', () => {
    process.env.THINK_LLM_PROVIDER = 'anthropic';
    expect(resolveProvider('local')).toBe('anthropic');
  });
  it('falls back to auto on garbage', () => {
    process.env.THINK_LLM_PROVIDER = 'nonsense';
    expect(resolveProvider(undefined)).toBe('auto');
  });
});

describe('resolveLocalConfig', () => {
  it('defaults ctxBudget and apiKey when absent', () => {
    for (const k of ['THINK_LOCAL_ENDPOINT', 'THINK_LOCAL_MODEL', 'THINK_LOCAL_API_KEY', 'THINK_LOCAL_CTX_BUDGET']) {
      delete process.env[k];
    }
    const r = resolveLocalConfig(undefined);
    expect(r.endpoint).toBe('');
    expect(r.apiKey).toBe('lm-studio');
    expect(r.ctxBudget).toBe(DEFAULT_CTX_BUDGET);
  });
  it('env overrides config', () => {
    process.env.THINK_LOCAL_ENDPOINT = 'http://env:1/v1';
    const r = resolveLocalConfig({ endpoint: 'http://cfg:1/v1', model: 'm' });
    expect(r.endpoint).toBe('http://env:1/v1');
    expect(r.model).toBe('m');
    delete process.env.THINK_LOCAL_ENDPOINT;
  });
});

describe('RouterLlmClient policy', () => {
  it('provider=anthropic → always Anthropic, never touches local', async () => {
    const local = fakeClient('local');
    const anthropic = fakeClient('anthropic', 'A');
    const r = makeRouter({ provider: 'anthropic', local: LOCAL, localC: local, anthropicC: anthropic });
    const res = await r.complete(bigReq());
    expect(res.text).toBe('A');
    expect(local.calls).toHaveLength(0);
    expect(anthropic.calls).toHaveLength(1);
  });

  it('provider=auto, no local endpoint → Anthropic (inert/legacy)', async () => {
    const local = fakeClient('local');
    const anthropic = fakeClient('anthropic', 'A');
    const r = makeRouter({ provider: 'auto', local: NO_LOCAL, localC: local, anthropicC: anthropic });
    await r.complete(smallReq());
    expect(local.calls).toHaveLength(0);
    expect(anthropic.calls).toHaveLength(1);
  });

  it('provider=auto, fits budget → local', async () => {
    const local = fakeClient('local', 'L');
    const anthropic = fakeClient('anthropic', 'A');
    const r = makeRouter({ provider: 'auto', local: LOCAL, localC: local, anthropicC: anthropic });
    const res = await r.complete(smallReq());
    expect(res.text).toBe('L');
    expect(local.calls).toHaveLength(1);
    expect(anthropic.calls).toHaveLength(0);
  });

  it('provider=auto, over budget, consent → Anthropic fallback + warns', async () => {
    const local = fakeClient('local', 'L');
    const anthropic = fakeClient('anthropic', 'A');
    const warn = vi.fn();
    const r = makeRouter({
      provider: 'auto', local: LOCAL, localC: local, anthropicC: anthropic,
      consent: () => true, warn,
    });
    const res = await r.complete(bigReq());
    expect(res.text).toBe('A');
    expect(local.calls).toHaveLength(0); // never even attempted — estimate said too big
    expect(anthropic.calls).toHaveLength(1);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('provider=auto, over budget, NO consent → skip + warn (no cloud send)', async () => {
    const local = fakeClient('local', 'L');
    const anthropic = fakeClient('anthropic', 'A');
    const r = makeRouter({
      provider: 'auto', local: LOCAL, localC: local, anthropicC: anthropic, consent: () => false,
    });
    await expect(r.complete(bigReq())).rejects.toBeInstanceOf(LlmSkippedError);
    expect(anthropic.calls).toHaveLength(0); // nothing left the machine
  });

  it('provider=auto, fits estimate but server overflows, consent → runtime fallback', async () => {
    const local = throwingClient('local', new LlmContextOverflowError('413 too big'));
    const anthropic = fakeClient('anthropic', 'A');
    const r = makeRouter({
      provider: 'auto', local: LOCAL, localC: local, anthropicC: anthropic, consent: () => true, warn: vi.fn(),
    });
    const res = await r.complete(smallReq());
    expect(local.calls).toHaveLength(1); // attempted
    expect(res.text).toBe('A'); // then fell back
  });

  it('provider=auto, local UNAVAILABLE → skip (NOT a cloud reroute, even with consent)', async () => {
    const local = throwingClient('local', new LlmUnavailableError('down', 'http://localhost:9999/v1'));
    const anthropic = fakeClient('anthropic', 'A');
    const r = makeRouter({
      provider: 'auto', local: LOCAL, localC: local, anthropicC: anthropic, consent: () => true,
    });
    await expect(r.complete(smallReq())).rejects.toBeInstanceOf(LlmSkippedError);
    await r.complete(smallReq()).catch((e) => {
      expect((e as Error).message).toMatch(/is it running\?/);
      expect((e as Error).message).toMatch(/llmProvider.*anthropic/); // config-off hint
    });
    expect(anthropic.calls).toHaveLength(0); // availability is not size — no reroute
  });

  it('provider=local, local UNAVAILABLE → skip', async () => {
    const local = throwingClient('local', new LlmUnavailableError('down', 'http://localhost:9999/v1'));
    const anthropic = fakeClient('anthropic', 'A');
    const r = makeRouter({
      provider: 'local', local: LOCAL, localC: local, anthropicC: anthropic, consent: () => true,
    });
    await expect(r.complete(smallReq())).rejects.toBeInstanceOf(LlmSkippedError);
    expect(anthropic.calls).toHaveLength(0);
  });

  it('provider=auto, generic (non-availability) local error → still bubbles up', async () => {
    const local = throwingClient('local', new Error('boom'));
    const anthropic = fakeClient('anthropic', 'A');
    const r = makeRouter({
      provider: 'auto', local: LOCAL, localC: local, anthropicC: anthropic, consent: () => true,
    });
    await expect(r.complete(smallReq())).rejects.toThrow('boom');
    expect(anthropic.calls).toHaveLength(0); // not rerouted
  });

  it('provider=local, over budget → skip (never reaches cloud even with consent)', async () => {
    const local = fakeClient('local', 'L');
    const anthropic = fakeClient('anthropic', 'A');
    const r = makeRouter({
      provider: 'local', local: LOCAL, localC: local, anthropicC: anthropic, consent: () => true,
    });
    await expect(r.complete(bigReq())).rejects.toBeInstanceOf(LlmSkippedError);
    expect(local.calls).toHaveLength(0);
    expect(anthropic.calls).toHaveLength(0);
  });

  it('provider=local, runtime overflow → skip, not reroute', async () => {
    const local = throwingClient('local', new LlmContextOverflowError('too big'));
    const anthropic = fakeClient('anthropic', 'A');
    const r = makeRouter({
      provider: 'local', local: LOCAL, localC: local, anthropicC: anthropic, consent: () => true,
    });
    await expect(r.complete(smallReq())).rejects.toBeInstanceOf(LlmSkippedError);
    expect(anthropic.calls).toHaveLength(0);
  });

  it('provider=local, no endpoint configured → skip with config hint', async () => {
    const r = makeRouter({ provider: 'local', local: NO_LOCAL, localC: fakeClient('local'), anthropicC: fakeClient('anthropic') });
    await expect(r.complete(smallReq())).rejects.toBeInstanceOf(LlmSkippedError);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeRouter(opts: {
  provider: 'auto' | 'local' | 'anthropic';
  local: ResolvedLocalConfig;
  localC: LlmClient;
  anthropicC: LlmClient;
  consent?: () => boolean;
  warn?: (m: string) => void;
}): RouterLlmClient {
  return new RouterLlmClient({
    provider: opts.provider,
    local: opts.local,
    localClient: () => opts.localC,
    anthropicClient: () => opts.anthropicC,
    consent: opts.consent,
    warn: opts.warn,
  });
}

// Tiny afterEach helper so the env-mutating describe blocks restore cleanly.
import { afterEach } from 'vitest';
function afterEachRestore(key: string, orig: string | undefined): void {
  afterEach(() => {
    if (orig === undefined) delete process.env[key];
    else process.env[key] = orig;
  });
}
