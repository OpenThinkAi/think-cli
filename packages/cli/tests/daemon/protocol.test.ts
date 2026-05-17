/**
 * Tests for AGT-280 JSON-line protocol framing.
 *
 * Uses a real in-process socket pair (net.createServer + net.createConnection)
 * backed by a tmp dir so the tests never touch ~/.think.
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

/** Parse a response line and return the parsed object. */
function parseLine(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

/** Predicate: line is a response for the given request_id. */
function matchesId(id: string): (line: string) => boolean {
  return (line) => {
    try { return parseLine(line)['request_id'] === id; } catch { return false; }
  };
}

/** Predicate: line is an error response with the given code. */
function matchesError(code: string): (line: string) => boolean {
  return (line) => {
    try {
      const obj = parseLine(line);
      return (obj['error'] as { code?: string } | undefined)?.code === code;
    } catch { return false; }
  };
}

// ---------------------------------------------------------------------------
// Shared socket-pair scaffold
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === 'win32')('JSON-line protocol', () => {
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

  // -------------------------------------------------------------------------
  // ping smoke test
  // -------------------------------------------------------------------------

  it('ping request returns { result: "pong" }', async () => {
    const id = 'test-ping-001';
    const lines = await sendAndCollect(
      pair.client,
      JSON.stringify({ request_id: id, method: 'ping', params: {} }),
      matchesId(id),
    );

    const response = parseLine(lines[lines.length - 1]);
    expect(response['request_id']).toBe(id);
    expect(response['result']).toBe('pong');
    expect(response).not.toHaveProperty('error');
  });

  // -------------------------------------------------------------------------
  // malformed JSON
  // -------------------------------------------------------------------------

  it('malformed JSON returns parse_error without closing the connection', async () => {
    const lines = await sendAndCollect(
      pair.client,
      '{ this is not valid json ',
      matchesError('parse_error'),
    );

    const response = parseLine(lines[lines.length - 1]);
    expect((response['error'] as { code?: string })['code']).toBe('parse_error');

    // Verify the connection is still alive.
    const pingId = 'post-error-ping';
    const pingLines = await sendAndCollect(
      pair.client,
      JSON.stringify({ request_id: pingId, method: 'ping', params: {} }),
      matchesId(pingId),
    );
    expect(parseLine(pingLines[pingLines.length - 1])['result']).toBe('pong');
  });

  // -------------------------------------------------------------------------
  // payload_too_large
  // -------------------------------------------------------------------------

  it('payload > 1MB returns payload_too_large without closing the connection', async () => {
    const oversized = 'x'.repeat(1 * 1024 * 1024 + 1);

    const lines = await sendAndCollect(
      pair.client,
      oversized,
      matchesError('payload_too_large'),
      5000,
    );

    const response = parseLine(lines[lines.length - 1]);
    expect((response['error'] as { code?: string })['code']).toBe('payload_too_large');

    // Connection must still be alive.
    const pingId = 'post-overflow-ping';
    const pingLines = await sendAndCollect(
      pair.client,
      JSON.stringify({ request_id: pingId, method: 'ping', params: {} }),
      matchesId(pingId),
    );
    expect(parseLine(pingLines[pingLines.length - 1])['result']).toBe('pong');
  });
});

// ---------------------------------------------------------------------------
// sendResponse unit test (lighter setup — no createProtocolPair needed)
// ---------------------------------------------------------------------------

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
