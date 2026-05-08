import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getSyncAdapter } from '../sync/registry.js';
import { getThinkDir } from '../lib/paths.js';

export interface AutoPropagateOpts {
  skip?: boolean;
}

/**
 * Pull the named cortex from the sync backend before a read command renders.
 * Silently no-ops when offline, adapter unavailable, or opts.skip is true.
 */
export async function pullForRead(cortex: string, opts: AutoPropagateOpts = {}): Promise<void> {
  if (opts.skip) return;
  const adapter = getSyncAdapter();
  if (!adapter?.isAvailable()) return;
  try {
    const reachable = await adapter.isReachable();
    if (!reachable) return;
    await adapter.pull(cortex);
  } catch {
    // Degrade silently — caller renders whatever's locally available
  }
}

/**
 * Fork a detached child process running `cortex push --cortex <name> --if-online`
 * after a retro write. Returns immediately; failures are logged to auto-sync.log.
 */
export function pushForWriteBackground(cortex: string, opts: AutoPropagateOpts = {}): void {
  if (opts.skip) return;
  const adapter = getSyncAdapter();
  if (!adapter?.isAvailable()) return;

  const thinkBin = process.argv[1];
  if (!thinkBin || !fs.existsSync(thinkBin)) return;

  const logPath = path.join(getThinkDir(), 'auto-sync.log');
  let logFd: number;
  try {
    logFd = fs.openSync(logPath, 'a');
  } catch {
    return;
  }

  try {
    const child = spawn(
      process.execPath,
      [thinkBin, 'cortex', 'push', '--cortex', cortex, '--if-online'],
      { detached: true, stdio: ['ignore', logFd, logFd] },
    );
    child.unref();
  } finally {
    fs.closeSync(logFd);
  }
}
