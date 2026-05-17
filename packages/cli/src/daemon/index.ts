/**
 * think daemon entry point — AGT-278 scaffold
 *
 * Responsibilities (this ticket — scaffold only):
 *  - Write startup log to ~/.think/daemon.log (or stderr when --foreground)
 *  - Install SIGTERM / SIGINT handlers that log and exit cleanly
 *
 * NOT in this ticket:
 *  - Socket binding (AGT-279)
 *  - JSON-line protocol (AGT-280)
 *  - PID file (AGT-281)
 *  - API endpoints (AGT-285+)
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readPackageVersion } from '../lib/version.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function getThinkDir(): string {
  const override = process.env.THINK_HOME;
  if (override) return override;
  return path.join(os.homedir(), '.think');
}

function getDaemonLogPath(): string {
  return path.join(getThinkDir(), 'daemon.log');
}

/** Default Unix socket path. */
export function getDefaultSocketPath(): string {
  return path.join(getThinkDir(), 'daemon.sock');
}

// ---------------------------------------------------------------------------
// Minimal log rotation (keep ≤ 3 files, rotate when file exceeds 10 MB)
// ---------------------------------------------------------------------------

const LOG_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

function rotateLogs(logPath: string): void {
  try {
    if (!fs.existsSync(logPath)) return;
    const stat = fs.statSync(logPath);
    if (stat.size < LOG_MAX_BYTES) return;

    // Shift existing rotated files: .2 → drop, .1 → .2, base → .1
    const rotate2 = `${logPath}.2`;
    const rotate1 = `${logPath}.1`;
    if (fs.existsSync(rotate2)) fs.unlinkSync(rotate2);
    if (fs.existsSync(rotate1)) fs.renameSync(rotate1, rotate2);
    fs.renameSync(logPath, rotate1);
  } catch {
    // Rotation is best-effort; startup should not fail due to log rotation
  }
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

interface Logger {
  log(msg: string): void;
  close(): void;
}

function makeLogger(foreground: boolean, logPath: string): Logger {
  let fd: number | null = null;

  if (!foreground) {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      rotateLogs(logPath);
      fd = fs.openSync(logPath, 'a');
    } catch {
      // File open failed; all output falls through to stderr below
      process.stderr.write(
        `[think daemon] could not open log file ${logPath}, falling back to stderr\n`,
      );
    }
  }

  return {
    log(msg: string): void {
      const line = `[${new Date().toISOString()}] ${msg}\n`;
      if (foreground || fd === null) {
        process.stderr.write(line);
      }
      if (fd !== null) {
        try {
          fs.writeSync(fd, line);
        } catch {
          // Best-effort
        }
      }
    },
    close(): void {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // Ignore
        }
        fd = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DaemonOptions {
  socketPath: string;
  foreground: boolean;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runDaemon(options: DaemonOptions): Promise<void> {
  // Resolve version before opening the log so failures are visible.
  let version: string;
  try {
    version = readPackageVersion();
  } catch {
    version = '0.0.0';
  }

  const logger = makeLogger(options.foreground, getDaemonLogPath());

  logger.log(`think daemon starting (pid=${process.pid}, version=${version})`);
  logger.log(`socket-path=${options.socketPath}`);

  function shutdown(signal: string): void {
    logger.log(`shutting down… (signal=${signal})`);
    logger.close();
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  if (options.foreground) {
    // Foreground: attach to stdin so Ctrl-C / EOF work naturally in a terminal.
    process.stdin.resume();
    process.stdin.on('end', () => shutdown('stdin-close'));
    logger.log('think daemon ready');
  } else {
    // Non-foreground: socket server not yet wired; the process will exit
    // immediately because nothing holds the event loop open.
    // Exit non-zero so callers can detect the failure.
    process.stderr.write(
      `think daemon: socket not yet bound — pass --foreground to run in the foreground.\n`,
    );
    logger.log('think daemon: exiting (no socket to hold event loop)');
    logger.close();
    process.exit(1);
  }
}
