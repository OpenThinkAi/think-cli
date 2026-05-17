/**
 * Tests for AGT-280 JSON-line protocol framing.
 *
 * Uses a real in-process socket pair (net.createServer + net.createConnection)
 * backed by a tmp THINK_HOME so the tests never touch ~/.think.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLineFraming, dispatchRequest, sendResponse } from '../../src/daemon/protocol.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'think-proto-test-'));
}

/**
 * Create a local socket server that applies the JSON-line protocol and
 * returns a client socket already connected to it.
 *
 * The server side drives parseLineFraming + dispatchRequest for every
 * connection. The caller controls what the client sends and receives.
 */
async function createProtocolPair(socketPath: string): Promise<{
  client: net.Socket;
  server: net.Server;
  close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((serverSocket) => {
      (async () => {
        for await (const request of parseLineFraming(serverSocket)) {
          await dispatchRequest(serverSocket, request);
        }
      })().catch(() => serverSocket.destroy());
    });

    server.once('error', reject);

    server.listen(socketPath, () => {
      const client = net.createConnection({ path: socketPath });
      client.once('error', reject);
      client.once('connect', () => {
        resolve({
          client,
          server,
          close: () =>
            new Promise<void>((res) => {
              client.destroy();
              server.close(() => res());
            }),
        });
      });
    });
  });
}

/**
 * Send one line on `socket` and collect lines until `predicate` returns true
 * or the timeout fires. Returns all collected lines.
 */
function sendAndCollect(
  client: net.Socket,
  payload: string,
  predicate: (line: string) => boolean,
  timeoutMs = 3000,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    let buf = '';

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`sendAndCollect: timed out after ${timeoutMs}ms. Lines so far: ${JSON.stringify(lines)}`));
    }, timeoutMs);

    function onData(chunk: Buffer): void {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.length === 0) continue;
        lines.push(line);
        if (predicate(line)) {
          cleanup();
          resolve(lines);
          return;
        }
      }
    }

    function onError(err: Error): void {
      cleanup();
      reject(err);
    }

    function cleanup(): void {
      clearTimeout(timer);
      client.off('data', onData);
      client.off('error', onError);
    }

    client.on('data', onData);
    client.on('error', onError);
    client.write(payload + '\n');
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === 'win32')('JSON-line protocol — ping smoke test', () => {
  let dir: string;
  let socketPath: string;
  let pair: Awaited<ReturnType<typeof createProtocolPair>>;

  beforeEach(async () => {
    dir = tmpDir();
    socketPath = join(dir, 'test.sock');
    pair = await createProtocolPair(socketPath);
  });

  afterEach(async () => {
    await pair.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('ping request returns { result: "pong" }', async () => {
    const requestId = 'test-ping-001';
    const request = JSON.stringify({ request_id: requestId, method: 'ping', params: {} });

    const lines = await sendAndCollect(
      pair.client,
      request,
      (line) => {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          return parsed['request_id'] === requestId;
        } catch {
          return false;
        }
      },
    );

    expect(lines.length).toBeGreaterThanOrEqual(1);
    const response = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
    expect(response['request_id']).toBe(requestId);
    expect(response['result']).toBe('pong');
    expect(response).not.toHaveProperty('error');
  });
});

describe.skipIf(process.platform === 'win32')('JSON-line protocol — malformed JSON', () => {
  let dir: string;
  let socketPath: string;
  let pair: Awaited<ReturnType<typeof createProtocolPair>>;

  beforeEach(async () => {
    dir = tmpDir();
    socketPath = join(dir, 'test.sock');
    pair = await createProtocolPair(socketPath);
  });

  afterEach(async () => {
    await pair.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('malformed JSON returns parse_error without closing the connection', async () => {
    const malformed = '{ this is not valid json ';

    const lines = await sendAndCollect(
      pair.client,
      malformed,
      (line) => {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          const err = parsed['error'] as { code?: string } | undefined;
          return err?.code === 'parse_error';
        } catch {
          return false;
        }
      },
    );

    expect(lines.length).toBeGreaterThanOrEqual(1);
    const response = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
    expect((response['error'] as { code?: string })['code']).toBe('parse_error');

    // Verify the connection is still alive by sending a valid ping afterwards.
    const pingId = 'post-error-ping';
    const pingLines = await sendAndCollect(
      pair.client,
      JSON.stringify({ request_id: pingId, method: 'ping', params: {} }),
      (line) => {
        try {
          return (JSON.parse(line) as Record<string, unknown>)['request_id'] === pingId;
        } catch {
          return false;
        }
      },
    );

    const pingResponse = JSON.parse(pingLines[pingLines.length - 1]) as Record<string, unknown>;
    expect(pingResponse['result']).toBe('pong');
  });
});

describe.skipIf(process.platform === 'win32')('JSON-line protocol — payload_too_large', () => {
  let dir: string;
  let socketPath: string;
  let pair: Awaited<ReturnType<typeof createProtocolPair>>;

  beforeEach(async () => {
    dir = tmpDir();
    socketPath = join(dir, 'test.sock');
    pair = await createProtocolPair(socketPath);
  });

  afterEach(async () => {
    await pair.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('payload > 1MB returns payload_too_large without closing the connection', async () => {
    // Build a line that exceeds 1 MiB (1,048,576 bytes).
    const oversized = 'x'.repeat(1 * 1024 * 1024 + 1);

    const lines = await sendAndCollect(
      pair.client,
      oversized,
      (line) => {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          const err = parsed['error'] as { code?: string } | undefined;
          return err?.code === 'payload_too_large';
        } catch {
          return false;
        }
      },
      5000,
    );

    expect(lines.length).toBeGreaterThanOrEqual(1);
    const response = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
    expect((response['error'] as { code?: string })['code']).toBe('payload_too_large');

    // Connection must still be alive.
    const pingId = 'post-overflow-ping';
    const pingLines = await sendAndCollect(
      pair.client,
      JSON.stringify({ request_id: pingId, method: 'ping', params: {} }),
      (line) => {
        try {
          return (JSON.parse(line) as Record<string, unknown>)['request_id'] === pingId;
        } catch {
          return false;
        }
      },
    );

    const pingResponse = JSON.parse(pingLines[pingLines.length - 1]) as Record<string, unknown>;
    expect(pingResponse['result']).toBe('pong');
  });
});

describe.skipIf(process.platform === 'win32')('sendResponse', () => {
  let dir: string;
  let socketPath: string;

  beforeEach(() => {
    dir = tmpDir();
    socketPath = join(dir, 'test.sock');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('serializes result response as a single JSON line', async () => {
    const received: string[] = [];

    const server = await new Promise<net.Server>((resolve, reject) => {
      const s = net.createServer((conn) => {
        sendResponse(conn, { request_id: 'r1', result: { ok: true } });
      });
      s.once('error', reject);
      s.listen(socketPath, () => resolve(s));
    });

    const line = await new Promise<string>((resolve, reject) => {
      const c = net.createConnection({ path: socketPath });
      let buf = '';
      c.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl !== -1) {
          resolve(buf.slice(0, nl));
          c.destroy();
          server.close();
        }
      });
      c.on('error', reject);
    });

    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed['request_id']).toBe('r1');
    expect(parsed['result']).toEqual({ ok: true });
    expect(parsed).not.toHaveProperty('error');
  });
});
