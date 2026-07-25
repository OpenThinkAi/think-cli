/**
 * Tests for the daemon/CLI version-drift helpers (#91) — lib/daemon-drift.ts.
 *
 * Strategy mirrors tests/commands/daemon-command.test.ts:
 * - `inspectDaemon` is exercised against a real Unix-socket mock daemon in a
 *   THINK_HOME temp dir (probe + status RPC paths, no process spawning).
 * - `needsDaemonRestart` is a pure decision matrix — tested directly.
 * - `restartDaemonViaBin` uses the exec seam; no processes are spawned.
 *
 * POSIX-only (Unix socket paths). Windows skipped.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

// ---------------------------------------------------------------------------
// Mock daemon (same JSON-line protocol as tests/commands/daemon-command.test.ts)
// ---------------------------------------------------------------------------

function startMockDaemon(
  socketPath: string,
  handlers: Record<string, unknown>,
): Promise<{ close: () => Promise<void> }> {
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
          let req: Record<string, unknown>;
          try { req = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
          const method = String(req['method']);
          const requestId = req['request_id'];
          if (method in handlers) {
            const h = handlers[method];
            const result = typeof h === 'function' ? (h as () => unknown)() : h;
            socket.write(JSON.stringify({ request_id: requestId, result }) + '\n');
          } else {
            socket.write(JSON.stringify({
              request_id: requestId,
              error: { code: 'METHOD_NOT_FOUND', message: `no such method: ${method}` },
            }) + '\n');
          }
        }
      });
      socket.on('error', () => { /* client hangup — ignore */ });
    });
    server.on('error', reject);
    server.listen(socketPath, () => {
      resolve({
        close: () => new Promise<void>((res) => {
          for (const s of sockets) s.destroy();
          server.close(() => res());
        }),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// THINK_HOME isolation
// ---------------------------------------------------------------------------

let thinkHome = '';
let originalThinkHome: string | undefined;

beforeEach(() => {
  originalThinkHome = process.env.THINK_HOME;
  thinkHome = mkdtempSync(join(tmpdir(), 'think-daemon-drift-test-'));
  process.env.THINK_HOME = thinkHome;
  vi.resetModules();
});

afterEach(() => {
  if (originalThinkHome === undefined) delete process.env.THINK_HOME;
  else process.env.THINK_HOME = originalThinkHome;
  rmSync(thinkHome, { recursive: true, force: true });
});

async function importDrift() {
  return import('../../src/lib/daemon-drift.js');
}

// ---------------------------------------------------------------------------
// inspectDaemon
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === 'win32')('inspectDaemon', () => {
  it('reports unreachable when no daemon answers the socket', async () => {
    const { inspectDaemon } = await importDrift();
    const result = await inspectDaemon();
    expect(result).toEqual({ reachable: false, version: null });
  });

  it('reports the version from the status RPC when the daemon answers', async () => {
    const socketPath = join(thinkHome, 'daemon.sock');
    const mock = await startMockDaemon(socketPath, {
      status: { uptime_ms: 1000, version: '2.4.1' },
    });
    try {
      // PID file so connectDaemon's pre-spawn checks see a live daemon.
      writeFileSync(join(thinkHome, 'daemon.pid'), String(process.pid) + '\n');
      const { inspectDaemon } = await importDrift();
      const result = await inspectDaemon();
      expect(result).toEqual({ reachable: true, version: '2.4.1' });
    } finally {
      await mock.close();
    }
  }, 15_000);

  it('reports reachable with null version when the status RPC is missing (old daemon)', async () => {
    const socketPath = join(thinkHome, 'daemon.sock');
    const mock = await startMockDaemon(socketPath, {}); // no status handler
    try {
      writeFileSync(join(thinkHome, 'daemon.pid'), String(process.pid) + '\n');
      const { inspectDaemon } = await importDrift();
      const result = await inspectDaemon();
      expect(result).toEqual({ reachable: true, version: null });
    } finally {
      await mock.close();
    }
  }, 15_000);

  it('sanitizes newlines out of the reported version', async () => {
    const socketPath = join(thinkHome, 'daemon.sock');
    const mock = await startMockDaemon(socketPath, {
      status: { version: '2.4.1\ninjected=true' },
    });
    try {
      writeFileSync(join(thinkHome, 'daemon.pid'), String(process.pid) + '\n');
      const { inspectDaemon } = await importDrift();
      const result = await inspectDaemon();
      expect(result.version).toBe('2.4.1');
    } finally {
      await mock.close();
    }
  }, 15_000);
});

// ---------------------------------------------------------------------------
// needsDaemonRestart — pure decision matrix
// ---------------------------------------------------------------------------

describe('needsDaemonRestart', () => {
  it('is false when no daemon is reachable', async () => {
    const { needsDaemonRestart } = await importDrift();
    expect(needsDaemonRestart({ reachable: false, version: null }, '2.5.0')).toBe(false);
  });

  it('is false when the installed version is unknown', async () => {
    const { needsDaemonRestart } = await importDrift();
    expect(needsDaemonRestart({ reachable: true, version: '2.4.1' }, null)).toBe(false);
  });

  it('is false when the daemon already serves the installed version', async () => {
    const { needsDaemonRestart } = await importDrift();
    expect(needsDaemonRestart({ reachable: true, version: '2.5.0' }, '2.5.0')).toBe(false);
  });

  it('is true when the daemon serves a different version', async () => {
    const { needsDaemonRestart } = await importDrift();
    expect(needsDaemonRestart({ reachable: true, version: '2.4.1' }, '2.5.0')).toBe(true);
  });

  it('is true when the daemon version is unknown (predates the status RPC)', async () => {
    const { needsDaemonRestart } = await importDrift();
    expect(needsDaemonRestart({ reachable: true, version: null }, '2.5.0')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// restartDaemonViaBin — exec seam
// ---------------------------------------------------------------------------

describe('restartDaemonViaBin', () => {
  it('runs stop then start against the installed entry point', async () => {
    const { restartDaemonViaBin } = await importDrift();
    const calls: Array<{ file: string; args: string[] }> = [];
    const result = restartDaemonViaBin('/npm/root/@openthink/think', (file, args) => {
      calls.push({ file, args });
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    // Both invocations must target the ON-DISK entry point (the freshly
    // installed code), not anything imported into the calling process.
    const bin = join('/npm/root/@openthink/think', 'dist', 'index.js');
    expect(calls[0]).toEqual({ file: process.execPath, args: [bin, 'daemon', 'stop'] });
    expect(calls[1]).toEqual({ file: process.execPath, args: [bin, 'daemon', 'start'] });
  });

  it('reports failure (with detail) when a step throws, and does not continue past a failed stop', async () => {
    const { restartDaemonViaBin } = await importDrift();
    const calls: string[] = [];
    const result = restartDaemonViaBin('/npm/root/@openthink/think', (_file, args) => {
      calls.push(args[args.length - 1] ?? '');
      throw new Error('shutdown RPC failed');
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('shutdown RPC failed');
    expect(calls).toEqual(['stop']); // start never attempted after stop failed
  });
});
