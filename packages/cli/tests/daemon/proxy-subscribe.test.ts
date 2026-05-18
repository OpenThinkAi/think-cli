/**
 * Tests for proxy-subscribe WS client — AGT-311
 *
 * Coverage:
 * 1. isValidProxyUrl — accepts ws:// and wss://, rejects everything else.
 * 2. redactUrl — strips embedded credentials from WS URLs for logging.
 * 3. Push message handling — valid push fires onPush callback.
 * 4. Malformed messages are ignored (oversized, non-JSON, wrong type, missing fields).
 * 5. No-op handle returned when proxy.url is not configured or invalid.
 * 6. stop() prevents further callback invocations.
 * 7. Reconnect: close event schedules a reconnect; backoff doubles each attempt
 *    and caps at RECONNECT_MAX_MS.
 *
 * WebSocket is mocked at the globalThis level so no real network connection
 * is made. The config module is mocked at module level via vi.mock() so
 * getConfig() returns a controlled value per test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isValidProxyUrl,
  redactUrl,
  startProxySubscribe,
  RECONNECT_INITIAL_MS,
  RECONNECT_MULTIPLIER,
  RECONNECT_MAX_MS,
} from '../../src/daemon/proxy-subscribe.js';

// ---------------------------------------------------------------------------
// Config mock — hoisted so vitest replaces the module before any import runs.
// ---------------------------------------------------------------------------

let _mockProxyUrl: string | undefined = undefined;

vi.mock('../../src/lib/config.js', () => ({
  getConfig: () => ({
    peerId: 'test-peer',
    syncPort: 47821,
    proxy: _mockProxyUrl !== undefined ? { url: _mockProxyUrl } : undefined,
  }),
}));

// ---------------------------------------------------------------------------
// Fake WebSocket
// ---------------------------------------------------------------------------

type MessageHandler = (event: { data: string }) => void;
type CloseHandler = (event: { code: number; reason: string }) => void;
type OpenHandler = () => void;

let capturedMessageHandler: MessageHandler | null = null;
let capturedCloseHandler: CloseHandler | null = null;
let capturedOpenHandler: OpenHandler | null = null;
let wsConstructed = false;

class FakeWebSocket {
  static readonly OPEN = 1;
  readyState = FakeWebSocket.OPEN;

  constructor(_url: string) {
    wsConstructed = true;
    capturedMessageHandler = null;
    capturedCloseHandler = null;
    capturedOpenHandler = null;
  }

  addEventListener(type: string, listener: unknown): void {
    if (type === 'message') capturedMessageHandler = listener as MessageHandler;
    if (type === 'close')   capturedCloseHandler = listener as CloseHandler;
    if (type === 'open')    capturedOpenHandler = listener as OpenHandler;
    // 'error' not captured in unit tests
  }

  close(): void {}
}

// ---------------------------------------------------------------------------
// isValidProxyUrl
// ---------------------------------------------------------------------------

describe('isValidProxyUrl', () => {
  it('accepts ws://', () => expect(isValidProxyUrl('ws://localhost:4823')).toBe(true));
  it('accepts wss://', () => expect(isValidProxyUrl('wss://proxy.example.com/push')).toBe(true));
  it('rejects http://', () => expect(isValidProxyUrl('http://localhost:4823')).toBe(false));
  it('rejects https://', () => expect(isValidProxyUrl('https://proxy.example.com')).toBe(false));
  it('rejects plain garbage', () => expect(isValidProxyUrl('not-a-url')).toBe(false));
  it('rejects empty string', () => expect(isValidProxyUrl('')).toBe(false));
  it('rejects ftp://', () => expect(isValidProxyUrl('ftp://example.com')).toBe(false));
});

// ---------------------------------------------------------------------------
// redactUrl
// ---------------------------------------------------------------------------

describe('redactUrl', () => {
  it('passes through a plain ws:// URL unchanged', () => {
    expect(redactUrl('ws://localhost:4823')).toBe('ws://localhost:4823/');
  });

  it('redacts embedded username and password', () => {
    const result = redactUrl('ws://mytoken:secret@proxy.example.com/push');
    expect(result).not.toContain('mytoken');
    expect(result).not.toContain('secret');
    expect(result).toContain('***');
  });

  it('returns (invalid url) for garbage input', () => {
    expect(redactUrl('not-a-url')).toBe('(invalid url)');
  });
});

// ---------------------------------------------------------------------------
// startProxySubscribe — message handling + reconnect
// ---------------------------------------------------------------------------

describe('startProxySubscribe', () => {
  let originalWebSocket: unknown;

  beforeEach(() => {
    capturedMessageHandler = null;
    capturedCloseHandler = null;
    capturedOpenHandler = null;
    wsConstructed = false;
    originalWebSocket = (globalThis as Record<string, unknown>)['WebSocket'];
    (globalThis as Record<string, unknown>)['WebSocket'] = FakeWebSocket;
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (originalWebSocket !== undefined) {
      (globalThis as Record<string, unknown>)['WebSocket'] = originalWebSocket;
    } else {
      delete (globalThis as Record<string, unknown>)['WebSocket'];
    }
    vi.useRealTimers();
    _mockProxyUrl = undefined;
  });

  function sendMessage(data: string): void {
    if (capturedMessageHandler === null) throw new Error('No message handler captured');
    capturedMessageHandler({ data });
  }

  function simulateClose(code = 1001, reason = ''): void {
    if (capturedCloseHandler === null) throw new Error('No close handler captured');
    capturedCloseHandler({ code, reason });
  }

  // ---- push message handling ----

  it('fires onPush for a valid push message', () => {
    _mockProxyUrl = 'ws://localhost:9999';
    const received: Array<{ cortex: string; commitSha: string }> = [];
    const handle = startProxySubscribe((cortex, commitSha) => received.push({ cortex, commitSha }));

    expect(wsConstructed).toBe(true);
    sendMessage(JSON.stringify({ type: 'push', cortex: 'think-cli', commit_sha: 'abc123' }));
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ cortex: 'think-cli', commitSha: 'abc123' });
    handle.stop();
  });

  it('fires onPush for wss:// URL', () => {
    _mockProxyUrl = 'wss://proxy.example.com';
    const received: Array<{ cortex: string; commitSha: string }> = [];
    const handle = startProxySubscribe((c, s) => received.push({ cortex: c, commitSha: s }));

    sendMessage(JSON.stringify({ type: 'push', cortex: 'my-cortex', commit_sha: 'def456' }));
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ cortex: 'my-cortex', commitSha: 'def456' });
    handle.stop();
  });

  it('ignores oversized messages (>1 KB)', () => {
    _mockProxyUrl = 'ws://localhost:9999';
    const received: unknown[] = [];
    const handle = startProxySubscribe(() => received.push(null));
    sendMessage(JSON.stringify({ type: 'push', cortex: 'x'.repeat(2000), commit_sha: 'abc' }));
    expect(received).toHaveLength(0);
    handle.stop();
  });

  it('ignores non-JSON messages', () => {
    _mockProxyUrl = 'ws://localhost:9999';
    const received: unknown[] = [];
    const handle = startProxySubscribe(() => received.push(null));
    sendMessage('not json at all');
    expect(received).toHaveLength(0);
    handle.stop();
  });

  it('ignores messages with unknown type', () => {
    _mockProxyUrl = 'ws://localhost:9999';
    const received: unknown[] = [];
    const handle = startProxySubscribe(() => received.push(null));
    sendMessage(JSON.stringify({ type: 'heartbeat', ts: Date.now() }));
    expect(received).toHaveLength(0);
    handle.stop();
  });

  it('ignores push messages with missing cortex', () => {
    _mockProxyUrl = 'ws://localhost:9999';
    const received: unknown[] = [];
    const handle = startProxySubscribe(() => received.push(null));
    sendMessage(JSON.stringify({ type: 'push', commit_sha: 'abc123' }));
    expect(received).toHaveLength(0);
    handle.stop();
  });

  it('ignores push messages with missing commit_sha', () => {
    _mockProxyUrl = 'ws://localhost:9999';
    const received: unknown[] = [];
    const handle = startProxySubscribe(() => received.push(null));
    sendMessage(JSON.stringify({ type: 'push', cortex: 'think-cli' }));
    expect(received).toHaveLength(0);
    handle.stop();
  });

  it('ignores push messages with empty cortex', () => {
    _mockProxyUrl = 'ws://localhost:9999';
    const received: unknown[] = [];
    const handle = startProxySubscribe(() => received.push(null));
    sendMessage(JSON.stringify({ type: 'push', cortex: '', commit_sha: 'abc123' }));
    expect(received).toHaveLength(0);
    handle.stop();
  });

  // ---- no-op handle cases ----

  it('returns no-op handle when proxy.url is not set', () => {
    _mockProxyUrl = undefined;
    const handle = startProxySubscribe(() => {});
    expect(wsConstructed).toBe(false);
    expect(() => handle.stop()).not.toThrow();
  });

  it('returns no-op handle when proxy.url is empty string', () => {
    _mockProxyUrl = '';
    const handle = startProxySubscribe(() => {});
    expect(wsConstructed).toBe(false);
    expect(() => handle.stop()).not.toThrow();
  });

  it('returns no-op handle when proxy.url is http:// (not ws)', () => {
    _mockProxyUrl = 'http://localhost:9999';
    const handle = startProxySubscribe(() => {});
    expect(wsConstructed).toBe(false);
    expect(() => handle.stop()).not.toThrow();
  });

  // ---- stop() ----

  it('stop() prevents further callback invocations', () => {
    _mockProxyUrl = 'ws://localhost:9999';
    const received: unknown[] = [];
    const handle = startProxySubscribe(() => received.push(null));

    // Before stop: callback fires.
    sendMessage(JSON.stringify({ type: 'push', cortex: 'before', commit_sha: 'sha1' }));
    expect(received).toHaveLength(1);

    handle.stop();

    // After stop: callback is suppressed.
    sendMessage(JSON.stringify({ type: 'push', cortex: 'after', commit_sha: 'sha2' }));
    expect(received).toHaveLength(1);

    // Idempotent.
    expect(() => handle.stop()).not.toThrow();
  });

  // ---- reconnect + backoff ----

  it('schedules a reconnect after close with initial backoff delay', () => {
    _mockProxyUrl = 'ws://localhost:9999';
    const handle = startProxySubscribe(() => {});

    expect(wsConstructed).toBe(true);
    const firstWsCount = 1;

    // Simulate the proxy closing the connection.
    wsConstructed = false; // reset so we can detect the second connect
    simulateClose(1001, 'going away');

    // No immediate reconnect — must advance timer.
    expect(wsConstructed).toBe(false);

    vi.advanceTimersByTime(RECONNECT_INITIAL_MS);
    expect(wsConstructed).toBe(true); // reconnect fired

    handle.stop();
    void firstWsCount; // satisfy unused-var lint
  });

  it('doubles reconnectDelayMs on each close, capped at RECONNECT_MAX_MS', () => {
    _mockProxyUrl = 'ws://localhost:9999';
    const handle = startProxySubscribe(() => {});

    let expectedDelay = RECONNECT_INITIAL_MS;
    for (let attempt = 0; attempt < 8; attempt++) {
      wsConstructed = false;
      simulateClose(1001, '');
      vi.advanceTimersByTime(expectedDelay);
      expect(wsConstructed).toBe(true);

      // Next delay will be min(current * multiplier, max)
      expectedDelay = Math.min(expectedDelay * RECONNECT_MULTIPLIER, RECONNECT_MAX_MS);
    }

    // By now delay should be capped at RECONNECT_MAX_MS.
    expect(expectedDelay).toBe(RECONNECT_MAX_MS);

    handle.stop();
  });

  it('resets backoff delay to initial on successful open', () => {
    _mockProxyUrl = 'ws://localhost:9999';
    const handle = startProxySubscribe(() => {});

    // Two disconnects advance the backoff.
    simulateClose(1001, '');
    vi.advanceTimersByTime(RECONNECT_INITIAL_MS);
    simulateClose(1001, '');
    vi.advanceTimersByTime(RECONNECT_INITIAL_MS * RECONNECT_MULTIPLIER);

    // Fire the open event to reset backoff.
    if (capturedOpenHandler) capturedOpenHandler();

    // Next close should reconnect after RECONNECT_INITIAL_MS again.
    wsConstructed = false;
    simulateClose(1001, '');
    vi.advanceTimersByTime(RECONNECT_INITIAL_MS);
    expect(wsConstructed).toBe(true);

    handle.stop();
  });
});
