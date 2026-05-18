/**
 * Tests for `think daemon start|stop|status` — AGT-284
 *
 * Strategy: run the command actions in-process against real implementations.
 * - `isDaemonRunning()` is exercised via real PID file writes in a temp dir.
 * - The network layer uses `startMockDaemon`, an in-process net.Server that
 *   speaks the JSON-line RPC protocol, so tests exercise the real socket path
 *   without spawning an external process.
 * - `vi.resetModules()` + THINK_HOME override isolates each test from module
 *   caches and from the host's own daemon state.
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
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { Command } from 'commander';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpThinkHome(): string {
  return mkdtempSync(join(tmpdir(), 'think-daemon-cmd-test-'));
}

/**
 * Start a minimal JSON-line server on `socketPath` that handles `method` calls.
 * `handlers` maps method names to fixed response values or handler functions.
 */
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
          const handler = handlers[method];
          let result: unknown;
          if (typeof handler === 'function') {
            result = (handler as (p: Record<string, unknown>) => unknown)(
              (req['params'] ?? {}) as Record<string, unknown>,
            );
          } else if (handler !== undefined) {
            result = handler;
          } else {
            const errResp = JSON.stringify({
              request_id: req['request_id'],
              error: { code: 'METHOD_NOT_FOUND', message: `unknown method: ${method}` },
            });
            socket.write(errResp + '\n');
            continue;
          }
          socket.write(
            JSON.stringify({ request_id: req['request_id'], result }) + '\n',
          );
        }
      });
      socket.on('error', () => { /* ignore */ });
    });

    server.listen(socketPath, () => resolve({
      close: () =>
        new Promise<void>((res) => {
          for (const s of sockets) try { s.destroy(); } catch { /* */ }
          server.close(() => res());
        }),
    }));

    server.once('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Commander wrapper — daemonCommand is a sub-command group; it must be
// mounted under a root program so parseAsync(['node','think','daemon','start'])
// correctly routes to the 'start' sub-command rather than looking for a
// non-existent 'daemon' sub-command inside the group itself.
// ---------------------------------------------------------------------------

async function makeProg() {
  const { daemonCommand } = await import('../../src/commands/daemon.js');
  const prog = new Command();
  prog.exitOverride(); // prevent Commander from calling process.exit on parse errors
  prog.addCommand(daemonCommand);
  return prog;
}

// ---------------------------------------------------------------------------
// Shared test setup — extracted to avoid copy-pasting across three suites.
// ---------------------------------------------------------------------------

function useThinkHome() {
  let thinkHome = '';
  let originalThinkHome: string | undefined;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalThinkHome = process.env.THINK_HOME;
    thinkHome = tmpThinkHome();
    process.env.THINK_HOME = thinkHome;
    vi.resetModules();

    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    exitSpy   = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    if (originalThinkHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalThinkHome;
    rmSync(thinkHome, { recursive: true, force: true });
  });

  return {
    getThinkHome: () => thinkHome,
    getStdout: () => stdoutSpy.mock.calls.map(([m]) => String(m)).join(''),
    getStderr: () => stderrSpy.mock.calls.map(([m]) => String(m)).join(''),
    getExitSpy: () => exitSpy,
  };
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === 'win32')('think daemon start', () => {
  const { getThinkHome, getStdout, getExitSpy } = useThinkHome();

  it('prints "daemon already running" and exits 0 when daemon is running', async () => {
    // Write our own PID into the PID file — isDaemonRunning() will see running=true.
    writeFileSync(join(getThinkHome(), 'daemon.pid'), String(process.pid) + '\n');

    // Import command module after THINK_HOME is set and wrap in root program.
    const prog = await makeProg();

    // Parse + execute `daemon start`.
    await prog.parseAsync(['node', 'think', 'daemon', 'start']);

    expect(getStdout()).toMatch(/status=already-running/);
    expect(getStdout()).toMatch(/pid=\d+/);
    // process.exit should NOT have been called (success path).
    expect(getExitSpy()).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform === 'win32')('think daemon stop', () => {
  const { getThinkHome, getStdout, getStderr, getExitSpy } = useThinkHome();

  it('exits 0 with "daemon not running (no-op)" when daemon is not running', async () => {
    // No PID file → isDaemonRunning returns { running: false }.
    // stop mirrors start's idempotent contract: already-in-desired-state → exit 0.
    const prog = await makeProg();
    await prog.parseAsync(['node', 'think', 'daemon', 'stop']);

    expect(getStdout()).toMatch(/status=not-running/);
    expect(getExitSpy()).not.toHaveBeenCalledWith(1);
  });

  it('sends shutdown RPC and prints "daemon stopped" within 5s', async () => {
    const thinkHome = getThinkHome();

    // Start a mock daemon server.
    const socketPath = join(thinkHome, 'daemon.sock');
    let shutdownCalled = false;
    const mock = await startMockDaemon(socketPath, {
      shutdown: () => {
        shutdownCalled = true;
        return 'shutting_down';
      },
    });

    try {
      // Write PID file so isDaemonRunning() returns running.
      writeFileSync(join(thinkHome, 'daemon.pid'), String(process.pid) + '\n');

      const prog = await makeProg();

      // After calling stop, the command will poll isDaemonRunning until the
      // PID file goes away. We remove the PID file after shutdown is called to
      // simulate the daemon exiting.
      let removed = false;
      const pidCleanupInterval = setInterval(() => {
        if (shutdownCalled && !removed) {
          removed = true;
          try {
            unlinkSync(join(thinkHome, 'daemon.pid'));
          } catch { /* already gone */ }
        }
      }, 50);

      await prog.parseAsync(['node', 'think', 'daemon', 'stop']);
      clearInterval(pidCleanupInterval);

      expect(shutdownCalled).toBe(true);
      expect(getStdout()).toMatch(/status=stopped/);
      expect(getExitSpy()).not.toHaveBeenCalledWith(1);
    } finally {
      await mock.close();
    }
  }, 15_000);
});

describe.skipIf(process.platform === 'win32')('think daemon status', () => {
  const { getThinkHome, getStdout, getStderr, getExitSpy } = useThinkHome();

  it('prints "daemon is not running" and exits 1 when no PID file', async () => {
    const prog = await makeProg();
    await prog.parseAsync(['node', 'think', 'daemon', 'status']);

    expect(getStderr()).toMatch(/error: daemon is not running — run 'think daemon start'/);
    expect(getExitSpy()).toHaveBeenCalledWith(1);
  });

  it('prints pid and socket when running and status RPC returns data', async () => {
    const thinkHome = getThinkHome();
    const socketPath = join(thinkHome, 'daemon.sock');
    const mock = await startMockDaemon(socketPath, {
      status: { uptime_ms: 12345, version: '0.7.0' },
    });

    try {
      writeFileSync(join(thinkHome, 'daemon.pid'), String(process.pid) + '\n');

      const prog = await makeProg();
      await prog.parseAsync(['node', 'think', 'daemon', 'status']);

      const stdout = getStdout();
      expect(stdout).toMatch(/pid=\d+/);
      expect(stdout).toMatch(/socket=/);
      expect(stdout).toMatch(/uptime=12s/);
      expect(stdout).toMatch(/version=0.7.0/);
      expect(getExitSpy()).not.toHaveBeenCalledWith(1);
    } finally {
      await mock.close();
    }
  }, 15_000);

  it('degrades gracefully when status RPC is not available (METHOD_NOT_FOUND)', async () => {
    const thinkHome = getThinkHome();
    const socketPath = join(thinkHome, 'daemon.sock');
    // No 'status' handler → server returns METHOD_NOT_FOUND.
    const mock = await startMockDaemon(socketPath, {});

    try {
      writeFileSync(join(thinkHome, 'daemon.pid'), String(process.pid) + '\n');

      const prog = await makeProg();
      await prog.parseAsync(['node', 'think', 'daemon', 'status']);

      const stdout = getStdout();
      expect(stdout).toMatch(/pid=\d+/);
      expect(stdout).toMatch(/socket=/);
      expect(stdout).toMatch(/status=running/);
      expect(stdout).toMatch(/rpc=unavailable/);
      expect(stdout).toMatch(/rpc_detail=no status endpoint/);
      expect(getExitSpy()).not.toHaveBeenCalledWith(1);
    } finally {
      await mock.close();
    }
  }, 15_000);
});
