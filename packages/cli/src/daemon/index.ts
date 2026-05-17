#!/usr/bin/env node
/**
 * think daemon entry point — AGT-278 scaffold
 *
 * Responsibilities (this ticket — scaffold only):
 *  - Parse --socket-path and --foreground argv
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
  if (override && override !== '') return override;
  return path.join(os.homedir(), '.think');
}

function getDaemonLogPath(): string {
  return path.join(getThinkDir(), 'daemon.log');
}

// ---------------------------------------------------------------------------
// Minimal log rotation (keep ≤ 3 files, rotate when file exceeds 10 MB)
// ---------------------------------------------------------------------------

const LOG_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const LOG_KEEP = 3;

function rotateLogs(logPath: string): void {
  try {
    if (!fs.existsSync(logPath)) return;
    const stat = fs.statSync(logPath);
    if (stat.size < LOG_MAX_BYTES) return;

    // Shift existing rotated files: .2 → drop, .1 → .2, base → .1
    const rotate2 = `${logPath}.2`;
    const rotate1 = `${logPath}.1`;
    if (fs.existsSync(rotate2)) fs.unlinkSync(rotate2);
    if (LOG_KEEP > 2 && fs.existsSync(rotate1)) fs.renameSync(rotate1, rotate2);
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
      // If we can't open the log file fall back to stderr
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
// Argv parsing (minimal; full flag parsing lives in the CLI command)
// ---------------------------------------------------------------------------

interface DaemonOptions {
  socketPath: string;
  foreground: boolean;
}

function parseArgv(argv: string[]): DaemonOptions {
  const defaults: DaemonOptions = {
    socketPath: path.join(getThinkDir(), 'daemon.sock'),
    foreground: false,
  };

  const args = argv.slice(2); // strip 'node' + script path
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--foreground' || arg === '-f') {
      defaults.foreground = true;
    } else if ((arg === '--socket-path' || arg === '--socketPath') && args[i + 1]) {
      defaults.socketPath = args[++i];
    }
  }
  return defaults;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runDaemon(options?: Partial<DaemonOptions>): Promise<void> {
  const opts: DaemonOptions = {
    socketPath: options?.socketPath ?? path.join(getThinkDir(), 'daemon.sock'),
    foreground: options?.foreground ?? false,
  };

  const version = readPackageVersion();
  const logger = makeLogger(opts.foreground, getDaemonLogPath());

  logger.log(`think daemon starting (pid=${process.pid}, version=${version})`);
  if (opts.socketPath) {
    logger.log(`socket-path=${opts.socketPath} (socket binding not yet implemented — AGT-279)`);
  }

  function shutdown(signal: string): void {
    logger.log(`shutting down… (signal=${signal})`);
    logger.close();
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // When running in foreground mode also exit cleanly on stdin close (EOF),
  // which is the normal case when a shell pipe or test runner closes stdin.
  if (opts.foreground) {
    process.stdin.resume();
    process.stdin.on('end', () => shutdown('stdin-close'));
  }

  // Scaffold: daemon is now "running". Downstream tickets add socket binding.
  // In foreground mode we keep the process alive so the caller can test signal
  // delivery. In detached/daemon mode the process stays alive indefinitely.
  logger.log('think daemon ready (scaffold — no socket yet)');
}

// ---------------------------------------------------------------------------
// Direct invocation  (node dist/daemon/index.js)
// ---------------------------------------------------------------------------

const isDirect =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('daemon/index.js') ||
    process.argv[1].endsWith('daemon/index.ts'));

if (isDirect) {
  const opts = parseArgv(process.argv);
  runDaemon(opts).catch((err: unknown) => {
    process.stderr.write(`think daemon: fatal error: ${String(err)}\n`);
    process.exit(1);
  });
}
