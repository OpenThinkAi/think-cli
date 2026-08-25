/**
 * Per-operation routing reaches the ported operations.
 *
 * The registry was already able to select a provider per operation; what this
 * suite pins is that each operation actually ASKS for its own name. A port that
 * threads an `LlmClient` through but forgets the operation name looks correct
 * and silently collapses every op onto the default provider — which is exactly
 * the bug that makes `cortex.llm.operations` a lie.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  RegistryLlmClient,
  resolveRegistry,
  selectProviderName,
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
