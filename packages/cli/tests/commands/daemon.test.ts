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
    // The module must load cleanly regardless of environment.
    await expect(import('../../src/daemon/index.js')).resolves.toBeDefined();
  });

  it('runDaemon resolves without throwing in foreground mode', async () => {
    const { runDaemon } = await import('../../src/daemon/index.js');

    // Mock process.on so signal handlers are captured but not actually registered
    // for the test process (avoids leaking SIGINT/SIGTERM handlers).
    const onSpy = vi.spyOn(process, 'on').mockImplementation(() => process);

    // Mock process.stdin to prevent a persistent 'end' listener from surviving
    // the test and triggering process.exit in a later test (e.g. when CI stdin closes).
    const stdinResumeSpy = vi.spyOn(process.stdin, 'resume').mockImplementation(() => process.stdin);
    const stdinOnSpy = vi.spyOn(process.stdin, 'on').mockImplementation(() => process.stdin);

    // Capture stderr (foreground mode logs go to stderr).
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(
      runDaemon({ foreground: true }),
    ).resolves.toBeUndefined();

    // Confirm SIGTERM and SIGINT handlers were registered.
    const registeredEvents = onSpy.mock.calls.map(([event]) => event);
    expect(registeredEvents).toContain('SIGTERM');
    expect(registeredEvents).toContain('SIGINT');

    // Confirm stdin.resume() was called (keeps event loop alive).
    expect(stdinResumeSpy).toHaveBeenCalled();
    expect(stdinOnSpy).toHaveBeenCalledWith('end', expect.any(Function));

    // Confirm startup log was written to stderr (foreground mode).
    const stderrOutput = stderrSpy.mock.calls.map(([msg]) => msg as string).join('');
    expect(stderrOutput).toMatch(/think daemon starting/);
    expect(stderrOutput).toMatch(/pid=\d+/);
  });
});
