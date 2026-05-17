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
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpThinkHome(): string {
  return mkdtempSync(join(tmpdir(), 'think-pid-test-'));
}

/**
 * Spawn a short-lived child process and return its PID after it has exited.
 * This is more reliable than scanning a fixed PID range because the kernel
 * guarantees the PID is not recycled before we've had a chance to use it.
 */
function getRecentlyDeadPid(): number {
  const result = spawnSync(process.execPath, ['-e', '']);
  if (result.pid == null || result.pid <= 0) {
    throw new Error('Could not spawn child process to obtain a dead PID');
  }
  return result.pid;
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

  it('returns { running: false, stale: true, pid } for a stale PID file (dead process)', async () => {
    // Spawn a process and wait for it to exit so we have a PID we know is dead.
    const deadPid = getRecentlyDeadPid();

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

  it('returns { running: false, stale: true } with no pid for a corrupt PID file', async () => {
    const pidFile = join(thinkHome, 'daemon.pid');
    writeFileSync(pidFile, 'not-a-number\n', { encoding: 'utf8' });

    const { isDaemonRunning } = await import('../../src/lib/daemon-status.js');
    const result = isDaemonRunning();

    expect(result.running).toBe(false);
    expect(result.stale).toBe(true);
    expect(result.pid).toBeUndefined();
  });
});
