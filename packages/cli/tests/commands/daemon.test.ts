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
    process.exitCode = 0;
  });

  it('imports without throwing', async () => {
    // The module must load cleanly regardless of environment.
    await expect(import('../../src/daemon/index.js')).resolves.toBeDefined();
  });

  it('runDaemon resolves without throwing in foreground mode', async () => {
    const { runDaemon } = await import('../../src/daemon/index.js');

    // Spy on process.on so we can capture and ignore the signal handlers
    // (we do not actually want to trigger SIGINT in the test runner).
    const onSpy = vi.spyOn(process, 'on').mockImplementation(() => process);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(
      runDaemon({ foreground: true }),
    ).resolves.toBeUndefined();

    // Confirm that SIGTERM and SIGINT handlers were registered.
    const registeredEvents = onSpy.mock.calls.map(([event]) => event);
    expect(registeredEvents).toContain('SIGTERM');
    expect(registeredEvents).toContain('SIGINT');

    // Confirm startup log was written to stderr (foreground mode).
    const stderrOutput = stderrSpy.mock.calls.map(([msg]) => msg as string).join('');
    expect(stderrOutput).toMatch(/think daemon starting/);
    expect(stderrOutput).toMatch(/pid=\d+/);
  });
});
