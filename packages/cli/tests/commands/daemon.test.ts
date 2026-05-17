import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('daemon module', () => {
  let originalThinkHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalThinkHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-daemon-test-'));
    process.env.THINK_HOME = tmpHome;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalThinkHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalThinkHome;
    rmSync(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('imports without throwing', async () => {
    await expect(import('../../src/daemon/index.js')).resolves.toBeDefined();
  });

  it('runDaemon resolves and binds the socket in foreground mode', async () => {
    const { runDaemon } = await import('../../src/daemon/index.js');
    const socketPath = join(tmpHome, 'daemon.sock');

    // Capture stderr (foreground mode logs go to stderr).
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // Mock process.exit so test doesn't die on shutdown.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);

    // Mock process.stdin so the persistent 'end' listener doesn't survive the test.
    vi.spyOn(process.stdin, 'resume').mockImplementation(() => process.stdin);
    vi.spyOn(process.stdin, 'on').mockImplementation(() => process.stdin);

    const daemonPromise = runDaemon({ foreground: true, socketPath });

    // Wait until "daemon ready" is logged.
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        const output = stderrSpy.mock.calls.map(([m]) => String(m)).join('');
        if (output.includes('think daemon ready')) { clearInterval(interval); resolve(); }
      }, 10);
    });

    // Socket file must exist after bind.
    expect(existsSync(socketPath)).toBe(true);

    // Confirm startup log was written to stderr.
    const stderrOutput = stderrSpy.mock.calls.map(([msg]) => String(msg)).join('');
    expect(stderrOutput).toMatch(/think daemon starting/);
    expect(stderrOutput).toMatch(/pid=\d+/);

    // Trigger shutdown so the server closes cleanly.
    process.emit('SIGINT');
    await new Promise((r) => setTimeout(r, 50));

    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    await daemonPromise.catch(() => {});
  }, 10_000);

  it('runDaemon does not attach stdin in non-foreground mode', async () => {
    const { runDaemon } = await import('../../src/daemon/index.js');
    const socketPath = join(tmpHome, 'daemon.sock');

    const stdinResumeSpy = vi.spyOn(process.stdin, 'resume').mockImplementation(() => process.stdin);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);

    const daemonPromise = runDaemon({ foreground: false, socketPath });

    // In non-foreground mode the log goes to the log file, not stderr.
    // Poll for the socket file to appear — that's the observable signal that
    // the server has bound.
    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const interval = setInterval(() => {
        if (existsSync(socketPath)) { clearInterval(interval); resolve(); return; }
        if (Date.now() - start > 5_000) { clearInterval(interval); reject(new Error('socket never appeared')); }
      }, 20);
    });

    // stdin must NOT be resumed in non-foreground mode (stdin may be /dev/null).
    expect(stdinResumeSpy).not.toHaveBeenCalled();

    // Socket was created.
    expect(existsSync(socketPath)).toBe(true);

    // Trigger shutdown.
    process.emit('SIGTERM');
    await new Promise((r) => setTimeout(r, 50));

    exitSpy.mockRestore();
    await daemonPromise.catch(() => {});
  }, 10_000);
});
