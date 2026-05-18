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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpThinkHome(): string {
  return mkdtempSync(join(tmpdir(), 'think-pid-test-'));
}

/**
 * Search the high PID range for an integer that does not correspond to any
 * running process (kill(pid, 0) → ESRCH). Avoids spawnSync of node, which is
 * slow under heavy parallel test load (≥15 s observed) and risks PID
 * recycling — the kernel does not guarantee a freed PID stays unused.
 */
function getUnusedPid(): number {
  for (let candidate = 99998; candidate > 1024; candidate--) {
    if (candidate === process.pid) continue;
    try {
      process.kill(candidate, 0);
      // No throw — process exists. Skip.
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return candidate;
      // EPERM means the PID is in use by a process we don't own — skip.
    }
  }
  throw new Error('Could not find an unused PID in range (1024, 99998]');
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
    const deadPid = getUnusedPid();

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
