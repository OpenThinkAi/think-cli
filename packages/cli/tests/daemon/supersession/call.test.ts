/**
 * Tests for the supersession LLM call module (AGT-303).
 *
 * Mocks the Anthropic SDK to test JSON parsing, fence stripping,
 * retry-once-on-parse-error, and LLM consent gating without making real
 * network calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SupersessionResult, RetroEntry, RetroCandidate } from '../../../src/daemon/supersession/call.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NEW_RETRO: RetroEntry = {
  cortex: 'fx-tracker',
  date: '2026-05-16',
  content: 'The strategy schema is V2 as of March.',
};

const CANDIDATES: RetroCandidate[] = [
  {
    id: 'retro_2a1',
    date: '2025-11-04',
    content: 'Strategy rules are a flat list of {when, then} pairs.',
  },
  {
    id: 'retro_4f8',
    date: '2026-02-12',
    content: 'When adding a new strategy field, update both the Rust struct and the Zod schema.',
  },
];

const VALID_RESPONSE: SupersessionResult = {
  supersedes: ['retro_2a1'],
  topics: ['strategy', 'schema', 'v2'],
  is_duplicate: false,
};

const DUPLICATE_RESPONSE: SupersessionResult = {
  supersedes: [],
  topics: ['auth', 'jwt'],
  is_duplicate: true,
};

// ---------------------------------------------------------------------------
// Helpers — build an Anthropic constructor mock
// ---------------------------------------------------------------------------

function buildAnthropicMock(messagesCreate: ReturnType<typeof vi.fn>) {
  // Must be a proper class so `new Anthropic()` works.
  class MockAnthropic {
    messages = { create: messagesCreate };
  }
  return { default: MockAnthropic };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runSupersession — happy path', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env['THINK_LLM_CONSENT'];
    process.env['THINK_LLM_CONSENT'] = '1';
    vi.resetModules();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['THINK_LLM_CONSENT'];
    } else {
      process.env['THINK_LLM_CONSENT'] = originalEnv;
    }
    vi.restoreAllMocks();
  });

  it('parses a valid supersession response', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(VALID_RESPONSE) }],
    });
    vi.doMock('@anthropic-ai/sdk', () => buildAnthropicMock(mockCreate));

    const { runSupersession } = await import('../../../src/daemon/supersession/call.js');
    const result = await runSupersession(NEW_RETRO, CANDIDATES);

    expect(result.supersedes).toEqual(['retro_2a1']);
    expect(result.topics).toEqual(['strategy', 'schema', 'v2']);
    expect(result.is_duplicate).toBe(false);
  });

  it('parses a duplicate response', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(DUPLICATE_RESPONSE) }],
    });
    vi.doMock('@anthropic-ai/sdk', () => buildAnthropicMock(mockCreate));

    const { runSupersession } = await import('../../../src/daemon/supersession/call.js');
    const result = await runSupersession(NEW_RETRO, CANDIDATES);

    expect(result.is_duplicate).toBe(true);
    expect(result.supersedes).toEqual([]);
  });

  it('calls the SDK with correct model and temperature', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(VALID_RESPONSE) }],
    });
    vi.doMock('@anthropic-ai/sdk', () => buildAnthropicMock(mockCreate));

    const { runSupersession } = await import('../../../src/daemon/supersession/call.js');
    await runSupersession(NEW_RETRO, CANDIDATES);

    const call = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(call['model']).toBe('claude-sonnet-4-6');
    expect(call['temperature']).toBe(0.1);
    expect(call['max_tokens']).toBe(300);
  });

  it('uses cached system prompt (cache_control: ephemeral)', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(VALID_RESPONSE) }],
    });
    vi.doMock('@anthropic-ai/sdk', () => buildAnthropicMock(mockCreate));

    const { runSupersession } = await import('../../../src/daemon/supersession/call.js');
    await runSupersession(NEW_RETRO, CANDIDATES);

    const call = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    const system = call['system'] as Array<Record<string, unknown>>;
    expect(Array.isArray(system)).toBe(true);
    expect(system[0]['type']).toBe('text');
    expect(system[0]['cache_control']).toEqual({ type: 'ephemeral' });
  });

  it('handles empty supersedes and topics gracefully', async () => {
    const emptyResponse = { supersedes: [], topics: [], is_duplicate: false };
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(emptyResponse) }],
    });
    vi.doMock('@anthropic-ai/sdk', () => buildAnthropicMock(mockCreate));

    const { runSupersession } = await import('../../../src/daemon/supersession/call.js');
    const result = await runSupersession(NEW_RETRO, CANDIDATES);

    expect(result.supersedes).toEqual([]);
    expect(result.topics).toEqual([]);
    expect(result.is_duplicate).toBe(false);
  });

  it('clears supersedes when is_duplicate is true (enforced invariant)', async () => {
    // Model incorrectly returns supersedes alongside is_duplicate: true
    const badModel = { supersedes: ['retro_2a1'], topics: ['strategy'], is_duplicate: true };
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(badModel) }],
    });
    vi.doMock('@anthropic-ai/sdk', () => buildAnthropicMock(mockCreate));

    const { runSupersession } = await import('../../../src/daemon/supersession/call.js');
    const result = await runSupersession(NEW_RETRO, CANDIDATES);

    expect(result.is_duplicate).toBe(true);
    expect(result.supersedes).toEqual([]); // enforced by parser despite model output
  });

  it('caps topics at 4 even when model returns more', async () => {
    const manyTopics = { supersedes: [], topics: ['a', 'b', 'c', 'd', 'e', 'f'], is_duplicate: false };
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(manyTopics) }],
    });
    vi.doMock('@anthropic-ai/sdk', () => buildAnthropicMock(mockCreate));

    const { runSupersession } = await import('../../../src/daemon/supersession/call.js');
    const result = await runSupersession(NEW_RETRO, CANDIDATES);

    expect(result.topics).toHaveLength(4);
    expect(result.topics).toEqual(['a', 'b', 'c', 'd']);
  });

  it('strips markdown code fences (```json) from the response', async () => {
    const fenced = '```json\n' + JSON.stringify(VALID_RESPONSE) + '\n```';
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: fenced }],
    });
    vi.doMock('@anthropic-ai/sdk', () => buildAnthropicMock(mockCreate));

    const { runSupersession } = await import('../../../src/daemon/supersession/call.js');
    const result = await runSupersession(NEW_RETRO, CANDIDATES);

    expect(result.supersedes).toEqual(['retro_2a1']);
    expect(result.is_duplicate).toBe(false);
  });

  it('strips plain code fences (```) from the response', async () => {
    const fenced = '```\n' + JSON.stringify(VALID_RESPONSE) + '\n```';
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: fenced }],
    });
    vi.doMock('@anthropic-ai/sdk', () => buildAnthropicMock(mockCreate));

    const { runSupersession } = await import('../../../src/daemon/supersession/call.js');
    const result = await runSupersession(NEW_RETRO, CANDIDATES);

    expect(result.is_duplicate).toBe(false);
    expect(result.topics).toEqual(['strategy', 'schema', 'v2']);
  });
});

// ---------------------------------------------------------------------------
// max_tokens truncation guard
// ---------------------------------------------------------------------------

describe('runSupersession — max_tokens truncation', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env['THINK_LLM_CONSENT'];
    process.env['THINK_LLM_CONSENT'] = '1';
    vi.resetModules();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['THINK_LLM_CONSENT'];
    } else {
      process.env['THINK_LLM_CONSENT'] = originalEnv;
    }
    vi.restoreAllMocks();
  });

  it('throws a clear error when stop_reason is max_tokens on first attempt', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '{"supersedes":["retro_2a1"],"topics":["strategy"]' }],
      stop_reason: 'max_tokens',
    });
    vi.doMock('@anthropic-ai/sdk', () => buildAnthropicMock(mockCreate));

    const { runSupersession } = await import('../../../src/daemon/supersession/call.js');
    await expect(runSupersession(NEW_RETRO, CANDIDATES)).rejects.toThrow(
      'Supersession response truncated at max_tokens=300',
    );
    // Should NOT retry — truncation is not a transient error
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('throws the truncation error (not a parse error) when retry also hits max_tokens', async () => {
    const mockCreate = vi
      .fn()
      // First attempt: invalid JSON (triggers retry)
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'not-valid-json' }],
        stop_reason: 'end_turn',
      })
      // Retry: truncated response
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: '{"supersedes":["retro_2a1"],"topics":["strategy"]' }],
        stop_reason: 'max_tokens',
      });

    vi.doMock('@anthropic-ai/sdk', () => buildAnthropicMock(mockCreate));

    const { runSupersession } = await import('../../../src/daemon/supersession/call.js');
    await expect(runSupersession(NEW_RETRO, CANDIDATES)).rejects.toThrow(
      'Supersession response truncated at max_tokens=300',
    );
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Retry-once-on-parse-error
// ---------------------------------------------------------------------------

describe('runSupersession — retry on parse error', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env['THINK_LLM_CONSENT'];
    process.env['THINK_LLM_CONSENT'] = '1';
    vi.resetModules();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['THINK_LLM_CONSENT'];
    } else {
      process.env['THINK_LLM_CONSENT'] = originalEnv;
    }
    vi.restoreAllMocks();
  });

  it('retries once when first response is invalid JSON and succeeds on second', async () => {
    const mockCreate = vi
      .fn()
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'not-valid-json' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify(VALID_RESPONSE) }] });

    vi.doMock('@anthropic-ai/sdk', () => buildAnthropicMock(mockCreate));

    const { runSupersession } = await import('../../../src/daemon/supersession/call.js');
    const result = await runSupersession(NEW_RETRO, CANDIDATES);

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(result.supersedes).toEqual(['retro_2a1']);
  });

  it('throws after two consecutive parse failures (no further retries)', async () => {
    const mockCreate = vi
      .fn()
      .mockResolvedValue({ content: [{ type: 'text', text: 'still-not-json' }] });

    vi.doMock('@anthropic-ai/sdk', () => buildAnthropicMock(mockCreate));

    const { runSupersession } = await import('../../../src/daemon/supersession/call.js');
    await expect(runSupersession(NEW_RETRO, CANDIDATES)).rejects.toThrow('Supersession JSON parse failed');
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('error message includes the raw text on failure', async () => {
    const badText = 'this is definitely not json';
    const mockCreate = vi
      .fn()
      .mockResolvedValue({ content: [{ type: 'text', text: badText }] });

    vi.doMock('@anthropic-ai/sdk', () => buildAnthropicMock(mockCreate));

    const { runSupersession } = await import('../../../src/daemon/supersession/call.js');
    await expect(runSupersession(NEW_RETRO, CANDIDATES)).rejects.toThrow(badText);
  });
});

// ---------------------------------------------------------------------------
// LLM consent gating
// ---------------------------------------------------------------------------

describe('runSupersession — LLM consent gate', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws LlmConsentError when THINK_LLM_CONSENT is not set', async () => {
    const saved = process.env['THINK_LLM_CONSENT'];
    delete process.env['THINK_LLM_CONSENT'];

    // Mock the SDK so no real network call happens (consent check fires first)
    vi.doMock('@anthropic-ai/sdk', () => buildAnthropicMock(vi.fn()));

    try {
      const { runSupersession } = await import('../../../src/daemon/supersession/call.js');
      await expect(runSupersession(NEW_RETRO, CANDIDATES)).rejects.toThrow('LLM consent not granted');
    } finally {
      if (saved !== undefined) process.env['THINK_LLM_CONSENT'] = saved;
    }
  });
});
