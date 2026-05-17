/**
 * Tests for connectDaemon() — AGT-282
 *
 * These tests use a real in-process net.Server to stand in for the daemon,
 * exercising the full connect/retry/RPC path without spawning a real daemon.
 *
 * Spawn injection: connectDaemon accepts a `_spawnOverride` option so tests
 * can start an in-process echo server instead of forking a real child process.
 * This sidesteps the ESM vi.spyOn restriction on node:child_process.
 *
 * POSIX-only (Unix socket path). Windows (TCP) is skipped.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from 'vitest';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpThinkHome(): string {
  return mkdtempSync(join(tmpdir(), 'think-client-test-'));
}

/**
 * Spin up a minimal JSON-line echo server on `socketPath`.
 * For every valid request it returns `{ request_id, result: { echo: method } }`.
 */
function startEchoServer(socketPath: string): Promise<{
  close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const sockets: net.Socket[] = [];
    const server = net.createServer((socket) => {
      sockets.push(socket);
      let buf = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const req = JSON.parse(line) as Record<string, unknown>;
            const rid = req['request_id'] ?? '';
            const method = req['method'] ?? '';
            socket.write(
              JSON.stringify({ request_id: rid, result: { echo: method } }) + '\n',
            );
          } catch {
            // Ignore malformed lines in this test server.
          }
        }
      });
      socket.on('error', () => { /* swallow for clean test teardown */ });
    });

    server.once('error', reject);
    server.listen(socketPath, () => {
      resolve({
        close: () =>
          new Promise<void>((res) => {
            // Destroy all active sockets first so server.close() resolves promptly.
            for (const s of sockets) s.destroy();
            server.close(() => res());
          }),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Tests: connect to an already-running daemon
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === 'win32')(
  'connectDaemon — connect to an already-running daemon',
  () => {
    let thinkHome: string;
    let originalThinkHome: string | undefined;
    let echoServer: { close: () => Promise<void> } | null = null;

    beforeEach(async () => {
      originalThinkHome = process.env.THINK_HOME;
      thinkHome = tmpThinkHome();
      process.env.THINK_HOME = thinkHome;
    });

    afterEach(async () => {
      if (echoServer) {
        await echoServer.close().catch(() => {});
        echoServer = null;
      }
      if (originalThinkHome === undefined) delete process.env.THINK_HOME;
      else process.env.THINK_HOME = originalThinkHome;
      rmSync(thinkHome, { recursive: true, force: true });
    });

    it('connects and issues an RPC call to an already-running echo server', async () => {
      const socketPath = join(thinkHome, 'daemon.sock');
      echoServer = await startEchoServer(socketPath);

      const { connectDaemon } = await import('../../src/lib/daemon-client.js');
      const client = await connectDaemon();

      try {
        const result = await client.call('ping', {});
        expect(result).toMatchObject({ echo: 'ping' });
      } finally {
        client.close();
      }
    }, 10_000);

    it('multiplexes concurrent RPC calls over one connection', async () => {
      const socketPath = join(thinkHome, 'daemon.sock');
      echoServer = await startEchoServer(socketPath);

      const { connectDaemon } = await import('../../src/lib/daemon-client.js');
      const client = await connectDaemon();

      try {
        const results = await Promise.all([
          client.call('recall', { query: 'foo' }),
          client.call('sync', { content: 'bar' }),
          client.call('status', {}),
        ]);

        expect(results[0]).toMatchObject({ echo: 'recall' });
        expect(results[1]).toMatchObject({ echo: 'sync' });
        expect(results[2]).toMatchObject({ echo: 'status' });
      } finally {
        client.close();
      }
    }, 10_000);

    it('rejects with a timeout error when the server never responds', async () => {
      const socketPath = join(thinkHome, 'daemon.sock');
      const activeSockets: net.Socket[] = [];

      // Server that accepts connections but never sends responses.
      const silentServer = await new Promise<net.Server>((resolve, reject) => {
        const server = net.createServer((socket) => {
          activeSockets.push(socket);
          socket.on('error', () => {});
        });
        server.once('error', reject);
        server.listen(socketPath, () => resolve(server));
      });

      const { connectDaemon } = await import('../../src/lib/daemon-client.js');
      const client = await connectDaemon();

      try {
        await expect(
          client.call('ping', {}, 200 /* ms — short timeout for test speed */),
        ).rejects.toThrow(/timed out/);
      } finally {
        client.close();
        // Destroy active sockets then close the server.
        for (const s of activeSockets) s.destroy();
        await new Promise<void>((res) => silentServer.close(() => res()));
      }
    }, 10_000);
  },
);

// ---------------------------------------------------------------------------
// Tests: spawn-or-connect path
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === 'win32')(
  'connectDaemon — spawn-or-connect path',
  () => {
    let thinkHome: string;
    let originalThinkHome: string | undefined;
    let echoServer: { close: () => Promise<void> } | null = null;

    beforeEach(() => {
      originalThinkHome = process.env.THINK_HOME;
      thinkHome = tmpThinkHome();
      process.env.THINK_HOME = thinkHome;
    });

    afterEach(async () => {
      if (echoServer) {
        await echoServer.close().catch(() => {});
        echoServer = null;
      }
      if (originalThinkHome === undefined) delete process.env.THINK_HOME;
      else process.env.THINK_HOME = originalThinkHome;
      rmSync(thinkHome, { recursive: true, force: true });
    });

    it('retries after spawn and connects once the server becomes available', async () => {
      const socketPath = join(thinkHome, 'daemon.sock');
      const { connectDaemon } = await import('../../src/lib/daemon-client.js');

      // _spawnOverride starts the echo server after 150ms, simulating a daemon
      // that needs a moment to bind its socket.
      const spawnOverride = (): void => {
        setTimeout(async () => {
          echoServer = await startEchoServer(socketPath).catch(() => null) as typeof echoServer;
        }, 150);
      };

      const client = await connectDaemon({ _spawnOverride: spawnOverride });
      try {
        const result = await client.call('ping', {});
        expect(result).toMatchObject({ echo: 'ping' });
      } finally {
        client.close();
      }
    }, 10_000);

    it('throws the "daemon failed to start" error when no server ever comes up', async () => {
      const { connectDaemon } = await import('../../src/lib/daemon-client.js');

      // _spawnOverride does nothing — no server ever binds.
      await expect(
        connectDaemon({ _spawnOverride: () => {} }),
      ).rejects.toThrow(/daemon failed to start/);
    }, 10_000);
  },
);
