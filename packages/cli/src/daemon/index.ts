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

  const logPath = getDaemonLogPath();
  let logFd: number | null = null;

  if (!options.foreground) {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      logFd = fs.openSync(logPath, 'a');
    } catch {
      process.stderr.write(`[think daemon] could not open log file ${logPath}, falling back to stderr\n`);
    }
  }

  function writeLine(msg: string): void {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    if (options.foreground || logFd === null) {
      process.stderr.write(line);
    }
    if (logFd !== null) {
      try { fs.writeSync(logFd, line); } catch { /* best-effort */ }
    }
  }

  function closeLog(): void {
    if (logFd !== null) {
      try { fs.closeSync(logFd); } catch { /* ignore */ }
      logFd = null;
    }
  }

  writeLine(`think daemon starting (pid=${process.pid}, version=${version})`);
  writeLine(`socket-path=${options.socketPath}`);

  process.on('SIGTERM', () => { writeLine('shutting down… (signal=SIGTERM)'); closeLog(); process.exit(0); });
  process.on('SIGINT',  () => { writeLine('shutting down… (signal=SIGINT)');  closeLog(); process.exit(0); });

  if (options.foreground) {
    // Foreground: attach to stdin so Ctrl-C / EOF work naturally in a terminal.
    process.stdin.resume();
    process.stdin.on('end', () => { writeLine('shutting down… (signal=stdin-close)'); closeLog(); process.exit(0); });
    writeLine('think daemon ready');
  } else {
    // Non-foreground: socket server not yet wired; exit non-zero so callers detect the gap.
    process.stderr.write(
      `think daemon: socket not yet bound — pass --foreground to run in the foreground.\n`,
    );
    writeLine('think daemon: exiting (no socket to hold event loop)');
    closeLog();
    process.exit(1);
  }
}
