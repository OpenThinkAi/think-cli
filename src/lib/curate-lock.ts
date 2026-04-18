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
  const release = () => {
    if (released) return;
    released = true;
    try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
  };

  // Best-effort release on abnormal exit. finally-blocks cover the normal
  // path; these cover SIGTERM / SIGINT / uncaught exceptions.
  const cleanup = () => release();
  process.once('exit', cleanup);
  process.once('SIGINT', () => { cleanup(); process.exit(130); });
  process.once('SIGTERM', () => { cleanup(); process.exit(143); });

  return { acquired: true, release };
}
