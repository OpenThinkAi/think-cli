/**
 * Tests for the daemon `status` endpoint — AGT-287.
 *
 * Uses real in-process socket pairs backed by a tmp dir so ~/.think is
 * never touched. Protocol harness reuses helpers established in protocol.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLineFraming, dispatchRequest } from '../../src/daemon/protocol.js';
import { handleStatus, type DaemonStatusResult, type CortexStatusEntry } from '../../src/daemon/status.js';
import { EMBEDDING_MODEL_NAME } from '../../src/lib/embed.js';

// ---------------------------------------------------------------------------
// Minimal socket-pair helpers (lifted from protocol.test.ts pattern)
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'think-status-test-'));
}

type MethodHandler = (params: Record<string, unknown>) => Promise<unknown> | unknown;

async function createStatusProtocolPair(
  socketPath: string,
  extraMethods: Map<string, MethodHandler> = new Map(),
): Promise<{ client: net.Socket; server: net.Server; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((serverSocket) => {
      (async () => {
        for await (const request of parseLineFraming(serverSocket)) {
          await dispatchRequest(serverSocket, request, extraMethods);
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

function parseLine(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

function matchesId(id: string): (line: string) => boolean {
  return (line) => {
    try { return parseLine(line)['request_id'] === id; } catch { return false; }
  };
}

// ---------------------------------------------------------------------------
// Unit tests — handleStatus() directly (no socket overhead)
// ---------------------------------------------------------------------------

describe('handleStatus — unit', () => {
  it('returns required top-level fields', () => {
    const result = handleStatus({}) as DaemonStatusResult;

    expect(typeof result.version).toBe('string');
    expect(result.version.length).toBeGreaterThan(0);

    expect(result.pid).toBe(process.pid);

    expect(typeof result.uptime_seconds).toBe('number');
    expect(result.uptime_seconds).toBeGreaterThanOrEqual(0);

    expect(result.embedding_model).toBe(EMBEDDING_MODEL_NAME);

    expect(['brute-force', 'sqlite-vec']).toContain(result.search_engine);

    expect(typeof result.cortexes).toBe('object');
    expect(result.cortexes).not.toBeNull();
  });

  it('uptime_seconds increases on successive calls', async () => {
    const first = (handleStatus({}) as DaemonStatusResult).uptime_seconds;
    // Wait 1100ms so Math.floor(ms/1000) is guaranteed to tick at least once.
    await new Promise((r) => setTimeout(r, 1100));
    const second = (handleStatus({}) as DaemonStatusResult).uptime_seconds;
    expect(second).toBeGreaterThan(first);
  }, 5000);

  it('cortex param validation — invalid name throws', () => {
    expect(() => handleStatus({ cortex: '../../etc/passwd' })).toThrow(
      /invalid cortex name/i,
    );
  });

  it('cortex param validation — name too long throws', () => {
    expect(() => handleStatus({ cortex: 'a'.repeat(256) })).toThrow(
      /"cortex" name too long/i,
    );
  });

  it('cortex param validation — non-string throws', () => {
    expect(() => handleStatus({ cortex: 42 })).toThrow(
      /"cortex" param must be a string/i,
    );
  });

  it('cortex param omitted — cortexes is an object (no crash even with no configured cortex)', () => {
    const result = handleStatus({}) as DaemonStatusResult;
    expect(typeof result.cortexes).toBe('object');
  });

  it('cortex param empty string — treated as omitted (no crash)', () => {
    const result = handleStatus({ cortex: '' }) as DaemonStatusResult;
    expect(typeof result.cortexes).toBe('object');
  });

  it('per-cortex entry shape is valid even when the cortex DB is absent', () => {
    // We cannot guarantee a cortex DB is present in CI, so we verify the
    // graceful-degradation path: the handler must not throw even if
    // getMemoryCount fails; errors land in warnings, not throws.
    const result = handleStatus({ cortex: 'nonexistent-ci-cortex' }) as DaemonStatusResult;
    expect(result.cortexes).toHaveProperty('nonexistent-ci-cortex');
    const entry = result.cortexes['nonexistent-ci-cortex'] as CortexStatusEntry;

    expect(typeof entry.entries).toBe('number');
    expect(entry.entries).toBeGreaterThanOrEqual(0);
    expect(entry.compaction_queue_depth).toBe(0);
    expect(entry.supersession_queue_depth).toBe(0);
    expect(Array.isArray(entry.warnings)).toBe(true);
    // last_sync_pull and last_sync_push may be null or a warning may have fired
    expect(entry.last_sync_pull === null || typeof entry.last_sync_pull === 'string').toBe(true);
    expect(entry.last_sync_push === null || typeof entry.last_sync_push === 'string').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — status method via real socket + protocol dispatch
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === 'win32')('status method — protocol integration', () => {
  let dir: string;
  let socketPath: string;
  let pair: Awaited<ReturnType<typeof createStatusProtocolPair>>;

  beforeEach(async () => {
    dir = tmpDir();
    socketPath = join(dir, 'test.sock');
    const statusMethods = new Map<string, MethodHandler>([
      ['status', handleStatus],
    ]);
    pair = await createStatusProtocolPair(socketPath, statusMethods);
  });

  afterEach(async () => {
    await pair.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('status request returns result with correct shape', async () => {
    const id = 'status-shape-001';
    const lines = await sendAndCollect(
      pair.client,
      JSON.stringify({ request_id: id, method: 'status', params: {} }),
      matchesId(id),
    );

    const response = parseLine(lines[lines.length - 1]);
    expect(response['request_id']).toBe(id);
    expect(response).not.toHaveProperty('error');

    const result = response['result'] as DaemonStatusResult;
    expect(typeof result.version).toBe('string');
    expect(result.pid).toBe(process.pid);
    expect(typeof result.uptime_seconds).toBe('number');
    expect(result.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(result.embedding_model).toBe(EMBEDDING_MODEL_NAME);
    expect(['brute-force', 'sqlite-vec']).toContain(result.search_engine);
    expect(typeof result.cortexes).toBe('object');
  });

  it('uptime_seconds increases between successive status calls', async () => {
    const id1 = 'status-uptime-001';
    const lines1 = await sendAndCollect(
      pair.client,
      JSON.stringify({ request_id: id1, method: 'status', params: {} }),
      matchesId(id1),
    );
    const result1 = (parseLine(lines1[lines1.length - 1])['result'] as DaemonStatusResult);

    // Wait > 1s so floor(ms/1000) has a chance to tick.
    await new Promise((r) => setTimeout(r, 1100));

    const id2 = 'status-uptime-002';
    const lines2 = await sendAndCollect(
      pair.client,
      JSON.stringify({ request_id: id2, method: 'status', params: {} }),
      matchesId(id2),
    );
    const result2 = (parseLine(lines2[lines2.length - 1])['result'] as DaemonStatusResult);

    expect(result2.uptime_seconds).toBeGreaterThan(result1.uptime_seconds);
  }, 10000);

  it('invalid cortex name returns error (not a crash)', async () => {
    // The protocol dispatcher maps all thrown errors to `internal_error` —
    // this is a pre-existing protocol limitation (not introduced here).
    // The handler throws for invalid input; the wire code is `internal_error`
    // because the protocol has no `invalid_params` code yet.
    const id = 'status-bad-cortex-001';
    const lines = await sendAndCollect(
      pair.client,
      JSON.stringify({ request_id: id, method: 'status', params: { cortex: '../etc/passwd' } }),
      matchesId(id),
    );

    const response = parseLine(lines[lines.length - 1]);
    expect(response['request_id']).toBe(id);
    expect(response).toHaveProperty('error');
    expect((response['error'] as { code?: string })['code']).toBe('internal_error');
  });
});
