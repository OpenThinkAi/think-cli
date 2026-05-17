/**
 * Tests for the Claude Code UserPromptSubmit hook (AGT-312).
 *
 * Strategy:
 *   - Unit tests for `buildAdditionalContext` (imported directly).
 *   - Integration tests that exercise the full stdin→main()→stdout path via
 *     `runHook()`. This helper creates in-memory Readable/Writable streams,
 *     calls the exported `main(stdin, stdout)`, and returns the captured
 *     stdout as a parsed JSON object. No process.stdin/stdout override needed
 *     because `main` accepts injectable I/O for testability.
 *
 * `connectDaemon` is mocked so no real daemon is required.
 */
import { Readable, Writable } from 'node:stream';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock daemon-client before any import of the hook module
// ---------------------------------------------------------------------------

// vi.mock is hoisted to the top of the file by Vitest; variables referenced
// inside the factory must be hoisted too so they are initialised before the
// factory runs. Use vi.hoisted() for this purpose.
const { mockCall, mockClose, mockConnect } = vi.hoisted(() => ({
  mockCall: vi.fn(),
  mockClose: vi.fn(),
  mockConnect: vi.fn(),
}));

vi.mock('../../src/lib/daemon-client.js', () => {
  class DaemonUnavailableError extends Error {
    readonly logPath: string;
    constructor(message: string, logPath: string) {
      super(message);
      this.name = 'DaemonUnavailableError';
      this.logPath = logPath;
    }
  }
  return {
    DaemonUnavailableError,
    connectDaemon: mockConnect,
  };
});

// ---------------------------------------------------------------------------
// Import the hook internals after mocks are wired
// ---------------------------------------------------------------------------

import {
  main,
  buildAdditionalContext,
  writeWithContext,
  writeEmpty,
  RECALL_LIMIT,
  RECALL_TIMEOUT_MS,
  MIN_PROMPT_LENGTH,
} from '../../src/hooks/user-prompt-submit.js';
import type { RecallEntry } from '../../src/daemon/recall.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal RecallEntry for tests. */
function makeEntry(content: string, cortex: string): RecallEntry {
  return {
    id: 'test-id',
    ts: new Date().toISOString(),
    kind: null,
    content,
    topics: [],
    similarity: 0.9,
    score: 0.9,
    cortex,
  };
}

/**
 * Run the hook's `main(stdin, stdout)` with a synthetic payload.
 *
 * Creates an in-memory Readable that emits the serialised payload and a
 * Writable that collects output. Returns the stdout as a parsed JSON object.
 */
async function runHook(payload: unknown): Promise<unknown> {
  // Build synthetic stdin
  const fakeStdin = new Readable({ read() {} });
  fakeStdin.push(JSON.stringify(payload));
  fakeStdin.push(null); // EOF

  // Build synthetic stdout
  const chunks: Buffer[] = [];
  const fakeStdout = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      cb();
    },
  });

  await main(fakeStdin, fakeStdout);

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return JSON.parse(raw);
}

/** Run main() with raw string stdin (for malformed-input tests). */
async function runHookRaw(rawStdin: string): Promise<unknown> {
  const fakeStdin = new Readable({ read() {} });
  fakeStdin.push(rawStdin);
  fakeStdin.push(null);

  const chunks: Buffer[] = [];
  const fakeStdout = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      cb();
    },
  });

  await main(fakeStdin, fakeStdout);

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Unit tests: buildAdditionalContext
// ---------------------------------------------------------------------------

describe('buildAdditionalContext', () => {
  it('returns empty string for empty entries', () => {
    expect(buildAdditionalContext([])).toBe('');
  });

  it('formats a single entry with plural-aware label', () => {
    const entries = [makeEntry('apple orchards in the mountains', 'personal')];
    expect(buildAdditionalContext(entries)).toBe(
      'Relevant context from think (1 entry):\n- [personal] apple orchards in the mountains',
    );
  });

  it('formats multiple entries with cortex tags and plural label', () => {
    const entries = [
      makeEntry('apple orchards in the mountains', 'personal'),
      makeEntry('blue ocean waves at sunset', 'work'),
      makeEntry('cherry blossoms in spring', 'personal'),
    ];
    const ctx = buildAdditionalContext(entries);
    expect(ctx).toMatch(/^Relevant context from think \(3 entries\):/);
    expect(ctx).toContain('- [personal] apple orchards in the mountains');
    expect(ctx).toContain('- [work] blue ocean waves at sunset');
    expect(ctx).toContain('- [personal] cherry blossoms in spring');
  });

  it('omits cortex tag when cortex is empty string', () => {
    const ctx = buildAdditionalContext([makeEntry('some content', '')]);
    expect(ctx).toContain('- some content');
    expect(ctx).not.toContain('[');
  });

  it('handles RECALL_LIMIT entries (5)', () => {
    const entries = Array.from({ length: RECALL_LIMIT }, (_, i) =>
      makeEntry(`entry ${i + 1} content`, 'personal'),
    );
    const ctx = buildAdditionalContext(entries);
    expect(ctx).toMatch(/^Relevant context from think \(5 entries\):/);
    for (let i = 1; i <= RECALL_LIMIT; i++) {
      expect(ctx).toContain(`entry ${i} content`);
    }
  });
});

// ---------------------------------------------------------------------------
// Unit tests: writeWithContext / writeEmpty output shape
// ---------------------------------------------------------------------------

describe('writeWithContext', () => {
  it('emits valid JSON with the correct hookSpecificOutput shape to injected stream', () => {
    const chunks: Buffer[] = [];
    const out = new Writable({
      write(chunk: Buffer, _enc: string, cb: () => void) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
        cb();
      },
    });
    writeWithContext('some context', out);
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8').trim());
    expect(parsed).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'some context',
      },
    });
  });
});

describe('writeEmpty', () => {
  it('emits an empty JSON object to injected stream', () => {
    const chunks: Buffer[] = [];
    const out = new Writable({
      write(chunk: Buffer, _enc: string, cb: () => void) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
        cb();
      },
    });
    writeEmpty(out);
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8').trim());
    expect(parsed).toEqual({});
  });
});


// ---------------------------------------------------------------------------
// Integration tests: full stdin → main() → stdout path
// ---------------------------------------------------------------------------

describe('main() stdin→stdout integration (mocked daemon)', () => {
  beforeEach(() => {
    mockCall.mockReset();
    mockClose.mockReset();
    mockConnect.mockReset();
  });

  it('happy path: emits hookSpecificOutput.additionalContext for valid prompt + recall entries', async () => {
    const entries: RecallEntry[] = [
      makeEntry('apple orchards in the mountains', 'personal'),
      makeEntry('blue ocean waves at sunset', 'work'),
    ];
    mockCall.mockResolvedValue(entries);
    mockConnect.mockResolvedValue({ call: mockCall, close: mockClose });

    const parsed = await runHook({
      user_prompt: 'what project should I work on today?',
      cwd: '/home/user',
      session_id: 'sess-abc',
    }) as Record<string, unknown>;

    const hookOutput = (parsed as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }).hookSpecificOutput;
    expect(hookOutput.hookEventName).toBe('UserPromptSubmit');
    expect(hookOutput.additionalContext).toMatch(
      /^Relevant context from think \(2 entries\):/,
    );
    expect(hookOutput.additionalContext).toContain(
      '- [personal] apple orchards in the mountains',
    );
    expect(hookOutput.additionalContext).toContain(
      '- [work] blue ocean waves at sunset',
    );
  });

  it('emits empty object when daemon returns no entries', async () => {
    mockCall.mockResolvedValue([]);
    mockConnect.mockResolvedValue({ call: mockCall, close: mockClose });

    const parsed = await runHook({ user_prompt: 'what is the status of the project?', cwd: '/', session_id: 's1' });
    expect(parsed).toEqual({});
  });

  it('emits empty object when daemon is unavailable (DaemonUnavailableError)', async () => {
    const { DaemonUnavailableError } = await import('../../src/lib/daemon-client.js');
    mockConnect.mockRejectedValue(new DaemonUnavailableError('daemon not running', '/tmp/daemon.log'));

    const parsed = await runHook({ user_prompt: 'show me all recent memories please', cwd: '/', session_id: 's2' });
    expect(parsed).toEqual({});
    expect(mockCall).not.toHaveBeenCalled();
  });

  it('emits empty object when recall RPC rejects (fail-open)', async () => {
    mockCall.mockRejectedValue(new Error('timeout'));
    mockConnect.mockResolvedValue({ call: mockCall, close: mockClose });

    const parsed = await runHook({ user_prompt: 'what was decided in the last meeting?', cwd: '/', session_id: 's3' });
    expect(parsed).toEqual({});
    // close must still be called even on RPC error
    expect(mockClose).toHaveBeenCalled();
  });

  it('emits empty object when stdin is malformed JSON', async () => {
    const parsed = await runHookRaw('not valid json{{{');
    expect(parsed).toEqual({});
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('emits empty object when user_prompt is missing', async () => {
    const parsed = await runHook({ cwd: '/', session_id: 's4' });
    expect(parsed).toEqual({});
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('emits empty object for short prompts below MIN_PROMPT_LENGTH', async () => {
    // 'ok' is only 2 chars — below the 10-char threshold
    const parsed = await runHook({ user_prompt: 'ok', cwd: '/', session_id: 's5' });
    expect(parsed).toEqual({});
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('triggers recall for prompts exactly at MIN_PROMPT_LENGTH', async () => {
    // Exactly 10 chars prompt
    const prompt = 'a'.repeat(MIN_PROMPT_LENGTH);
    mockCall.mockResolvedValue([]);
    mockConnect.mockResolvedValue({ call: mockCall, close: mockClose });

    const parsed = await runHook({ user_prompt: prompt, cwd: '/', session_id: 's6' });
    expect(parsed).toEqual({});
    // connectDaemon was called — prompt was long enough to trigger RPC
    expect(mockConnect).toHaveBeenCalled();
  });

  it('passes recall params with correct scope and limit to the RPC', async () => {
    const entries: RecallEntry[] = [makeEntry('cherry blossoms in spring', 'personal')];
    mockCall.mockResolvedValue(entries);
    mockConnect.mockResolvedValue({ call: mockCall, close: mockClose });

    await runHook({ user_prompt: 'anything worth recalling today?', cwd: '/', session_id: 's7' });

    expect(mockCall).toHaveBeenCalledWith(
      'recall',
      { query: 'anything worth recalling today?', scope: 'accessible', limit: RECALL_LIMIT },
      RECALL_TIMEOUT_MS,
    );
  });
});
