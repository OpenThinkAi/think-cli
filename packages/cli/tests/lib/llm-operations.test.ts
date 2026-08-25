/**
 * Per-operation routing reaches the ported operations.
 *
 * The registry was already able to select a provider per operation; what this
 * suite pins is that each operation actually ASKS for its own name. A port that
 * threads an `LlmClient` through but forgets the operation name looks correct
 * and silently collapses every op onto the default provider — which is exactly
 * the bug that makes `cortex.llm.operations` a lie.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  getDefaultLlmClient,
  RegistryLlmClient,
  resolveRegistry,
  selectProviderName,
  resetOperationKeyWarnings,
  ALL_OPERATIONS,
  OP_CURATION,
  OP_SUMMARY,
  OP_DASHBOARD,
  OP_COMPACTION,
  OP_SUPERSESSION,
  OP_RETRO_DEDUPE,
  OP_EPISODE,
  OP_TERMINAL_EVENT,
  OP_LONG_TERM,
  OP_EVENT_DETECTION,
} from '../../src/lib/llm/router.js';
import type { LlmClient, LlmRequest, LlmResponse } from '../../src/lib/llm/client.js';
import type { LlmConfig } from '../../src/lib/config.js';

vi.mock('../../src/lib/llm-consent.js', () => ({
  requireLlmConsent: vi.fn(),
  hasLlmConsent: vi.fn(() => true),
  LlmConsentError: class LlmConsentError extends Error {},
}));

function recorder(name: string): LlmClient & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    name,
    calls,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      calls.push(req);
      return { text: '{}' };
    },
  };
}

const TWO_PROVIDERS: LlmConfig = {
  providers: {
    qwen: { kind: 'openai', endpoint: 'http://127.0.0.1:8000/v1', model: 'q' },
    claude: { kind: 'anthropic' },
  },
  default: 'claude',
};

describe('operation name registry', () => {
  it('every exported OP_* constant is listed in ALL_OPERATIONS', () => {
    const exported = [
      OP_CURATION,
      OP_EVENT_DETECTION,
      OP_EPISODE,
      OP_TERMINAL_EVENT,
      OP_RETRO_DEDUPE,
      OP_SUMMARY,
      OP_DASHBOARD,
      OP_LONG_TERM,
      OP_COMPACTION,
      OP_SUPERSESSION,
    ];
    expect([...ALL_OPERATIONS].sort()).toEqual(exported.sort());
  });

  it('operation names are unique — a collision would silently merge two ops', () => {
    expect(new Set(ALL_OPERATIONS).size).toBe(ALL_OPERATIONS.length);
  });

  it('names are stable kebab-case config keys, not display strings', () => {
    for (const op of ALL_OPERATIONS) {
      expect(op).toMatch(/^[a-z][a-z-]*[a-z]$/);
    }
  });
});

describe('per-operation provider selection', () => {
  const registry = resolveRegistry(TWO_PROVIDERS);

  it('routes each operation independently', () => {
    const cfg: LlmConfig = {
      ...TWO_PROVIDERS,
      operations: { [OP_CURATION]: 'qwen', [OP_COMPACTION]: 'qwen', [OP_SUMMARY]: 'claude' },
    };
    expect(selectProviderName(OP_CURATION, cfg, registry)).toBe('qwen');
    expect(selectProviderName(OP_COMPACTION, cfg, registry)).toBe('qwen');
    expect(selectProviderName(OP_SUMMARY, cfg, registry)).toBe('claude');
    // Unmapped ops fall to the default rather than erroring.
    expect(selectProviderName(OP_SUPERSESSION, cfg, registry)).toBe('claude');
  });

  it('sends an operation to its mapped provider and NOT to the default', async () => {
    const cfg: LlmConfig = { ...TWO_PROVIDERS, operations: { [OP_SUMMARY]: 'qwen' } };
    const qwen = recorder('qwen');
    const claude = recorder('claude');

    const client = new RegistryLlmClient({
      operation: OP_SUMMARY,
      registry: resolveRegistry(cfg),
      llm: cfg,
      clientFor: (p) => (p.name === 'qwen' ? qwen : claude),
      consent: () => true,
    });
    await client.complete({ system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 10 });

    expect(qwen.calls).toHaveLength(1);
    expect(claude.calls).toHaveLength(0);
  });

  it('carries strictSchema and cacheSystem through to the selected provider', async () => {
    const qwen = recorder('qwen');
    const cfg: LlmConfig = { ...TWO_PROVIDERS, operations: { [OP_COMPACTION]: 'qwen' } };
    const client = new RegistryLlmClient({
      operation: OP_COMPACTION,
      registry: resolveRegistry(cfg),
      llm: cfg,
      clientFor: () => qwen,
      consent: () => true,
    });

    await client.complete({
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
      maxTokens: 10,
      schema: { name: 'n', schema: { type: 'object' } },
      strictSchema: true,
      cacheSystem: true,
    });

    // The router must not strip request flags on the way through — dropping
    // strictSchema is how a daemon worker loses its shape guarantee.
    expect(qwen.calls[0].strictSchema).toBe(true);
    expect(qwen.calls[0].cacheSystem).toBe(true);
    expect(qwen.calls[0].schema?.name).toBe('n');
  });
});

describe('unknown operation keys are surfaced, not swallowed', () => {
  it('warns when a key names no known operation (the long_term/long-term typo)', () => {
    resetOperationKeyWarnings();
    const cfg: LlmConfig = { ...TWO_PROVIDERS, operations: { long_term: 'qwen' } };
    const warnings: string[] = [];
    const chosen = selectProviderName('long-term', cfg, resolveRegistry(cfg), (m) =>
      warnings.push(m),
    );
    // Still routes (to the default) rather than failing the run...
    expect(chosen).toBe('claude');
    // ...but the user is told their key did nothing, and what the valid ones are.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/long_term/);
    expect(warnings[0]).toMatch(/long-term/);
  });

  it('does not warn for valid keys', () => {
    resetOperationKeyWarnings();
    const cfg: LlmConfig = { ...TWO_PROVIDERS, operations: { [OP_LONG_TERM]: 'qwen' } };
    const warnings: string[] = [];
    selectProviderName(OP_LONG_TERM, cfg, resolveRegistry(cfg), (m) => warnings.push(m));
    expect(warnings).toHaveLength(0);
  });

  it('warns once per key, not once per operation looked up', () => {
    resetOperationKeyWarnings();
    const cfg: LlmConfig = { ...TWO_PROVIDERS, operations: { nope: 'qwen' } };
    const warnings: string[] = [];
    const registry = resolveRegistry(cfg);
    for (const op of ALL_OPERATIONS) {
      selectProviderName(op, cfg, registry, (m) => warnings.push(m));
    }
    expect(warnings).toHaveLength(1);
  });
});

/**
 * A pre-registry `cortex.local` config must not silently acquire nine new
 * operations on upgrade. When it was written, curation was the ONLY operation
 * that consulted the router, so that is the whole of what the user opted into.
 * Broad routing requires `cortex.llm` — new surface, therefore a real choice.
 */
describe('legacy cortex.local stays scoped to curation', () => {
  afterEach(() => {
    delete process.env.THINK_LOCAL_ENDPOINT;
    delete process.env.THINK_LOCAL_MODEL;
    delete process.env.THINK_LLM_PROVIDER;
  });

  it('routes curation and event-detection through the router', () => {
    process.env.THINK_LOCAL_ENDPOINT = 'http://127.0.0.1:8000/v1';
    process.env.THINK_LOCAL_MODEL = 'q';
    expect(getDefaultLlmClient(OP_CURATION).name).toBe('router');
    expect(getDefaultLlmClient(OP_EVENT_DETECTION).name).toBe('router');
  });

  it('sends every OTHER operation straight to Anthropic, unchanged by the local block', () => {
    process.env.THINK_LOCAL_ENDPOINT = 'http://127.0.0.1:8000/v1';
    process.env.THINK_LOCAL_MODEL = 'q';
    for (const op of ALL_OPERATIONS) {
      if (op === OP_CURATION || op === OP_EVENT_DETECTION) continue;
      expect(getDefaultLlmClient(op).name).toBe('anthropic');
    }
  });

  it('even with llmProvider pinned to local — pinning predates per-op routing too', () => {
    process.env.THINK_LOCAL_ENDPOINT = 'http://127.0.0.1:8000/v1';
    process.env.THINK_LOCAL_MODEL = 'q';
    process.env.THINK_LLM_PROVIDER = 'local';
    expect(getDefaultLlmClient(OP_COMPACTION).name).toBe('anthropic');
    expect(getDefaultLlmClient(OP_SUMMARY).name).toBe('anthropic');
  });

  it('with no local config at all, everything is Anthropic', () => {
    for (const op of ALL_OPERATIONS) {
      const c = getDefaultLlmClient(op);
      // curation still builds a router, but one with no local endpoint, which
      // delegates straight to Anthropic — the pre-existing inert behaviour.
      expect(['anthropic', 'router']).toContain(c.name);
    }
  });
});
