/**
 * Tests for the compaction SDK call wrapper (AGT-298).
 *
 * All tests mock the Anthropic SDK — no real network calls are made.
 *
 * After the tool_use migration: the API enforces input_schema server-side,
 * so the per-attempt parse failure mode is "no tool_use block returned"
 * (transient model non-determinism) rather than malformed text JSON.
 * `validateShape` still catches business-rule violations the schema can't
 * express (empty compacted_text, non-string elements that slip through).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NEW_ENTRY = {
  ts: '2026-05-17T10:00:00Z',
  content: 'moved back to sqlite from indexedDb',
};

const CANDIDATES = [
  {
    id: 'mem_8af2',
    ts: '2026-04-02T00:00:00Z',
    content: 'Switched client storage from sqlite to indexedDb',
    topics: ['sqlite', 'storage'],
  },
];

const VALID_TOOL_INPUT = {
  compacted_text:
    'Client storage: returned to sqlite after indexedDb perf problems. sqlite is the durable choice.',
  supersedes: ['mem_8af2'],
  topics: ['sqlite', 'storage'],
};

// ---------------------------------------------------------------------------
// SDK mock helpers
// ---------------------------------------------------------------------------

function makeToolUseResponse(input: unknown) {
  return {
    content: [
      {
        type: 'tool_use',
        id: 'toolu_test',
        name: 'submit_compaction',
        input,
      },
    ],
    stop_reason: 'tool_use',
  };
}

function makeNoToolUseResponse() {
  return {
    content: [{ type: 'text', text: 'i forgot to call the tool' }],
    stop_reason: 'end_turn',
  };
}

function makeEmptyContentResponse() {
  return {
    content: [],
    stop_reason: 'end_turn',
  };
}

// ---------------------------------------------------------------------------
// Module mocking strategy
// ---------------------------------------------------------------------------

const mockMessagesCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { create: mockMessagesCreate };
  }
  return {
    default: MockAnthropic,
  };
});

vi.mock('../../../src/lib/llm-consent.js', () => ({
  requireLlmConsent: vi.fn(),
  LlmConsentError: class LlmConsentError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'LlmConsentError';
    }
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks are registered
// ---------------------------------------------------------------------------

import { runCompaction } from '../../../src/daemon/compaction/call.js';
import { requireLlmConsent } from '../../../src/lib/llm-consent.js';

const mockConsent = vi.mocked(requireLlmConsent);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Every test here mocks the Anthropic SDK, so no real key is ever used — but
// runCompaction resolves a key (resolveThinkApiKey) before constructing the
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

describe('runCompaction — happy path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConsent.mockReturnValue(undefined);
  });

  it('returns status:ok with parsed fields for a valid tool_use response', async () => {
    mockMessagesCreate.mockResolvedValueOnce(makeToolUseResponse(VALID_TOOL_INPUT));

    const result = await runCompaction(NEW_ENTRY, CANDIDATES);

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.compacted_text).toBe(VALID_TOOL_INPUT.compacted_text);
      expect(result.supersedes).toEqual(['mem_8af2']);
      expect(result.topics).toEqual(['sqlite', 'storage']);
    }
  });

  it('passes the system prompt text to messages.create', async () => {
    mockMessagesCreate.mockResolvedValueOnce(makeToolUseResponse(VALID_TOOL_INPUT));

    await runCompaction(NEW_ENTRY, CANDIDATES);

    const callArgs = mockMessagesCreate.mock.calls[0][0];
    expect(callArgs.system).toHaveLength(1);
    expect(callArgs.system[0].type).toBe('text');
    expect(typeof callArgs.system[0].text).toBe('string');
    expect(callArgs.system[0].text.length).toBeGreaterThan(100);
  });

  it('sets cache_control: ephemeral on the system block', async () => {
    mockMessagesCreate.mockResolvedValueOnce(makeToolUseResponse(VALID_TOOL_INPUT));

    await runCompaction(NEW_ENTRY, CANDIDATES);

    const callArgs = mockMessagesCreate.mock.calls[0][0];
    expect(callArgs.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('uses Haiku 4.5, max_tokens 600, temperature 0.2', async () => {
    mockMessagesCreate.mockResolvedValueOnce(makeToolUseResponse(VALID_TOOL_INPUT));

    await runCompaction(NEW_ENTRY, CANDIDATES);

    const callArgs = mockMessagesCreate.mock.calls[0][0];
    expect(callArgs.model).toBe('claude-haiku-4-5');
    expect(callArgs.max_tokens).toBe(600);
    expect(callArgs.temperature).toBe(0.2);
  });

  it('forces tool_use via tool_choice with the submit_compaction tool', async () => {
    mockMessagesCreate.mockResolvedValueOnce(makeToolUseResponse(VALID_TOOL_INPUT));

    await runCompaction(NEW_ENTRY, CANDIDATES);

    const callArgs = mockMessagesCreate.mock.calls[0][0];
    expect(Array.isArray(callArgs.tools)).toBe(true);
    expect(callArgs.tools).toHaveLength(1);
    expect(callArgs.tools[0].name).toBe('submit_compaction');
    expect(callArgs.tools[0].input_schema.required).toEqual([
      'compacted_text',
      'supersedes',
      'topics',
    ]);
    expect(callArgs.tool_choice).toEqual({
      type: 'tool',
      name: 'submit_compaction',
      disable_parallel_tool_use: true,
    });
  });

  it('works with an empty candidates array', async () => {
    mockMessagesCreate.mockResolvedValueOnce(makeToolUseResponse(VALID_TOOL_INPUT));

    const result = await runCompaction(NEW_ENTRY, []);

    expect(result.status).toBe('ok');
  });
});

describe('runCompaction — retry logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConsent.mockReturnValue(undefined);
  });

  it('retries once when first response has no tool_use block, succeeds on second', async () => {
    mockMessagesCreate.mockResolvedValueOnce(makeNoToolUseResponse());
    mockMessagesCreate.mockResolvedValueOnce(makeToolUseResponse(VALID_TOOL_INPUT));

    const result = await runCompaction(NEW_ENTRY, CANDIDATES);

    expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('ok');
  });

  it('returns response_invalid after two consecutive missing tool_use blocks', async () => {
    mockMessagesCreate.mockResolvedValueOnce(makeNoToolUseResponse());
    mockMessagesCreate.mockResolvedValueOnce(makeNoToolUseResponse());

    const result = await runCompaction(NEW_ENTRY, CANDIDATES);

    expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('response_invalid');
  });

  it('returns response_invalid when response content array is empty', async () => {
    mockMessagesCreate.mockResolvedValueOnce(makeEmptyContentResponse());
    mockMessagesCreate.mockResolvedValueOnce(makeEmptyContentResponse());

    const result = await runCompaction(NEW_ENTRY, CANDIDATES);

    expect(result.status).toBe('response_invalid');
  });

  it('does NOT make a third attempt', async () => {
    mockMessagesCreate.mockResolvedValue(makeNoToolUseResponse());

    await runCompaction(NEW_ENTRY, CANDIDATES);

    expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
  });
});

describe('runCompaction — shape validation (business rules)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConsent.mockReturnValue(undefined);
  });

  it('rejects when compacted_text is missing', async () => {
    const bad = { supersedes: [], topics: ['sqlite'] };
    mockMessagesCreate.mockResolvedValueOnce(makeToolUseResponse(bad));
    mockMessagesCreate.mockResolvedValueOnce(makeToolUseResponse(bad));

    const result = await runCompaction(NEW_ENTRY, CANDIDATES);
    expect(result.status).toBe('response_invalid');
  });

  it('rejects when compacted_text is not a string', async () => {
    const bad = { compacted_text: 42, supersedes: [], topics: [] };
    mockMessagesCreate.mockResolvedValueOnce(makeToolUseResponse(bad));
    mockMessagesCreate.mockResolvedValueOnce(makeToolUseResponse(bad));

    const result = await runCompaction(NEW_ENTRY, CANDIDATES);
    expect(result.status).toBe('response_invalid');
  });

  it('rejects when compacted_text is an empty string', async () => {
    const bad = { compacted_text: '', supersedes: [], topics: [] };
    mockMessagesCreate.mockResolvedValueOnce(makeToolUseResponse(bad));
    mockMessagesCreate.mockResolvedValueOnce(makeToolUseResponse(bad));

    const result = await runCompaction(NEW_ENTRY, CANDIDATES);
    expect(result.status).toBe('response_invalid');
  });

  it('rejects when compacted_text is whitespace-only', async () => {
    const bad = { compacted_text: '   \t\n  ', supersedes: [], topics: [] };
    mockMessagesCreate.mockResolvedValueOnce(makeToolUseResponse(bad));
    mockMessagesCreate.mockResolvedValueOnce(makeToolUseResponse(bad));

    const result = await runCompaction(NEW_ENTRY, CANDIDATES);
    expect(result.status).toBe('response_invalid');
  });

  it('rejects when supersedes contains non-string elements', async () => {
    const bad = { compacted_text: 'ok', supersedes: [1, 2], topics: [] };
    mockMessagesCreate.mockResolvedValueOnce(makeToolUseResponse(bad));
    mockMessagesCreate.mockResolvedValueOnce(makeToolUseResponse(bad));

    const result = await runCompaction(NEW_ENTRY, CANDIDATES);
    expect(result.status).toBe('response_invalid');
  });

  it('rejects when topics contains non-string elements', async () => {
    const bad = { compacted_text: 'ok', supersedes: [], topics: [true, false] };
    mockMessagesCreate.mockResolvedValueOnce(makeToolUseResponse(bad));
    mockMessagesCreate.mockResolvedValueOnce(makeToolUseResponse(bad));

    const result = await runCompaction(NEW_ENTRY, CANDIDATES);
    expect(result.status).toBe('response_invalid');
  });

  it('accepts a response with empty supersedes and topics arrays', async () => {
    const minimal = { compacted_text: 'net-new entry.', supersedes: [], topics: [] };
    mockMessagesCreate.mockResolvedValueOnce(makeToolUseResponse(minimal));

    const result = await runCompaction(NEW_ENTRY, CANDIDATES);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.supersedes).toEqual([]);
      expect(result.topics).toEqual([]);
    }
  });
});

describe('runCompaction — consent gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls requireLlmConsent before any SDK call', async () => {
    mockConsent.mockReturnValue(undefined);
    mockMessagesCreate.mockResolvedValueOnce(makeToolUseResponse(VALID_TOOL_INPUT));

    await runCompaction(NEW_ENTRY, CANDIDATES);

    expect(mockConsent).toHaveBeenCalled();
  });

  it('propagates LlmConsentError when consent is not granted', async () => {
    const err = new Error('LLM consent not granted');
    err.name = 'LlmConsentError';
    mockConsent.mockImplementationOnce(() => {
      throw err;
    });

    await expect(runCompaction(NEW_ENTRY, CANDIDATES)).rejects.toThrow('LLM consent not granted');

    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });
});

describe('runCompaction — network errors bubble up', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConsent.mockReturnValue(undefined);
  });

  it('propagates a network/API error from the SDK without retry', async () => {
    const networkErr = Object.assign(new Error('Connection refused'), { status: 503 });
    mockMessagesCreate.mockRejectedValueOnce(networkErr);

    await expect(runCompaction(NEW_ENTRY, CANDIDATES)).rejects.toThrow('Connection refused');

    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });
});
