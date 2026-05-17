/**
 * think daemon entry point — AGT-278 scaffold + AGT-279 Unix socket server
 *                            + AGT-281 PID file with stale-detection
 *
 * Responsibilities:
 *  - Write startup log to ~/.think/daemon.log (or stderr when --foreground)
 *  - Install SIGTERM / SIGINT handlers that log and exit cleanly
 *  - Bind a net.Server on ~/.think/daemon.sock (Unix) or localhost TCP (Windows)
 *  - EADDRINUSE stale-socket detection: connect-test → unlink + rebind if dead,
 *    exit cleanly if alive
 *  - chmod socket to 0600 immediately after bind, before accepting connections
 *  - Log each incoming connection at debug level; hand off to handleConnection()
 *  - On shutdown: close server, unlink socket file
 *  - AGT-281: Write PID to ~/.think/daemon.pid (0600) after socket bind;
 *    stale-PID detection on startup; remove PID file on clean shutdown
 *
 * NOT in this ticket:
 *  - JSON-line protocol (AGT-280)
 *  - API endpoints (AGT-285+)
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { readPackageVersion } from '../lib/version.js';
import { getConfig } from '../lib/config.js';
import { getDaemonPidPath } from '../lib/daemon-status.js';

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
  /**
   * Unix domain socket path. Used on macOS/Linux. Ignored on Windows, which
   * binds localhost TCP instead (port from `config.daemon.tcpPort`, default
   * 47821). Callers should still pass a sensible path so the field carries
   * one consistent value across platforms.
   */
  socketPath: string;
  foreground: boolean;
}

// ---------------------------------------------------------------------------
// Connection handler stub (protocol arrives in AGT-280)
// ---------------------------------------------------------------------------

function handleConnection(socket: net.Socket): void {
  // Protocol arrives in AGT-280. Until then, close immediately so a curious
  // client doesn't pin a file descriptor open indefinitely.
  socket.destroy();
}

// ---------------------------------------------------------------------------
// PID file helpers (AGT-281)
// ---------------------------------------------------------------------------

/**
 * Write `process.pid` to `~/.think/daemon.pid` with 0600 permissions.
 * Creates the directory if needed. Throws on failure.
 */
function writePidFile(pidPath: string): void {
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, String(process.pid) + '\n', { encoding: 'utf8', mode: 0o600 });
}

/**
 * Remove the PID file. Swallows ENOENT (already gone). Re-throws other errors.
 */
function removePidFile(pidPath: string): void {
  try {
    fs.unlinkSync(pidPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * On startup, check for an existing PID file. If a live daemon is already
 * running, exits with an error message. If the recorded process is dead
 * (stale), deletes the file so we can overwrite it. Returns `true` if the
 * caller should proceed with startup, `false` if we already called
 * `process.exit`.
 */
function checkExistingPidFile(pidPath: string, writeLine: (msg: string) => void): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(pidPath, 'utf8').trim();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true; // no file — proceed
    throw err;
  }

  const pid = parseInt(raw, 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    writeLine(`warn: daemon.pid contains invalid value "${raw}" — overwriting`);
    removePidFile(pidPath);
    return true;
  }

  try {
    process.kill(pid, 0);
    // Process is alive — another daemon is running. This should be unreachable
    // because the socket-bind check (AGT-279) fires first, but we defend here
    // for race conditions.
    process.stderr.write(
      `error: another daemon is already running (pid=${pid}, detected via PID file). ` +
      `Kill the existing process or remove ${pidPath}.\n`,
    );
    return false;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      writeLine(`stale PID file detected (pid=${pid} is dead) — overwriting`);
      removePidFile(pidPath);
      return true;
    }
    if (code === 'EPERM') {
      // Process exists but we lack permission to signal it — treat as alive.
      process.stderr.write(
        `error: another daemon appears to be running (pid=${pid}, EPERM). ` +
        `Kill the existing process or remove ${pidPath}.\n`,
      );
      return false;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Stale-socket detection
// ---------------------------------------------------------------------------

/**
 * Returns true if a live daemon is accepting connections on `socketPath`.
 * Tries to connect; on ECONNREFUSED/ENOENT/timeout returns false.
 * 1500 ms timeout — loaded systems can be slow to accept; the connect-test
 * gates whether we unlink a socket, so a false-negative here would destroy
 * a live daemon's socket. Err on the side of waiting.
 */
function isSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = net.createConnection({ path: socketPath });
    const timer = setTimeout(() => {
      client.destroy();
      resolve(false);
    }, 1500);
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

  function closeLog(): void {
    if (logFd !== null) {
      try { fs.closeSync(logFd); } catch { /* ignore */ }
      logFd = null;
    }
  }

  writeLine(`think daemon starting (pid=${process.pid}, version=${version})`);

  // ---------------------------------------------------------------------------
  // PID file — stale detection before bind (AGT-281)
  // ---------------------------------------------------------------------------

  const pidPath = getDaemonPidPath();

  const pidCheckOk = checkExistingPidFile(pidPath, writeLine);
  if (!pidCheckOk) {
    closeLog();
    process.exit(1);
  }

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

  /**
   * User-facing message when another daemon already holds the bind address.
   * Path-specific hint stays actionable even before AGT-285 lands a
   * `think daemon status` subcommand.
   */
  function alreadyRunningMessage(): string {
    if (isWindows && tcpPort !== null) {
      return `error: another daemon is already running (TCP 127.0.0.1:${tcpPort}). Kill the existing process or change config.daemon.tcpPort.\n`;
    }
    return `error: another daemon is already running. Kill the existing process or, if you believe this is stale, remove ${socketPath}.\n`;
  }

  // ---------------------------------------------------------------------------
  // Bind net.Server with EADDRINUSE stale-socket detection
  // ---------------------------------------------------------------------------

  let connectionCount = 0;

  const server = net.createServer((socket) => {
    connectionCount += 1;
    writeLine(`debug: connection #${connectionCount} accepted (remoteAddress=${socket.remoteAddress ?? 'unix'})`);
    handleConnection(socket);
  });

  function bindServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      function handleListenError(err: NodeJS.ErrnoException): void {
        if (err.code !== 'EADDRINUSE') {
          reject(err);
          return;
        }

        if (isWindows || socketPath === null) {
          // TCP on Windows: EADDRINUSE means another daemon owns the port.
          process.stderr.write(alreadyRunningMessage());
          closeLog();
          process.exit(1);
        }

        // Unix socket EADDRINUSE: connect-test to distinguish live vs stale.
        writeLine(`EADDRINUSE on ${socketPath} — testing liveness`);
        isSocketAlive(socketPath)
          .then((alive) => {
            if (alive) {
              process.stderr.write(alreadyRunningMessage());
              closeLog();
              process.exit(1);
            }
            // Stale socket from a previous crash — unlink and retry.
            writeLine(`stale socket detected — unlinking ${socketPath} and rebinding`);
            try {
              fs.unlinkSync(socketPath!);
            } catch (unlinkErr: unknown) {
              reject(unlinkErr);
              return;
            }
            tryListen();
          })
          .catch(reject);
      }

      function tryListen(): void {
        server.removeAllListeners('error');
        server.once('error', handleListenError);

        if (isWindows && tcpPort !== null) {
          server.listen(tcpPort, '127.0.0.1', () => resolve());
        } else if (socketPath !== null) {
          server.listen(socketPath, () => {
            // chmod immediately after bind — restricts permissions as soon
            // as possible after the kernel creates the socket inode. The OS
            // creates the file with umask-derived perms first, so a small
            // (microsecond) window exists; chmod failure is hard-fatal so
            // we never accept connections on a permissive socket.
            try {
              fs.chmodSync(socketPath!, 0o600);
            } catch (chmodErr: unknown) {
              try { fs.unlinkSync(socketPath!); } catch { /* best-effort */ }
              reject(new Error(`could not chmod socket to 0600 at ${socketPath}: ${String(chmodErr)}`));
              return;
            }
            resolve();
          });
        } else {
          // Unreachable — `socketPath` is set on non-Windows and `tcpPort`
          // is set on Windows. Guard against future drift.
          reject(new Error('no bind target: neither socketPath nor tcpPort is set'));
        }
      }

      tryListen();
    });
  }

  await bindServer();

  // Write PID file after socket bind succeeds (AGT-281).
  // If this fails, the daemon shuts down hard — better to die visibly than
  // to run without a PID file that downstream tooling depends on.
  try {
    writePidFile(pidPath);
    writeLine(`pid file written (pid=${process.pid}, path=${pidPath})`);
  } catch (pidErr: unknown) {
    process.stderr.write(`error: could not write PID file at ${pidPath}: ${String(pidErr)}\n`);
    server.close();
    if (socketPath !== null) {
      try { fs.unlinkSync(socketPath); } catch { /* best-effort */ }
    }
    closeLog();
    process.exit(1);
  }

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
      if (socketPath !== null) {
        try { fs.unlinkSync(socketPath); } catch { /* already gone */ }
      }
      // Remove PID file on clean shutdown (AGT-281).
      try { removePidFile(pidPath); } catch { /* best-effort */ }
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
