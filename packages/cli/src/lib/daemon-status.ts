/**
 * Daemon liveness check via PID file — AGT-281
 *
 * Reads ~/.think/daemon.pid and tests whether the recorded process is alive
 * via kill(pid, 0). This lets callers ask "is the daemon running?" without
 * opening a socket connection.
 *
 * Exported API:
 *   isDaemonRunning() → { running: boolean, pid?: number, stale?: boolean }
 *
 * Used by:
 *   AGT-282 (spawn-or-connect), AGT-284 (think daemon status)
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function getThinkDir(): string {
  const override = process.env.THINK_HOME;
  if (override) return override;
  return path.join(os.homedir(), '.think');
}

export function getDaemonPidPath(): string {
  return path.join(getThinkDir(), 'daemon.pid');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DaemonStatus {
  running: boolean;
  /** The PID from the file, if any. Present when running=true or stale=true. */
  pid?: number;
  /** true when the PID file existed but the process is dead. */
  stale?: boolean;
}

/**
 * Check if the daemon is currently running by reading the PID file.
 *
 * Returns:
 *   { running: true,  pid }         — process alive
 *   { running: false, pid, stale: true }  — PID file exists, process dead
 *   { running: false }              — no PID file
 */
export function isDaemonRunning(): DaemonStatus {
  const pidPath = getDaemonPidPath();

  let raw: string;
  try {
    raw = fs.readFileSync(pidPath, 'utf8').trim();
  } catch (err: unknown) {
    // ENOENT → no PID file → not running
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { running: false };
    }
    throw err;
  }

  const pid = parseInt(raw, 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    // Corrupt PID file — treat as stale
    return { running: false, stale: true };
  }

  try {
    process.kill(pid, 0);
    // No exception → process exists
    return { running: true, pid };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      // Process dead → stale PID file
      return { running: false, pid, stale: true };
    }
    if (code === 'EPERM') {
      // We don't own the process but it exists — treat as running
      return { running: true, pid };
    }
    throw err;
  }
}
