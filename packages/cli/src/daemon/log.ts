/**
 * Shared daemon logging helper.
 *
 * Writes a timestamped, subsystem-tagged line to both stderr and daemon.log.
 *
 * Required because the daemon is spawned detached (`stdio: 'ignore'`) — any
 * subsystem that writes only to stderr is silent in production. Used by
 * compaction-queue, push-debouncer, and proxy-subscribe.
 *
 * Sync `appendFileSync` is acceptable: low-volume log (a handful of lines per
 * subsystem event, subsystems run at most a few per second).
 */

import fs from 'node:fs';
import path from 'node:path';
import { getThinkDir } from '../lib/paths.js';

/**
 * Write a timestamped, subsystem-tagged line to both stderr and daemon.log.
 *
 * @param subsystem  Short identifier for the calling subsystem, e.g.
 *                   `'push-debouncer'`, `'proxy-subscribe'`, `'compaction-queue'`.
 * @param msg        Log message (no trailing newline needed).
 */
export function daemonLog(subsystem: string, msg: string): void {
  const line = `[${new Date().toISOString()}] [${subsystem}] ${msg}\n`;
  process.stderr.write(line);
  try {
    fs.appendFileSync(path.join(getThinkDir(), 'daemon.log'), line);
  } catch {
    // Best-effort; never let logging failures propagate.
  }
}
