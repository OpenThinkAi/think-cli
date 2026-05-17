/**
 * Tests for AGT-283 — graceful daemon shutdown with drain.
 *
 * Tests in this file are POSIX-only (skipped on Windows).
 * They use a tmp THINK_HOME so they never touch ~/.think.
 *
 * Strategy: run `runDaemon` in-process with `process.exit` mocked
 * so the test process survives, then verify that the socket file and
 * PID file are both removed within the expected timeframe.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpThinkHome(): string {
  return mkdtempSync(join(tmpdir(), 'think-shutdown-test-'));
}

/**
 * Wait until `fn()` returns true, polling every `pollMs`, up to `timeoutMs`.
 * Resolves true if the condition was met, false if timed out.
 */
async function waitUntil(
  fn: () => boolean,
  timeoutMs: number,
  pollMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise<void>((r) => setTimeout(r, pollMs));
  }
  return fn(); // last check
}

/**
 * Connect to `socketPath`, send one JSON-line request, and return the raw
 * response line as a parsed object. Rejects on error or timeout.
 */
function sendRequest(
  socketPath: string,
  method: string,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let buf = '';

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`sendRequest: timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.on('connect', () => {
      socket.write(
        JSON.stringify({ request_id: 'test-req', method, params: {} }) + '\n',
      );
    });

    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        clearTimeout(timer);
        socket.destroy();
        try {
          resolve(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>);
        } catch (err) {
          reject(err);
        }
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Shared test scaffold
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === 'win32')(
  'Graceful shutdown — shutdown RPC',
  () => {
    let thinkHome: string;
    let originalThinkHome: string | undefined;
    let exitSpy: ReturnType<typeof vi.spyOn>;
    let stderrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      originalThinkHome = process.env.THINK_HOME;
      thinkHome = tmpThinkHome();
      process.env.THINK_HOME = thinkHome;
      vi.resetModules();

      // Intercept process.exit so the test process doesn't die.
      exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
        // intentional no-op
      }) as () => never);
    });

    afterEach(() => {
      exitSpy.mockRestore();
      stderrSpy?.mockRestore();
      if (originalThinkHome === undefined) delete process.env.THINK_HOME;
      else process.env.THINK_HOME = originalThinkHome;
      rmSync(thinkHome, { recursive: true, force: true });
    });

    it('shutdown RPC causes daemon to exit; socket + PID files removed', async () => {
      const { runDaemon } = await import('../../src/daemon/index.js');
      const socketPath = join(thinkHome, 'daemon.sock');
      const pidPath = join(thinkHome, 'daemon.pid');

      // Write a fake PID file path into THINK_HOME so daemon uses our tmpdir.
      // (getDaemonPidPath resolves off THINK_HOME via getThinkDir)

      // Wait for daemon ready.
      let resolveReady!: () => void;
      const ready = new Promise<void>((r) => { resolveReady = r; });

      const origWrite = process.stderr.write.bind(process.stderr);
      stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        if (String(chunk).includes('think daemon ready')) resolveReady();
        return origWrite(chunk);
      });

      const daemonPromise = runDaemon({ socketPath, foreground: true });

      await ready;

      // Verify both files exist before shutdown.
      expect(existsSync(socketPath)).toBe(true);
      expect(existsSync(pidPath)).toBe(true);

      // Send the shutdown RPC.
      const response = await sendRequest(socketPath, 'shutdown', 3000);
      expect(response['result']).toBe('shutting_down');

      // Daemon should clean up within 6 s (AC#5).
      const socketGone = await waitUntil(() => !existsSync(socketPath), 6000);
      const pidGone    = await waitUntil(() => !existsSync(pidPath),    6000);

      expect(socketGone).toBe(true);
      expect(pidGone).toBe(true);

      // process.exit(0) should have been called.
      expect(exitSpy).toHaveBeenCalledWith(0);

      stderrSpy.mockRestore();
      await daemonPromise.catch(() => {});
    }, 15_000);
  },
);

// ---------------------------------------------------------------------------
// SIGTERM shutdown
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === 'win32')(
  'Graceful shutdown — SIGTERM',
  () => {
    let thinkHome: string;
    let originalThinkHome: string | undefined;
    let exitSpy: ReturnType<typeof vi.spyOn>;
    let stderrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      originalThinkHome = process.env.THINK_HOME;
      thinkHome = tmpThinkHome();
      process.env.THINK_HOME = thinkHome;
      vi.resetModules();

      exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
    });

    afterEach(() => {
      exitSpy.mockRestore();
      stderrSpy?.mockRestore();
      if (originalThinkHome === undefined) delete process.env.THINK_HOME;
      else process.env.THINK_HOME = originalThinkHome;
      rmSync(thinkHome, { recursive: true, force: true });
    });

    it('SIGTERM causes daemon to exit; socket + PID files removed', async () => {
      const { runDaemon } = await import('../../src/daemon/index.js');
      const socketPath = join(thinkHome, 'daemon.sock');
      const pidPath = join(thinkHome, 'daemon.pid');

      let resolveReady!: () => void;
      const ready = new Promise<void>((r) => { resolveReady = r; });

      const origWrite = process.stderr.write.bind(process.stderr);
      stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        if (String(chunk).includes('think daemon ready')) resolveReady();
        return origWrite(chunk);
      });

      const daemonPromise = runDaemon({ socketPath, foreground: true });

      await ready;

      expect(existsSync(socketPath)).toBe(true);
      expect(existsSync(pidPath)).toBe(true);

      // Send SIGTERM to the current process (daemon signal handlers are installed).
      process.emit('SIGTERM');

      // Verify cleanup within 6 s (AC#6).
      const socketGone = await waitUntil(() => !existsSync(socketPath), 6000);
      const pidGone    = await waitUntil(() => !existsSync(pidPath),    6000);

      expect(socketGone).toBe(true);
      expect(pidGone).toBe(true);

      expect(exitSpy).toHaveBeenCalledWith(0);

      stderrSpy.mockRestore();
      await daemonPromise.catch(() => {});
    }, 15_000);
  },
);

// ---------------------------------------------------------------------------
// process.on('exit') last-ditch cleanup
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === 'win32')(
  'Graceful shutdown — last-ditch exit cleanup',
  () => {
    let thinkHome: string;
    let originalThinkHome: string | undefined;
    let exitSpy: ReturnType<typeof vi.spyOn>;
    let stderrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      originalThinkHome = process.env.THINK_HOME;
      thinkHome = tmpThinkHome();
      process.env.THINK_HOME = thinkHome;
      vi.resetModules();

      exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
    });

    afterEach(() => {
      exitSpy.mockRestore();
      stderrSpy?.mockRestore();
      if (originalThinkHome === undefined) delete process.env.THINK_HOME;
      else process.env.THINK_HOME = originalThinkHome;
      rmSync(thinkHome, { recursive: true, force: true });
    });

    it('process "exit" event triggers last-ditch unlink of socket + PID files', async () => {
      const { runDaemon } = await import('../../src/daemon/index.js');
      const socketPath = join(thinkHome, 'daemon.sock');
      const pidPath = join(thinkHome, 'daemon.pid');

      let resolveReady!: () => void;
      const ready = new Promise<void>((r) => { resolveReady = r; });

      const origWrite = process.stderr.write.bind(process.stderr);
      stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        if (String(chunk).includes('think daemon ready')) resolveReady();
        return origWrite(chunk);
      });

      const daemonPromise = runDaemon({ socketPath, foreground: true });
      await ready;

      // Both files should exist before the exit event.
      expect(existsSync(socketPath)).toBe(true);
      expect(existsSync(pidPath)).toBe(true);

      // Emit the 'exit' event directly — simulates the process ending without
      // going through the full shutdown sequence.
      process.emit('exit', 0);

      // Files should be gone (synchronous cleanup in the exit handler).
      expect(existsSync(socketPath)).toBe(false);
      expect(existsSync(pidPath)).toBe(false);

      // Clean up the server by triggering SIGINT.
      process.emit('SIGINT');
      await new Promise<void>((r) => setTimeout(r, 100));

      stderrSpy.mockRestore();
      await daemonPromise.catch(() => {});
    }, 15_000);
  },
);
