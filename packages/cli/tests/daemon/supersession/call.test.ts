/**
 * Tests for the supersession LLM call module (AGT-303).
 *
 * After the tool_use migration: the API enforces input_schema server-side,
 * so per-attempt failure is "no tool_use block returned". `validateShape`
 * (here: parseSupersessionToolInput) still enforces business rules: the
 * isDuplicate→empty-supersedes invariant and the topics cap at 4.
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

const VALID_TOOL_INPUT = {
  supersedes: ['retro_2a1'],
  topics: ['strategy', 'schema', 'v2'],
  is_duplicate: false,
};

const DUPLICATE_TOOL_INPUT = {
  supersedes: [],
  topics: ['auth', 'jwt'],
  is_duplicate: true,
};

const VALID_RESPONSE: SupersessionResult = {
  supersedes: ['retro_2a1'],
  topics: ['strategy', 'schema', 'v2'],
  isDuplicate: false,
};

const DUPLICATE_RESPONSE: SupersessionResult = {
  supersedes: [],
  topics: ['auth', 'jwt'],
  isDuplicate: true,
};

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function buildAnthropicMock(messagesCreate: ReturnType<typeof vi.fn>) {
  class MockAnthropic {
    messages = { create: messagesCreate };
  }
  return { default: MockAnthropic };
}

function makeToolUseResponse(input: unknown) {
  return {
    content: [
      {
        type: 'tool_use',
        id: 'toolu_test',
        name: 'submit_supersession',
        input,
      },
    ],
    stop_reason: 'tool_use',
  };
}

function makeNoToolUseResponse() {
  return {
    content: [{ type: 'text', text: 'forgot to call the tool' }],
    stop_reason: 'end_turn',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Every test here mocks the Anthropic SDK, so no real key is ever used — but
// runSupersession resolves a key (resolveThinkApiKey) before constructing the
// mocked client and throws if none is set. Set a dummy at the file level so the
// suite is hermetic: it passes in a keyless env (CI publish) instead of only in
// a shell that happens to export THINK_ANTHROPIC_KEY/ANTHROPIC_API_KEY.
let _savedThinkKey: string | undefined;
beforeEach(() => {
  _savedThinkKey = process.env['THINK_ANTHROPIC_KEY'];
  process.env['THINK_ANTHROPIC_KEY'] = 'test-key';
});
afterEach(() => {
  if (_savedThinkKey === undefined) delete process.env['THINK_ANTHROPIC_KEY'];
  else process.env['THINK_ANTHROPIC_KEY'] = _savedThinkKey;
});

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

  it('parses a valid supersession tool_use response', async () => {
    const mockCreate = vi.fn().mockResolvedValue(makeToolUseResponse(VALID_TOOL_INPUT));
    vi.doMock('@anthropic-ai/sdk', () => buildAnthropicMock(mockCreate));

    const { runSupersession } = await import('../../../src/daemon/supersession/call.js');
    const result = await runSupersession(NEW_RETRO, CANDIDATES);

    expect(result).toEqual(VALID_RESPONSE);
  });

  it('parses a duplicate tool_use response', async () => {
    const mockCreate = vi.fn().mockResolvedValue(makeToolUseResponse(DUPLICATE_TOOL_INPUT));
    vi.doMock('@anthropic-ai/sdk', () => buildAnthropicMock(mockCreate));

    const { runSupersession } = await import('../../../src/daemon/supersession/call.js');
    const result = await runSupersession(NEW_RETRO, CANDIDATES);

    expect(result).toEqual(DUPLICATE_RESPONSE);
  });

  it('uses Haiku 4.5 with the expected temperature and max_tokens', async () => {
    const mockCreate = vi.fn().mockResolvedValue(makeToolUseResponse(VALID_TOOL_INPUT));
    vi.doMock('@anthropic-ai/sdk', () => buildAnthropicMock(mockCreate));

    const { runSupersession } = await import('../../../src/daemon/supersession/call.js');
    await runSupersession(NEW_RETRO, CANDIDATES);

    const call = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(call['model']).toBe('claude-haiku-4-5');
    expect(call['temperature']).toBe(0.1);
    expect(call['max_tokens']).toBe(300);
  });

  it('forces tool_use via tool_choice with the submit_supersession tool', async () => {
    const mockCreate = vi.fn().mockResolvedValue(makeToolUseResponse(VALID_TOOL_INPUT));
    vi.doMock('@anthropic-ai/sdk', () => buildAnthropicMock(mockCreate));

    const { runSupersession } = await import('../../../src/daemon/supersession/call.js');
    await runSupersession(NEW_RETRO, CANDIDATES);

    const call = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    const tools = call['tools'] as Array<Record<string, unknown>>;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toHaveLength(1);
    expect(tools[0]['name']).toBe('submit_supersession');
    expect(call['tool_choice']).toEqual({
      type: 'tool',
      name: 'submit_supersession',
      disable_parallel_tool_use: true,
    });
  });

  it('uses cached system prompt (cache_control: ephemeral)', async () => {
    const mockCreate = vi.fn().mockResolvedValue(makeToolUseResponse(VALID_TOOL_INPUT));
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
    const empty = { supersedes: [], topics: [], is_duplicate: false };
    const mockCreate = vi.fn().mockResolvedValue(makeToolUseResponse(empty));
    vi.doMock('@anthropic-ai/sdk', () => buildAnthropicMock(mockCreate));

    const { runSupersession } = await import('../../../src/daemon/supersession/call.js');
    const result = await runSupersession(NEW_RETRO, CANDIDATES);

    expect(result.supersedes).toEqual([]);
    expect(result.topics).toEqual([]);
    expect(result.isDuplicate).toBe(false);
  });

  it('clears supersedes when isDuplicate is true (enforced invariant)', async () => {
    const badModel = { supersedes: ['retro_2a1'], topics: ['strategy'], is_duplicate: true };
    const mockCreate = vi.fn().mockResolvedValue(makeToolUseResponse(badModel));
    vi.doMock('@anthropic-ai/sdk', () => buildAnthropicMock(mockCreate));

    const { runSupersession } = await import('../../../src/daemon/supersession/call.js');
    const result = await runSupersession(NEW_RETRO, CANDIDATES);

    expect(result.isDuplicate).toBe(true);
    expect(result.supersedes).toEqual([]);
  });

  it('caps topics at 4 even when model returns more', async () => {
    const manyTopics = { supersedes: [], topics: ['a', 'b', 'c', 'd', 'e', 'f'], is_duplicate: false };
    const mockCreate = vi.fn().mockResolvedValue(makeToolUseResponse(manyTopics));
    vi.doMock('@anthropic-ai/sdk', () => buildAnthropicMock(mockCreate));

    const { runSupersession } = await import('../../../src/daemon/supersession/call.js');
    const result = await runSupersession(NEW_RETRO, CANDIDATES);

    expect(result.topics).toHaveLength(4);
    expect(result.topics).toEqual(['a', 'b', 'c', 'd']);
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
      content: [],
      stop_reason: 'max_tokens',
    });
    vi.doMock('@anthropic-ai/sdk', () => buildAnthropicMock(mockCreate));

    const { runSupersession } = await import('../../../src/daemon/supersession/call.js');
    await expect(runSupersession(NEW_RETRO, CANDIDATES)).rejects.toThrow(
      'Supersession response truncated at max_tokens=300',
    );
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Retry-once on missing tool_use
// ---------------------------------------------------------------------------

describe('runSupersession — retry on missing tool_use', () => {
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

  it('retries once when first response has no tool_use, succeeds on second', async () => {
    const mockCreate = vi
      .fn()
      .mockResolvedValueOnce(makeNoToolUseResponse())
      .mockResolvedValueOnce(makeToolUseResponse(VALID_TOOL_INPUT));

    vi.doMock('@anthropic-ai/sdk', () => buildAnthropicMock(mockCreate));

    const { runSupersession } = await import('../../../src/daemon/supersession/call.js');
    const result = await runSupersession(NEW_RETRO, CANDIDATES);

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(result.supersedes).toEqual(['retro_2a1']);
  });

  it('throws after two consecutive missing tool_use blocks (no further retries)', async () => {
    const mockCreate = vi.fn().mockResolvedValue(makeNoToolUseResponse());

    vi.doMock('@anthropic-ai/sdk', () => buildAnthropicMock(mockCreate));

    const { runSupersession } = await import('../../../src/daemon/supersession/call.js');
    await expect(runSupersession(NEW_RETRO, CANDIDATES)).rejects.toThrow(
      'Supersession response missing tool_use block after retry',
    );
    expect(mockCreate).toHaveBeenCalledTimes(2);
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

    vi.doMock('@anthropic-ai/sdk', () => buildAnthropicMock(vi.fn()));

    try {
      const { runSupersession } = await import('../../../src/daemon/supersession/call.js');
      await expect(runSupersession(NEW_RETRO, CANDIDATES)).rejects.toThrow('LLM consent not granted');
    } finally {
      if (saved !== undefined) process.env['THINK_LLM_CONSENT'] = saved;
    }
  });
});
