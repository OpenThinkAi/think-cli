/**
 * Tests for the compaction SDK call wrapper (AGT-298).
 *
 * All tests mock the Anthropic SDK — no real network calls are made.
 *
 * Coverage:
 * 1. Parses a well-formed fixture response into CompactionSuccess.
 * 2. On first invalid response, retries once and succeeds on the second call.
 * 3. On two consecutive invalid responses, returns { status: "response_invalid" }.
 * 4. Shape validation rejects responses missing required fields.
 * 5. Shape validation rejects responses where field types are wrong.
 * 6. Shape validation rejects responses where compacted_text is empty.
 * 7. LLM consent gate is enforced before any SDK call.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const VALID_RESPONSE_BODY = {
  compacted_text:
    'Client storage: returned to sqlite after indexedDb perf problems. sqlite is the durable choice.',
  supersedes: ['mem_8af2'],
  topics: ['sqlite', 'storage'],
};

// ---------------------------------------------------------------------------
// SDK mock helpers
// ---------------------------------------------------------------------------

function makeSuccessResponse(body: unknown) {
  return {
    content: [{ type: 'text', text: JSON.stringify(body) }],
    stop_reason: 'end_turn',
  };
}

function makeMalformedResponse(text: string) {
  return {
    content: [{ type: 'text', text }],
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
//
// We mock:
//   - '@anthropic-ai/sdk'  — so new Anthropic() returns a fake client
//   - '../../lib/llm-consent.js' (relative from call.ts) via its module path
//     as seen from the test runner: '../../../src/lib/llm-consent.js'
//
// vitest's vi.mock is hoisted so these factories run before any import.
// ---------------------------------------------------------------------------

const mockMessagesCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  // We need a class (constructor) here because the source does `new Anthropic()`.
  class MockAnthropic {
    messages = { create: mockMessagesCreate };
  }
  return {
    default: MockAnthropic,
  };
});

// Mock LLM consent to always pass (individual tests override when testing the gate).
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

// Single vi.mocked() cast — reused across all describe blocks.
const mockConsent = vi.mocked(requireLlmConsent);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runCompaction — happy path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConsent.mockReturnValue(undefined);
  });

  it('returns status:ok with parsed fields for a valid response', async () => {
    mockMessagesCreate.mockResolvedValueOnce(makeSuccessResponse(VALID_RESPONSE_BODY));

    const result = await runCompaction(NEW_ENTRY, CANDIDATES);

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.compacted_text).toBe(VALID_RESPONSE_BODY.compacted_text);
      expect(result.supersedes).toEqual(['mem_8af2']);
      expect(result.topics).toEqual(['sqlite', 'storage']);
    }
  });

  it('passes the system prompt text to messages.create', async () => {
    mockMessagesCreate.mockResolvedValueOnce(makeSuccessResponse(VALID_RESPONSE_BODY));

    await runCompaction(NEW_ENTRY, CANDIDATES);

    const callArgs = mockMessagesCreate.mock.calls[0][0];
    expect(callArgs.system).toHaveLength(1);
    expect(callArgs.system[0].type).toBe('text');
    expect(typeof callArgs.system[0].text).toBe('string');
    expect(callArgs.system[0].text.length).toBeGreaterThan(100);
  });

  it('sets cache_control: ephemeral on the system block', async () => {
    mockMessagesCreate.mockResolvedValueOnce(makeSuccessResponse(VALID_RESPONSE_BODY));

    await runCompaction(NEW_ENTRY, CANDIDATES);

    const callArgs = mockMessagesCreate.mock.calls[0][0];
    expect(callArgs.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('uses the expected model, max_tokens, and temperature', async () => {
    mockMessagesCreate.mockResolvedValueOnce(makeSuccessResponse(VALID_RESPONSE_BODY));

    await runCompaction(NEW_ENTRY, CANDIDATES);

    const callArgs = mockMessagesCreate.mock.calls[0][0];
    expect(callArgs.model).toBe('claude-sonnet-4-6');
    expect(callArgs.max_tokens).toBe(600);
    expect(callArgs.temperature).toBe(0.2);
  });

  it('works with an empty candidates array', async () => {
    mockMessagesCreate.mockResolvedValueOnce(makeSuccessResponse(VALID_RESPONSE_BODY));

    const result = await runCompaction(NEW_ENTRY, []);

    expect(result.status).toBe('ok');
  });
});

describe('runCompaction — retry logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConsent.mockReturnValue(undefined);
  });

  it('retries once on parse failure and returns ok on second attempt', async () => {
    // First call: malformed JSON
    mockMessagesCreate.mockResolvedValueOnce(makeMalformedResponse('not valid json }{'));
    // Second call: valid response
    mockMessagesCreate.mockResolvedValueOnce(makeSuccessResponse(VALID_RESPONSE_BODY));

    const result = await runCompaction(NEW_ENTRY, CANDIDATES);

    expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('ok');
  });

  it('returns response_invalid after two consecutive parse failures', async () => {
    mockMessagesCreate.mockResolvedValueOnce(makeMalformedResponse('{ "wrong": "shape" }'));
    mockMessagesCreate.mockResolvedValueOnce(makeMalformedResponse('still wrong'));

    const result = await runCompaction(NEW_ENTRY, CANDIDATES);

    expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('response_invalid');
  });

  it('returns response_invalid when first is malformed and second is also malformed JSON', async () => {
    mockMessagesCreate.mockResolvedValueOnce(makeMalformedResponse('not json at all'));
    mockMessagesCreate.mockResolvedValueOnce(makeMalformedResponse('```json\n{}\n```'));

    const result = await runCompaction(NEW_ENTRY, CANDIDATES);

    expect(result.status).toBe('response_invalid');
  });

  it('returns response_invalid when response content array is empty (no text block)', async () => {
    mockMessagesCreate.mockResolvedValueOnce(makeEmptyContentResponse());
    mockMessagesCreate.mockResolvedValueOnce(makeEmptyContentResponse());

    const result = await runCompaction(NEW_ENTRY, CANDIDATES);

    expect(result.status).toBe('response_invalid');
  });

  it('does NOT make a third attempt', async () => {
    mockMessagesCreate.mockResolvedValue(makeMalformedResponse('bad'));

    await runCompaction(NEW_ENTRY, CANDIDATES);

    // Exactly two attempts, no more
    expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
  });
});

describe('runCompaction — shape validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConsent.mockReturnValue(undefined);
  });

  it('rejects a response where compacted_text is missing', async () => {
    const bad = { supersedes: [], topics: ['sqlite'] };
    mockMessagesCreate.mockResolvedValueOnce(makeSuccessResponse(bad));
    mockMessagesCreate.mockResolvedValueOnce(makeSuccessResponse(bad));

    const result = await runCompaction(NEW_ENTRY, CANDIDATES);
    expect(result.status).toBe('response_invalid');
  });

  it('rejects a response where compacted_text is not a string', async () => {
    const bad = { compacted_text: 42, supersedes: [], topics: [] };
    mockMessagesCreate.mockResolvedValueOnce(makeSuccessResponse(bad));
    mockMessagesCreate.mockResolvedValueOnce(makeSuccessResponse(bad));

    const result = await runCompaction(NEW_ENTRY, CANDIDATES);
    expect(result.status).toBe('response_invalid');
  });

  it('rejects a response where compacted_text is an empty string', async () => {
    const bad = { compacted_text: '', supersedes: [], topics: [] };
    mockMessagesCreate.mockResolvedValueOnce(makeSuccessResponse(bad));
    mockMessagesCreate.mockResolvedValueOnce(makeSuccessResponse(bad));

    const result = await runCompaction(NEW_ENTRY, CANDIDATES);
    expect(result.status).toBe('response_invalid');
  });

  it('rejects a response where compacted_text is whitespace-only', async () => {
    const bad = { compacted_text: '   \t\n  ', supersedes: [], topics: [] };
    mockMessagesCreate.mockResolvedValueOnce(makeSuccessResponse(bad));
    mockMessagesCreate.mockResolvedValueOnce(makeSuccessResponse(bad));

    const result = await runCompaction(NEW_ENTRY, CANDIDATES);
    expect(result.status).toBe('response_invalid');
  });

  it('rejects a response where supersedes is not an array', async () => {
    const bad = { compacted_text: 'ok', supersedes: 'not-array', topics: [] };
    mockMessagesCreate.mockResolvedValueOnce(makeSuccessResponse(bad));
    mockMessagesCreate.mockResolvedValueOnce(makeSuccessResponse(bad));

    const result = await runCompaction(NEW_ENTRY, CANDIDATES);
    expect(result.status).toBe('response_invalid');
  });

  it('rejects a response where supersedes contains non-string elements', async () => {
    const bad = { compacted_text: 'ok', supersedes: [1, 2], topics: [] };
    mockMessagesCreate.mockResolvedValueOnce(makeSuccessResponse(bad));
    mockMessagesCreate.mockResolvedValueOnce(makeSuccessResponse(bad));

    const result = await runCompaction(NEW_ENTRY, CANDIDATES);
    expect(result.status).toBe('response_invalid');
  });

  it('rejects a response where topics is not an array', async () => {
    const bad = { compacted_text: 'ok', supersedes: [], topics: 'sqlite' };
    mockMessagesCreate.mockResolvedValueOnce(makeSuccessResponse(bad));
    mockMessagesCreate.mockResolvedValueOnce(makeSuccessResponse(bad));

    const result = await runCompaction(NEW_ENTRY, CANDIDATES);
    expect(result.status).toBe('response_invalid');
  });

  it('rejects a response where topics contains non-string elements', async () => {
    const bad = { compacted_text: 'ok', supersedes: [], topics: [true, false] };
    mockMessagesCreate.mockResolvedValueOnce(makeSuccessResponse(bad));
    mockMessagesCreate.mockResolvedValueOnce(makeSuccessResponse(bad));

    const result = await runCompaction(NEW_ENTRY, CANDIDATES);
    expect(result.status).toBe('response_invalid');
  });

  it('accepts a response with empty supersedes and topics arrays', async () => {
    const minimal = { compacted_text: 'net-new entry.', supersedes: [], topics: [] };
    mockMessagesCreate.mockResolvedValueOnce(makeSuccessResponse(minimal));

    const result = await runCompaction(NEW_ENTRY, CANDIDATES);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.supersedes).toEqual([]);
      expect(result.topics).toEqual([]);
    }
  });

  it('rejects a null top-level response', async () => {
    mockMessagesCreate.mockResolvedValueOnce(makeSuccessResponse(null));
    mockMessagesCreate.mockResolvedValueOnce(makeSuccessResponse(null));

    const result = await runCompaction(NEW_ENTRY, CANDIDATES);
    expect(result.status).toBe('response_invalid');
  });

  it('rejects an array top-level response', async () => {
    mockMessagesCreate.mockResolvedValueOnce(makeSuccessResponse([VALID_RESPONSE_BODY]));
    mockMessagesCreate.mockResolvedValueOnce(makeSuccessResponse([VALID_RESPONSE_BODY]));

    const result = await runCompaction(NEW_ENTRY, CANDIDATES);
    expect(result.status).toBe('response_invalid');
  });
});

describe('runCompaction — consent gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls requireLlmConsent before any SDK call', async () => {
    mockConsent.mockReturnValue(undefined);
    mockMessagesCreate.mockResolvedValueOnce(makeSuccessResponse(VALID_RESPONSE_BODY));

    await runCompaction(NEW_ENTRY, CANDIDATES);

    // Consent was checked
    expect(mockConsent).toHaveBeenCalled();
  });

  it('propagates LlmConsentError when consent is not granted', async () => {
    const err = new Error('LLM consent not granted');
    err.name = 'LlmConsentError';
    mockConsent.mockImplementationOnce(() => {
      throw err;
    });

    await expect(runCompaction(NEW_ENTRY, CANDIDATES)).rejects.toThrow('LLM consent not granted');

    // No SDK calls should have been made
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

    // Only one attempt — network errors are not retried here
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });
});
