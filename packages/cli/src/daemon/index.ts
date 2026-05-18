/**
 * think daemon entry point — AGT-278 scaffold + AGT-279 Unix socket server
 *                            + AGT-281 PID file with stale-detection
 *                            + AGT-283 graceful shutdown with drain
 *                            + AGT-286 sync RPC endpoint
 *
 * Responsibilities:
 *  - Write startup log to ~/.think/daemon.log (or stderr when --foreground)
 *  - Install SIGTERM / SIGINT handlers that log and exit cleanly
 *  - Bind a net.Server on ~/.think/daemon.sock (Unix) or localhost TCP (Windows)
 *  - EADDRINUSE stale-socket detection: connect-test → unlink + rebind if dead,
 *    exit cleanly if alive
 *  - chmod socket to 0600 immediately after bind, before accepting connections
 *  - Log each incoming connection at debug level; hand off to handleConnection()
 *  - On shutdown: stop accepting new connections → drain in-flight requests
 *    (up to 5s timeout, force-close after) → close server → unlink socket +
 *    PID files → exit 0
 *  - AGT-281: Write PID to ~/.think/daemon.pid (0600) after socket bind;
 *    stale-PID detection on startup; remove PID file on clean shutdown
 *  - AGT-283: shutdown RPC method triggers the same graceful sequence.
 *    process.on('exit') provides last-ditch cleanup for unexpected exits.
 *  - AGT-286: sync RPC method writes to L1 and L2.
 *
 * NOT in this ticket:
 *  - Compaction queue (AGT-299)
 *  - Push-to-remote debounce (AGT-309)
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPackageVersion } from '../lib/version.js';
import { getConfig } from '../lib/config.js';
import { getThinkDir, getDaemonSocketPath } from '../lib/paths.js';
import { getDaemonPidPath, isDaemonRunning, removePidFile } from '../lib/daemon-status.js';
import { DEFAULT_DAEMON_TCP_PORT } from '../lib/daemon-constants.js';
import { parseLineFraming, dispatchRequest } from './protocol.js';
import { handleSync } from './sync-handler.js';
import { handleStatus } from './status.js';
import { compactionQueue, scanAndEnqueueUncompacted } from './compaction/queue.js';
import { backfillActivitySeqIfNeeded } from '../db/activity-seq.js';
import { runEmbedModelChecks } from './embed-model-check.js';
import { warmupEmbedModel, EMBEDDING_MODEL_NAME } from '../lib/embed.js';
import { startProxySubscribe } from './proxy-subscribe.js';
import { startPullLoop, notifyCliCall } from './pull-loop.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

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
   * DEFAULT_DAEMON_TCP_PORT). Callers should still pass a sensible path so the field carries
   * one consistent value across platforms.
   */
  socketPath: string;
  foreground: boolean;
}

// ---------------------------------------------------------------------------
// PID file helpers (AGT-281)
// ---------------------------------------------------------------------------

/**
 * Write `process.pid` to `pidPath` with 0600 permissions.
 * Creates the directory if needed. Throws on failure.
 */
function writePidFile(pidPath: string): void {
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, String(process.pid) + '\n', { encoding: 'utf8', mode: 0o600 });
}

/**
 * On startup, check for an existing PID file using isDaemonRunning().
 * If a live daemon is already running, writes an error and returns false so the
 * caller can exit. If the recorded process is dead (stale), removes the file
 * and returns true so the caller can overwrite it. This should be unreachable
 * because the socket-bind check (AGT-279) fires first, but we defend here
 * for race conditions.
 *
 * Derives the PID file path via getDaemonPidPath() — matching isDaemonRunning()
 * so both functions always operate on the same file.
 */
function checkExistingPidFile(writeLine: (msg: string) => void): boolean {
  const pidPath = getDaemonPidPath();
  const status = isDaemonRunning();

  if (!status.running && !status.stale) {
    // No PID file → proceed
    return true;
  }

  if (status.running) {
    // Process is alive — another daemon is running.
    process.stderr.write(
      `error: another daemon is already running (pid=${status.pid}, detected via PID file). ` +
      `Kill the existing process or remove ${pidPath}.\n`,
    );
    return false;
  }

  // stale: true — process is dead → remove and overwrite
  if (status.pid !== undefined) {
    writeLine(`stale PID file detected (pid=${status.pid} is dead) — overwriting`);
  } else {
    writeLine(`stale PID file detected (corrupt content) — overwriting`);
  }
  removePidFile(pidPath);
  return true;
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

  const pidCheckOk = checkExistingPidFile(writeLine);
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
    tcpPort = config.daemon?.tcpPort ?? DEFAULT_DAEMON_TCP_PORT;
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

  // Counts requests currently being handled. Incremented synchronously before
  // dispatchRequest; decremented in the .finally() microtask (AGT-283 drain).
  let inFlight = 0;

  // The connection handler and daemonMethods (including the shutdown RPC) are
  // wired up after bindServer() completes — shutdown() needs server + pidPath
  // in scope. Create the server without a connection handler for now.
  const server = net.createServer();

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

  // ---------------------------------------------------------------------------
  // Embedding model warmup — pre-load Xenova/bge-small-en-v1.5 BEFORE
  // declaring "ready", so the first sync call never blocks on a cold model
  // load (~34s even with files cached on disk).
  //
  // v3 README §"Write path (kind=memory)" specifies embed+L2 insert is
  // synchronous with a target of 10–30ms. That target assumes the model is
  // already resident. Blocking "ready" on warmup is the correct fix: the
  // daemon is long-lived, so the one-time ~34s startup cost is amortised
  // across all syncs in the daemon's lifetime.
  //
  // If warmup fails (optional dep missing, ONNX ABI break, network error on
  // first download), we log a warning and proceed to "ready" in FTS-only mode
  // rather than refusing to start. The existing FTS fallback in sync-handler
  // handles missing-embed gracefully; callers see a degraded but working daemon.
  // ---------------------------------------------------------------------------

  writeLine(`embed-model: loading ${EMBEDDING_MODEL_NAME}…`);
  try {
    const warmupMs = await warmupEmbedModel();
    writeLine(`embed-model: loaded (${EMBEDDING_MODEL_NAME}, ${warmupMs}ms)`);
  } catch (err: unknown) {
    const msg = (err instanceof Error ? err.message : String(err)).replace(/[\r\n]/g, ' ');
    writeLine(`embed-model: WARN warmup failed — starting in FTS-only mode: ${msg}`);
  }

  if (isWindows && tcpPort !== null) {
    writeLine(`think daemon ready (tcp=127.0.0.1:${tcpPort})`);
  } else {
    writeLine(`think daemon ready (socket=${socketPath})`);
  }

  // ---------------------------------------------------------------------------
  // Compaction queue startup (AGT-299)
  //
  // 1. Start the serial worker loop.
  // 2. Scan L1 for raw kind=memory entries with no compaction_links row and
  //    re-enqueue them. Capped at 100 per cortex; older entries via `think reindex`.
  //    Queue runs in DRY_RUN mode until AGT-301 ships.
  // ---------------------------------------------------------------------------

  compactionQueue.start();

  const activeCortex = getConfig().cortex?.active;

  // ---------------------------------------------------------------------------
  // Activity-seq backfill on startup (AGT-292 AC #2)
  //
  // Before serving any requests, check the active cortex for rows with a NULL
  // activity_seq (e.g. after upgrade from v2, or after a partial reindex).
  // backfillActivitySeqIfNeeded is a no-op when all rows are already stamped.
  //
  // Wrapped in try/catch: if recomputeActivitySeq fails (schema mismatch,
  // DB corruption, etc.), the daemon logs the error and continues rather than
  // crashing before it can serve a single request.
  // ---------------------------------------------------------------------------

  if (activeCortex) {
    try {
      backfillActivitySeqIfNeeded(activeCortex, writeLine);
    } catch (backfillErr: unknown) {
      const msg = backfillErr instanceof Error ? backfillErr.message : String(backfillErr);
      writeLine(`activity_seq backfill for cortex '${activeCortex}' failed (continuing without backfill): ${msg}`);
    }
    scanAndEnqueueUncompacted(compactionQueue, [activeCortex]);
  }

  // ---------------------------------------------------------------------------
  // Embedding model version check — AGT-277
  //
  // For each known cortex, check whether the stored embedding_model matches the
  // current EMBEDDING_MODEL_NAME. If it differs (or if no embeddings exist yet),
  // trigger a full reindex. While reindexing, the recall endpoint returns a
  // transient "reindexing" error for that cortex; other cortexes continue serving.
  //
  // This runs as a fire-and-forget Promise after the server is ready so the
  // daemon can accept connections immediately. The reindex itself is awaited
  // per-cortex inside runEmbedModelChecks so that cortexes are processed
  // serially and the per-cortex busy flag is cleared before the next cortex
  // starts. Failures are logged but do not crash the daemon.
  // ---------------------------------------------------------------------------

  if (activeCortex) {
    runEmbedModelChecks([activeCortex], writeLine).catch((err: unknown) => {
      const msg = (err instanceof Error ? err.message : String(err)).replace(/[\r\n]/g, ' ');
      writeLine(`embed-model-check: unexpected error: ${msg}`);
    });
  }

  // ---------------------------------------------------------------------------
  // Pull loop — active/idle git-fetch polling per cortex (AGT-310)
  //
  // Start a per-cortex background poll loop alongside the push-debouncer and
  // compaction queue. The loop runs forever until `pullLoopHandle.stop()` is
  // called in shutdown.
  // ---------------------------------------------------------------------------

  let pullLoopHandle: { stop(): void } | null = null;

  if (activeCortex) {
    try {
      pullLoopHandle = startPullLoop(activeCortex, writeLine);
      writeLine(`[pull-loop:${activeCortex}] started`);
    } catch (pullErr: unknown) {
      const msg = pullErr instanceof Error ? pullErr.message : String(pullErr);
      writeLine(`WARN: could not start pull loop for cortex '${activeCortex}': ${msg}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Proxy-subscribe WS client (AGT-311)
  //
  // If config.proxy.url is set, connect to the proxy and listen for push
  // notifications. The callback is a no-op for now; a follow-up will wire it
  // to trigger an immediate pull on the matching cortex (AGT-310 path).
  // Falls back silently to polling if the proxy is unreachable.
  // ---------------------------------------------------------------------------

  const proxySubscribeHandle = startProxySubscribe((_cortex, _commitSha) => {
    // TODO: call triggerImmediatePull(cortex) here once AGT-311 passes the
    // cortex name through to the callback (the exported pull-loop function
    // exists; AGT-311's WS subscriber currently invokes the callback with
    // placeholder args).
  });

  // ---------------------------------------------------------------------------
  // Graceful shutdown (AGT-283)
  //
  // Sequence:
  //   1. Stop accepting new connections (server.close()).
  //   2. Wait up to DRAIN_TIMEOUT_MS for in-flight requests to reach zero.
  //   3. Unlink socket + PID files.
  //   4. Exit 0.
  //
  // The drain is purely counter-based: increment before dispatchRequest,
  // decrement in the finally clause (see handleConnection). If requests are
  // still in-flight after DRAIN_TIMEOUT_MS we force-exit anyway.
  // ---------------------------------------------------------------------------

  const DRAIN_TIMEOUT_MS = 5000;
  const DRAIN_POLL_MS    = 50;

  let shutdownInitiated = false;

  function shutdown(reason: string): void {
    if (shutdownInitiated) return;
    shutdownInitiated = true;

    writeLine(`shutting down (reason=${reason}, inFlightRequests=${inFlight})`);

    // Stop background loops so they don't issue network calls during drain.
    if (pullLoopHandle !== null) {
      pullLoopHandle.stop();
    }
    // Stop proxy-subscribe WS client (no-op if proxy not configured).
    proxySubscribeHandle.stop();

    // Step 1: stop accepting new connections.
    server.close();

    // Step 2: drain loop — poll inFlight until zero or timeout.
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;

    function drain(): void {
      if (inFlight <= 0 || Date.now() >= deadline) {
        if (inFlight > 0) {
          writeLine(`drain timeout reached; ${inFlight} request(s) still in-flight — force-closing`);
        } else {
          writeLine(`drain complete`);
        }
        // Step 3: unlink socket + PID files.
        if (socketPath !== null) {
          try { fs.unlinkSync(socketPath); } catch { /* already gone */ }
        }
        try { removePidFile(pidPath); } catch { /* best-effort */ }
        closeLog();
        // Step 4: exit.
        process.exit(0);
        return;
      }
      setTimeout(drain, DRAIN_POLL_MS);
    }

    drain();
  }

  // Last-ditch cleanup on any exit — defensive belt in case shutdown was
  // skipped (e.g., uncaught exception, external kill -9 won't hit this but
  // normal exits will).
  process.on('exit', () => {
    if (socketPath !== null) {
      try { fs.unlinkSync(socketPath); } catch { /* already gone */ }
    }
    try { removePidFile(pidPath); } catch { /* best-effort */ }
  });

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  // ---------------------------------------------------------------------------
  // shutdown RPC method (AGT-283)
  // ---------------------------------------------------------------------------

  const daemonMethods = new Map<string, (params: Record<string, unknown>) => Promise<unknown> | unknown>([
    [
      'shutdown',
      (_params) => {
        // Respond first, then initiate shutdown on the next tick so the
        // response has a chance to be flushed before the server stops.
        setImmediate(() => shutdown('shutdown-rpc'));
        return 'shutting_down';
      },
    ],
    ['sync', handleSync],
    ['status', handleStatus],
  ]);

  // Wire the connection handler now that daemonMethods and inFlight are in scope.
  server.on('connection', (socket: net.Socket) => {
    connectionCount += 1;
    writeLine(`debug: connection #${connectionCount} accepted (remoteAddress=${socket.remoteAddress ?? 'unix'})`);

    // Drive the async iterator; each iteration yields one parsed request.
    // Errors and malformed lines are handled inside parseLineFraming/dispatchRequest
    // without closing the connection.
    (async () => {
      for await (const request of parseLineFraming(socket)) {
        // Notify the pull loop that CLI activity occurred so it switches to
        // active-mode polling (AGT-310). The cortex is not known at this
        // layer, but notifyCliCall with the active cortex is sufficient for
        // the common single-cortex case. Handlers that know the cortex
        // (e.g. sync) may call notifyCliCall directly with the specific name.
        if (activeCortex) {
          notifyCliCall(activeCortex);
        }

        // Track in-flight count around each dispatch (AGT-283 drain).
        inFlight += 1;
        dispatchRequest(socket, request, daemonMethods).catch(() => {
          // errors are sent as error responses; decrement still required
        }).finally(() => {
          inFlight -= 1;
        });
      }
    })().catch(() => {
      // If the iterator itself throws (socket error etc.), tear down the socket.
      socket.destroy();
    });
  });

  if (options.foreground) {
    // Foreground: attach to stdin so Ctrl-C / EOF work naturally in a terminal.
    process.stdin.resume();
    process.stdin.on('end', () => shutdown('stdin-close'));
  }
}

// ---------------------------------------------------------------------------
// Auto-execute when invoked as a script (#58)
// ---------------------------------------------------------------------------
//
// `spawnDaemon` in lib/daemon-client.ts runs `node <dist/daemon/index.js>` as
// a detached child. Until this block existed, that spawn imported the module
// (registering `runDaemon` as a named export) and then exited — nothing ever
// started serving, and the parent's connect-retry loop silently timed out.
//
// `process.argv[1]` is the script path Node was invoked with. Compare it to
// this module's own resolved filename to detect "was I invoked as a script?"
// without breaking `import { runDaemon } from ...` callers (foreground mode
// in commands/daemon.ts).
//
// `fs.realpathSync` on both sides is required because macOS resolves symlinks
// like `/tmp` → `/private/tmp` in `import.meta.url` but leaves `process.argv[1]`
// unresolved — direct string compare fails for the same physical file.
let _invokedAsScript = false;
if (process.argv[1]) {
  try {
    _invokedAsScript = fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // If realpath fails (path missing, perms), assume not script-invoked.
  }
}
if (_invokedAsScript) {
  runDaemon({ socketPath: getDaemonSocketPath(), foreground: false }).catch((err) => {
    // Last-resort logging — daemon log helper may not be set up if startup
    // crashed early. stderr captures it for `node <entry> 2>&1` style debugging.
    process.stderr.write(
      `daemon startup failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });
}
