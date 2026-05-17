import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('daemon module', () => {
  let originalThinkHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalThinkHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-daemon-test-'));
    process.env.THINK_HOME = tmpHome;
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

  it('runDaemon resolves without throwing in foreground mode', async () => {
    const { runDaemon } = await import('../../src/daemon/index.js');

    // Mock process.on so signal handlers are captured but not actually registered
    // for the test process (avoids leaking SIGINT/SIGTERM handlers between tests).
    const onSpy = vi.spyOn(process, 'on').mockImplementation(() => process);

    // Mock process.stdin to prevent the persistent 'end' listener that foreground
    // mode installs from surviving the test and calling process.exit in a later test.
    const stdinResumeSpy = vi.spyOn(process.stdin, 'resume').mockImplementation(() => process.stdin);
    const stdinOnSpy = vi.spyOn(process.stdin, 'on').mockImplementation(() => process.stdin);

    // Capture stderr (foreground mode logs go to stderr).
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(runDaemon({ foreground: true })).resolves.toBeUndefined();

    // Confirm SIGTERM and SIGINT handlers were registered.
    const registeredEvents = onSpy.mock.calls.map(([event]) => event);
    expect(registeredEvents).toContain('SIGTERM');
    expect(registeredEvents).toContain('SIGINT');

    // Confirm stdin resume + end-listener were wired up in foreground mode.
    expect(stdinResumeSpy).toHaveBeenCalled();
    expect(stdinOnSpy).toHaveBeenCalledWith('end', expect.any(Function));

    // Confirm startup log was written to stderr.
    const stderrOutput = stderrSpy.mock.calls.map(([msg]) => msg as string).join('');
    expect(stderrOutput).toMatch(/think daemon starting/);
    expect(stderrOutput).toMatch(/pid=\d+/);
  });

  it('runDaemon does not attach stdin and exits 1 in non-foreground mode', async () => {
    const { runDaemon } = await import('../../src/daemon/index.js');

    vi.spyOn(process, 'on').mockImplementation(() => process);
    const stdinResumeSpy = vi.spyOn(process.stdin, 'resume').mockImplementation(() => process.stdin);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // Intercept process.exit so the test process itself doesn't terminate.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
      throw new Error(`process.exit(${_code})`);
    });

    // Non-foreground mode calls process.exit(1) because no socket holds the event loop.
    await expect(runDaemon({ foreground: false })).rejects.toThrow('process.exit(1)');

    // stdin must NOT be resumed in non-foreground mode (stdin may be /dev/null).
    expect(stdinResumeSpy).not.toHaveBeenCalled();

    // Confirm the honest "not yet" message appeared on stdout.
    const stdoutOutput = stdoutSpy.mock.calls.map(([msg]) => msg as string).join('');
    expect(stdoutOutput).toMatch(/think daemon/);
    expect(stdoutOutput).toMatch(/--foreground/);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
