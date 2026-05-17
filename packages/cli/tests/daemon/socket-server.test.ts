/**
 * Tests for the AGT-279 Unix socket server in the daemon entry point.
 *
 * These tests are POSIX-only (skipped on Windows) except where noted.
 * They use a tmp THINK_HOME so they never touch ~/.think.
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
  statSync,
  existsSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpThinkHome(): string {
  return mkdtempSync(join(tmpdir(), 'think-daemon-test-'));
}

/**
 * Spawn a real net.Server on `socketPath` that stays open until `close()` is
 * called. Returns a handle with a `close()` method.
 */
function spawnLiveServer(socketPath: string): Promise<{ close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(socketPath, () => {
      resolve({
        close: () =>
          new Promise<void>((res, rej) =>
            server.close((err) => (err ? rej(err) : res())),
          ),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Socket existence + permissions (POSIX only)
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === 'win32')(
  'Unix socket server — bind and permissions',
  () => {
    let thinkHome: string;
    let originalThinkHome: string | undefined;

    beforeEach(() => {
      originalThinkHome = process.env.THINK_HOME;
      thinkHome = tmpThinkHome();
      process.env.THINK_HOME = thinkHome;
      // Reset modules so each test gets a fresh config/paths state.
      vi.resetModules();
    });

    afterEach(() => {
      if (originalThinkHome === undefined) delete process.env.THINK_HOME;
      else process.env.THINK_HOME = originalThinkHome;
      rmSync(thinkHome, { recursive: true, force: true });
    });

    it('creates a socket file and sets 0600 permissions', async () => {
      const { runDaemon } = await import('../../src/daemon/index.js');
      const socketPath = join(thinkHome, 'daemon.sock');

      // We'll stop the daemon immediately after it's ready by sending SIGINT.
      // Since the daemon blocks on the event loop, we start it and then send
      // the signal from a timer. We wrap in a race with a timeout guard.
      let resolveReady: () => void;
      const ready = new Promise<void>((r) => { resolveReady = r; });

      // Intercept writeLine output to detect "daemon ready".
      const origWrite = process.stderr.write.bind(process.stderr);
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        if (String(chunk).includes('think daemon ready')) resolveReady();
        return origWrite(chunk);
      });

      // Intercept process.exit so the test process doesn't actually die.
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
        // no-op
      }) as () => never);

      const daemonPromise = runDaemon({
        socketPath,
        foreground: true,
      });

      // Wait for "ready" line, then verify socket + perms.
      await ready;

      expect(existsSync(socketPath)).toBe(true);
      const mode = statSync(socketPath).mode & 0o777;
      expect(mode).toBe(0o600);

      // Trigger shutdown.
      process.emit('SIGINT');

      // Give it a tick to close.
      await new Promise((r) => setTimeout(r, 50));

      stderrSpy.mockRestore();
      exitSpy.mockRestore();
      await daemonPromise.catch(() => { /* shutdown exits */ });
    }, 10_000);
  },
);

// ---------------------------------------------------------------------------
// EADDRINUSE: stale socket → unlink + rebind
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === 'win32')(
  'EADDRINUSE — stale socket is unlinked and rebind succeeds',
  () => {
    let thinkHome: string;
    let originalThinkHome: string | undefined;

    beforeEach(() => {
      originalThinkHome = process.env.THINK_HOME;
      thinkHome = tmpThinkHome();
      process.env.THINK_HOME = thinkHome;
      vi.resetModules();
    });

    afterEach(() => {
      if (originalThinkHome === undefined) delete process.env.THINK_HOME;
      else process.env.THINK_HOME = originalThinkHome;
      rmSync(thinkHome, { recursive: true, force: true });
    });

    it('detects a stale socket (no listener), unlinks it, and binds successfully', async () => {
      const socketPath = join(thinkHome, 'daemon.sock');

      // Create a stale (0-byte) socket file with no listener behind it.
      writeFileSync(socketPath, '');

      const { runDaemon } = await import('../../src/daemon/index.js');

      let resolveReady: () => void;
      const ready = new Promise<void>((r) => { resolveReady = r; });

      const origWrite = process.stderr.write.bind(process.stderr);
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        if (String(chunk).includes('think daemon ready')) resolveReady();
        return origWrite(chunk);
      });

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);

      const daemonPromise = runDaemon({
        socketPath,
        foreground: true,
      });

      await ready;

      // Daemon came up — socket must be a real socket now.
      expect(existsSync(socketPath)).toBe(true);

      process.emit('SIGINT');
      await new Promise((r) => setTimeout(r, 50));

      stderrSpy.mockRestore();
      exitSpy.mockRestore();
      await daemonPromise.catch(() => {});
    }, 10_000);
  },
);

// ---------------------------------------------------------------------------
// EADDRINUSE: live socket → exit cleanly
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === 'win32')(
  'EADDRINUSE — live socket causes clean exit with the right message',
  () => {
    let thinkHome: string;
    let originalThinkHome: string | undefined;
    let liveServer: { close: () => Promise<void> } | null = null;

    beforeEach(() => {
      originalThinkHome = process.env.THINK_HOME;
      thinkHome = tmpThinkHome();
      process.env.THINK_HOME = thinkHome;
      vi.resetModules();
    });

    afterEach(async () => {
      if (liveServer) { await liveServer.close().catch(() => {}); liveServer = null; }
      if (originalThinkHome === undefined) delete process.env.THINK_HOME;
      else process.env.THINK_HOME = originalThinkHome;
      rmSync(thinkHome, { recursive: true, force: true });
    });

    it('exits with "another daemon is already running" when a live daemon owns the socket', async () => {
      const socketPath = join(thinkHome, 'daemon.sock');

      // Start a real server on the socket so the connect-test succeeds.
      liveServer = await spawnLiveServer(socketPath);

      const { runDaemon } = await import('../../src/daemon/index.js');

      const stderrLines: string[] = [];
      const origWrite = process.stderr.write.bind(process.stderr);
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        stderrLines.push(String(chunk));
        return origWrite(chunk);
      });

      let exitCode: number | undefined;
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        exitCode = code;
      }) as () => never);

      await runDaemon({ socketPath, foreground: true }).catch(() => {});

      // Should have exited cleanly (code 1 signals conflict, not crash).
      expect(exitCode).toBe(1);

      const combined = stderrLines.join('');
      expect(combined).toMatch(/another daemon is already running/);
      expect(combined).toMatch(/think daemon status/);

      stderrSpy.mockRestore();
      exitSpy.mockRestore();
    }, 10_000);
  },
);
