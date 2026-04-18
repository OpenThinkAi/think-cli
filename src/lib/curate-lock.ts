import fs from 'node:fs';
import path from 'node:path';
import { getThinkDir } from './paths.js';

function getLockPath(cortex: string): string {
  return path.join(getThinkDir(), `curate-${cortex}.lock`);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    // Signal 0 checks whether the process exists without actually signaling it.
    // Throws ESRCH if the process doesn't exist, EPERM if it exists but we
    // can't signal it — either way, EPERM means "alive enough for our check."
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

export interface LockAcquired {
  acquired: true;
  release: () => void;
}

export interface LockRejected {
  acquired: false;
  heldByPid: number | null;
}

export type LockResult = LockAcquired | LockRejected;

export function acquireCurateLock(cortex: string): LockResult {
  const lockPath = getLockPath(cortex);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  // First attempt: exclusive create.
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    return makeAcquired(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  // Lock file exists — check if the holder is still alive.
  let heldByPid: number | null = null;
  try {
    const raw = fs.readFileSync(lockPath, 'utf-8').trim();
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) heldByPid = parsed;
  } catch { /* unreadable lock — treat as stale */ }

  if (heldByPid && isProcessAlive(heldByPid)) {
    return { acquired: false, heldByPid };
  }

  // Stale lock — take it over.
  try { fs.unlinkSync(lockPath); } catch { /* raced — fall through */ }
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    return makeAcquired(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      // Someone else took it in the race. Re-read and report.
      let nowHeldBy: number | null = null;
      try {
        const raw = fs.readFileSync(lockPath, 'utf-8').trim();
        const parsed = parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed > 0) nowHeldBy = parsed;
      } catch { /* ignore */ }
      return { acquired: false, heldByPid: nowHeldBy };
    }
    throw err;
  }
}

function makeAcquired(lockPath: string): LockAcquired {
  let released = false;

  // Core unlink — idempotent via the `released` flag so the exit/signal
  // handlers can't race with an explicit release() call.
  const unlinkIfHeld = () => {
    if (released) return;
    released = true;
    try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
  };

  // Signal handlers: clean up *this* lock, then propagate the signal's
  // usual exit code. Each lock owns its own handler instances so release()
  // can remove them precisely — important for long-running processes that
  // acquire/release multiple times (tests, future daemons).
  const exitHandler = () => { unlinkIfHeld(); };
  const sigintHandler = () => { unlinkIfHeld(); process.exit(130); };
  const sigtermHandler = () => { unlinkIfHeld(); process.exit(143); };

  process.on('exit', exitHandler);
  process.on('SIGINT', sigintHandler);
  process.on('SIGTERM', sigtermHandler);

  const release = () => {
    if (released) {
      // Even on double-release, drop the handlers so they don't linger.
      process.removeListener('exit', exitHandler);
      process.removeListener('SIGINT', sigintHandler);
      process.removeListener('SIGTERM', sigtermHandler);
      return;
    }
    unlinkIfHeld();
    process.removeListener('exit', exitHandler);
    process.removeListener('SIGINT', sigintHandler);
    process.removeListener('SIGTERM', sigtermHandler);
  };

  return { acquired: true, release };
}
