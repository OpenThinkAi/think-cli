/**
 * Unit tests for isDaemonRunning() — AGT-281
 *
 * Uses THINK_HOME pointing to a tmp dir so ~/.think is never touched.
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
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpThinkHome(): string {
  return mkdtempSync(join(tmpdir(), 'think-pid-test-'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('isDaemonRunning', () => {
  let thinkHome: string;
  let originalThinkHome: string | undefined;

  beforeEach(() => {
    originalThinkHome = process.env.THINK_HOME;
    thinkHome = tmpThinkHome();
    process.env.THINK_HOME = thinkHome;
    // Force fresh module load so THINK_HOME override is picked up by getThinkDir()
    vi.resetModules();
  });

  afterEach(() => {
    if (originalThinkHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalThinkHome;
    rmSync(thinkHome, { recursive: true, force: true });
  });

  it('returns { running: false } when no PID file exists', async () => {
    const { isDaemonRunning } = await import('../../src/lib/daemon-status.js');
    const result = isDaemonRunning();
    expect(result).toEqual({ running: false });
  });

  it('returns { running: false, stale: true } for a stale PID file (dead process)', async () => {
    // Find a PID that is guaranteed not to be running.
    // We use a very large number that is almost certainly unused; if kill(0)
    // somehow hits it, we try the next value. Virtually always the first
    // candidate works.
    function findDeadPid(): number {
      for (let candidate = 99990; candidate <= 99999; candidate++) {
        try {
          process.kill(candidate, 0);
          // Process exists — try the next one.
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code === 'ESRCH') return candidate;
          if ((err as NodeJS.ErrnoException).code === 'EPERM') continue; // exists, owned by someone else
        }
      }
      throw new Error('Could not find a guaranteed-dead PID in range 99990-99999');
    }

    const deadPid = findDeadPid();
    const pidFile = join(thinkHome, 'daemon.pid');
    writeFileSync(pidFile, String(deadPid) + '\n', { encoding: 'utf8' });

    const { isDaemonRunning } = await import('../../src/lib/daemon-status.js');
    const result = isDaemonRunning();

    expect(result.running).toBe(false);
    expect(result.stale).toBe(true);
    expect(result.pid).toBe(deadPid);
  });

  it('returns { running: true, pid } for a live process (our own PID)', async () => {
    const pidFile = join(thinkHome, 'daemon.pid');
    writeFileSync(pidFile, String(process.pid) + '\n', { encoding: 'utf8' });

    const { isDaemonRunning } = await import('../../src/lib/daemon-status.js');
    const result = isDaemonRunning();

    expect(result.running).toBe(true);
    expect(result.pid).toBe(process.pid);
    expect(result.stale).toBeUndefined();
  });

  it('returns { running: false, stale: true } for a corrupt PID file', async () => {
    const pidFile = join(thinkHome, 'daemon.pid');
    writeFileSync(pidFile, 'not-a-number\n', { encoding: 'utf8' });

    const { isDaemonRunning } = await import('../../src/lib/daemon-status.js');
    const result = isDaemonRunning();

    expect(result.running).toBe(false);
    expect(result.stale).toBe(true);
  });
});
