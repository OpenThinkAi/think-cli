/**
 * think daemon entry point — AGT-278 scaffold + AGT-279 Unix socket server
 *
 * Responsibilities (this ticket):
 *  - Write startup log to ~/.think/daemon.log (or stderr when --foreground)
 *  - Install SIGTERM / SIGINT handlers that log and exit cleanly
 *  - Bind a net.Server on ~/.think/daemon.sock (Unix) or localhost TCP (Windows)
 *  - EADDRINUSE stale-socket detection: connect-test → unlink + rebind if dead,
 *    exit cleanly if alive
 *  - chmod socket to 0600 immediately after bind
 *  - Log each incoming connection at DEBUG level; hand off to handleConnection()
 *  - On shutdown: close server, unlink socket file
 *
 * NOT in this ticket:
 *  - JSON-line protocol (AGT-280)
 *  - PID file (AGT-281)
 *  - API endpoints (AGT-285+)
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { readPackageVersion } from '../lib/version.js';
import { getConfig } from '../lib/config.js';

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
// Connection handler stub (protocol arrives in AGT-280)
// ---------------------------------------------------------------------------

function handleConnection(_socket: net.Socket): void {
  // No-op until AGT-280 wires the JSON-line protocol.
}

// ---------------------------------------------------------------------------
// Stale-socket detection
// ---------------------------------------------------------------------------

/**
 * Returns true if a live daemon is accepting connections on `socketPath`.
 * Tries to connect; on ECONNREFUSED/ENOENT/timeout returns false.
 */
function isSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = net.createConnection({ path: socketPath });
    const timer = setTimeout(() => {
      client.destroy();
      resolve(false);
    }, 500);
    client.on('connect', () => {
      clearTimeout(timer);
      client.destroy();
      resolve(true);
    });
    client.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
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

  function writeDebug(msg: string): void {
    writeLine(`DEBUG ${msg}`);
  }

  function closeLog(): void {
    if (logFd !== null) {
      try { fs.closeSync(logFd); } catch { /* ignore */ }
      logFd = null;
    }
  }

  writeLine(`think daemon starting (pid=${process.pid}, version=${version})`);

  // ---------------------------------------------------------------------------
  // Resolve bind address
  // ---------------------------------------------------------------------------

  const isWindows = process.platform === 'win32';
  let socketPath: string | null = null;
  let tcpPort: number | null = null;

  if (isWindows) {
    const config = getConfig();
    tcpPort = config.daemon?.tcpPort ?? 47821;
    writeLine(`windows platform: binding TCP localhost:${tcpPort} (socket-path ignored)`);
  } else {
    socketPath = options.socketPath;
    writeLine(`socket-path=${socketPath}`);
  }

  // ---------------------------------------------------------------------------
  // Bind net.Server with EADDRINUSE stale-socket detection
  // ---------------------------------------------------------------------------

  let connectionCount = 0;

  const server = net.createServer((socket) => {
    connectionCount += 1;
    writeDebug(`connection #${connectionCount} accepted (remoteAddress=${socket.remoteAddress ?? 'unix'})`);
    handleConnection(socket);
  });

  async function bindServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      function tryListen(): void {
        server.removeAllListeners('error');
        server.once('error', async (err: NodeJS.ErrnoException) => {
          if (err.code !== 'EADDRINUSE') {
            reject(err);
            return;
          }

          if (isWindows || socketPath === null) {
            // TCP on Windows: EADDRINUSE means another daemon owns the port.
            process.stderr.write('error: another daemon is already running. Try: think daemon status\n');
            closeLog();
            process.exit(1);
          }

          // Unix socket EADDRINUSE: connect-test to distinguish live vs stale.
          writeLine(`EADDRINUSE on ${socketPath} — testing liveness`);
          const alive = await isSocketAlive(socketPath);
          if (alive) {
            process.stderr.write('error: another daemon is already running. Try: think daemon status\n');
            closeLog();
            process.exit(1);
          }

          // Stale socket from a previous crash — unlink and retry.
          writeLine(`stale socket detected — unlinking ${socketPath} and rebinding`);
          try {
            fs.unlinkSync(socketPath);
          } catch (unlinkErr: unknown) {
            reject(unlinkErr);
            return;
          }
          tryListen();
        });

        if (isWindows && tcpPort !== null) {
          server.listen(tcpPort, '127.0.0.1', () => resolve());
        } else if (socketPath !== null) {
          server.listen(socketPath, () => {
            // chmod immediately after bind, before the caller proceeds.
            // This ensures no window between socket creation and permission
            // restriction where an unprivileged local user could connect.
            try {
              fs.chmodSync(socketPath!, 0o600);
            } catch (chmodErr: unknown) {
              // Log but don't hard-abort — the socket is still functional;
              // the system's umask may have already restricted it.
              writeLine(`warning: could not chmod socket to 0600: ${String(chmodErr)}`);
            }
            resolve();
          });
        }
      }

      tryListen();
    });
  }

  await bindServer();

  if (isWindows && tcpPort !== null) {
    writeLine(`think daemon ready (tcp=127.0.0.1:${tcpPort})`);
  } else {
    writeLine(`think daemon ready (socket=${socketPath})`);
  }

  // ---------------------------------------------------------------------------
  // Signal handlers — shutdown
  // ---------------------------------------------------------------------------

  function shutdown(signal: string): void {
    writeLine(`shutting down… (signal=${signal})`);
    server.close(() => {
      if (socketPath !== null && !isWindows) {
        try { fs.unlinkSync(socketPath); } catch { /* already gone */ }
      }
      closeLog();
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  if (options.foreground) {
    // Foreground: attach to stdin so Ctrl-C / EOF work naturally in a terminal.
    process.stdin.resume();
    process.stdin.on('end', () => shutdown('stdin-close'));
  }
}
