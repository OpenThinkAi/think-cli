/**
 * Spawn-or-connect helper for the think daemon — AGT-282
 *
 * Exports `connectDaemon(): Promise<DaemonClient>` which:
 *   1. Tries to connect to the daemon Unix socket (or TCP on Windows).
 *   2. If the socket is absent or refusing connections, spawns the daemon
 *      as a detached background process (process.execPath, .unref()).
 *   3. Retries with exponential backoff (50 → 100 → 200 → 400 → …) up to 5 s.
 *   4. After 5 s without success: throws a clear error pointing to daemon.log.
 *
 * Wire protocol: JSON-line (one JSON object per line), matching AGT-280.
 *   request  → { "request_id": "<uuid>", "method": "<string>", "params": {...} }\n
 *   response → { "request_id": "<uuid>", "result": <any> }\n
 *           OR { "request_id": "<uuid>", "error": { "code": "<string>", "message": "<string>" } }\n
 *
 * DaemonClient is keep-alive: one connection is shared across all RPC calls
 * within a single CLI invocation. A module-level `process.on('exit')` handler
 * closes the active connection even if the caller forgets.
 *
 * Per-call timeout: 30 s by default (overridable per call).
 *
 * Used by:
 *   AGT-285+ (CLI commands that talk to the daemon)
 */

import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { getThinkDir } from './paths.js';
import { getConfig } from './config.js';
import { DEFAULT_DAEMON_TCP_PORT } from './daemon-constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default per-call timeout in milliseconds. */
const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/** Initial retry delay in milliseconds (doubles on each attempt). */
const INITIAL_RETRY_DELAY_MS = 50;

/** Maximum total time to wait for the daemon to start (milliseconds). */
const SPAWN_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function getDaemonSocketPath(): string {
  return path.join(getThinkDir(), 'daemon.sock');
}

function getDaemonLogPath(): string {
  return path.join(getThinkDir(), 'daemon.log');
}

/**
 * Absolute path to the daemon entry point in the compiled `dist/` tree.
 * Resolves relative to this file's location:
 *   packages/cli/dist/lib/daemon-client.js  →  ../../daemon/index.js
 *
 * At source level (tsx/ts-node), __dirname is packages/cli/src/lib, so the
 * same relative path still works because both source and dist trees share the
 * same packages/cli/<root>/<subdir> shape.
 */
function getDaemonEntryPath(): string {
  // import.meta.url is always available in ESM; __dirname is not.
  const thisFile = new URL(import.meta.url).pathname;
  // Go up two levels: lib/ → src_or_dist/ → packages/cli/
  const pkgRoot = path.resolve(path.dirname(thisFile), '..', '..');
  return path.join(pkgRoot, 'dist', 'daemon', 'index.js');
}

// ---------------------------------------------------------------------------
// Wire-level types (matches AGT-280 protocol)
// ---------------------------------------------------------------------------

interface WireRequest {
  request_id: string;
  method: string;
  params: Record<string, unknown>;
}

interface WireResultResponse {
  request_id: string;
  result: unknown;
}

interface WireErrorResponse {
  request_id: string;
  error: {
    code: string;
    message: string;
  };
}

type WireResponse = WireResultResponse | WireErrorResponse;

function isErrorResponse(r: WireResponse): r is WireErrorResponse {
  return 'error' in r && r.error != null;
}

// ---------------------------------------------------------------------------
// Module-level exit handler — registered once, not per-connection (AC #5).
// ---------------------------------------------------------------------------

/**
 * The currently active connection. A module-level reference so the single
 * exit handler can always reach it without per-instance listener accumulation.
 */
let _activeConnection: DaemonConnection | null = null;

process.on('exit', () => {
  _activeConnection?.close();
});

// ---------------------------------------------------------------------------
// DaemonClient
// ---------------------------------------------------------------------------

/**
 * A live, keep-alive connection to the think daemon.
 *
 * Call `client.call(method, params)` to issue an RPC. Multiple calls may be
 * in-flight concurrently on the same connection; they are correlated by
 * `request_id`.
 *
 * Call `client.close()` to tear down the connection gracefully. The module
 * also maintains a module-level exit handler so the connection is closed
 * cleanly even if the caller forgets.
 */
export interface DaemonClient {
  call(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  close(): void;
}

// ---------------------------------------------------------------------------
// Internal connection class
// ---------------------------------------------------------------------------

class DaemonConnection implements DaemonClient {
  private readonly socket: net.Socket;
  /** In-flight requests indexed by request_id. */
  private readonly pending = new Map<string, {
    resolve: (result: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private lineBuffer = '';
  private closed = false;

  constructor(socket: net.Socket) {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('close', () => this.onClose());
    socket.on('error', (err: Error) => this.onError(err));

    // Register this as the active connection for the module-level exit handler.
    _activeConnection = this;
  }

  call(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = DEFAULT_CALL_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error('DaemonClient: connection is closed'));
    }

    const requestId = randomUUID();
    const wire: WireRequest = { request_id: requestId, method, params };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(
          `DaemonClient: call to "${method}" timed out after ${timeoutMs}ms`,
        ));
      }, timeoutMs);

      this.pending.set(requestId, { resolve, reject, timer });

      try {
        this.socket.write(JSON.stringify(wire) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Clear module-level reference so the exit handler no longer references us.
    if (_activeConnection === this) _activeConnection = null;
    // Reject all in-flight calls so their callers don't hang.
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('DaemonClient: connection closed'));
    }
    this.pending.clear();
    try {
      this.socket.destroy();
    } catch {
      /* best-effort */
    }
  }

  // -------------------------------------------------------------------------
  // Socket event handlers
  // -------------------------------------------------------------------------

  private onData(chunk: string): void {
    this.lineBuffer += chunk;
    let nl: number;
    while ((nl = this.lineBuffer.indexOf('\n')) !== -1) {
      const line = this.lineBuffer.slice(0, nl).trim();
      this.lineBuffer = this.lineBuffer.slice(nl + 1);
      if (line.length > 0) this.processLine(line);
    }
  }

  private processLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Malformed server response — nothing we can correlate.
      return;
    }

    if (typeof parsed !== 'object' || parsed === null) return;

    const resp = parsed as WireResponse;
    const requestId = (resp as Record<string, unknown>)['request_id'];
    if (typeof requestId !== 'string') return;

    const entry = this.pending.get(requestId);
    if (!entry) return; // spurious or already timed out

    clearTimeout(entry.timer);
    this.pending.delete(requestId);

    if (isErrorResponse(resp)) {
      entry.reject(
        new Error(`daemon error [${resp.error.code}]: ${resp.error.message}`),
      );
    } else {
      entry.resolve((resp as WireResultResponse).result);
    }
  }

  private onClose(): void {
    if (!this.closed) {
      this.closed = true;
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error('DaemonClient: socket closed unexpectedly'));
      }
      this.pending.clear();
    }
  }

  private onError(err: Error): void {
    if (!this.closed) {
      this.closed = true;
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(err);
      }
      this.pending.clear();
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers: connect attempt
// ---------------------------------------------------------------------------

/**
 * Determine whether a connect error code means "daemon not started yet"
 * (i.e., a transient condition where we should retry after spawning).
 */
function isRetryableConnectError(code: string | undefined): boolean {
  return code === 'ENOENT' || code === 'ECONNREFUSED';
}

/** Build the bind target based on platform (matches daemon/index.ts logic). */
function getConnectTarget(): net.NetConnectOpts {
  if (process.platform === 'win32') {
    const config = getConfig();
    const port = config.daemon?.tcpPort ?? DEFAULT_DAEMON_TCP_PORT;
    return { host: '127.0.0.1', port };
  }
  return { path: getDaemonSocketPath() };
}

/**
 * Attempt a single connection to the daemon socket.
 * Resolves with a connected `net.Socket` on success.
 * Rejects with the underlying error on failure.
 */
function tryConnect(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const target = getConnectTarget();
    const socket = net.createConnection(target);
    socket.once('connect', () => {
      socket.removeAllListeners('error');
      resolve(socket);
    });
    socket.once('error', (err) => {
      socket.destroy();
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Spawn daemon
// ---------------------------------------------------------------------------

/**
 * Spawn the daemon as a detached background process and immediately unref it
 * so it outlives the CLI process.
 *
 * Uses `process.execPath` (the running Node binary) rather than a PATH lookup
 * to avoid binary-injection risks.
 */
function spawnDaemon(): void {
  const entry = getDaemonEntryPath();
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

// ---------------------------------------------------------------------------
// connectDaemon (public API)
// ---------------------------------------------------------------------------

/**
 * Options for `connectDaemon`. Primarily useful in tests.
 */
export interface ConnectDaemonOptions {
  /**
   * Override the function used to spawn the daemon process.
   * Defaults to the production `spawnDaemon()` which uses `child_process.spawn`.
   * Tests inject a function that starts an in-process echo server instead.
   */
  _spawnOverride?: () => void;
}

/**
 * Return a connected {@link DaemonClient}, spawning the daemon first if it
 * is not yet running.
 *
 * Flow:
 *  1. Try to connect. Success → return.
 *  2. ENOENT / ECONNREFUSED → spawn daemon (or `_spawnOverride`), then retry
 *     with exponential backoff.
 *  3. After 5 s of retries: throw with a pointer to daemon.log.
 *  4. Any other connect error: propagate immediately (don't retry).
 */
export async function connectDaemon(
  options: ConnectDaemonOptions = {},
): Promise<DaemonClient> {
  const doSpawn = options._spawnOverride ?? spawnDaemon;

  // First attempt — no spawn yet.
  try {
    const socket = await tryConnect();
    return new DaemonConnection(socket);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!isRetryableConnectError(code)) {
      throw err;
    }
  }

  // Daemon is not running — spawn it.
  doSpawn();

  // Retry loop with exponential backoff.
  const deadline = Date.now() + SPAWN_TIMEOUT_MS;
  let delay = INITIAL_RETRY_DELAY_MS;

  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 1000); // cap individual delay at 1 s

    try {
      const socket = await tryConnect();
      return new DaemonConnection(socket);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!isRetryableConnectError(code)) {
        throw err;
      }
      // Retryable — loop continues until deadline.
    }
  }

  throw new Error(
    `daemon failed to start; check ${getDaemonLogPath()}`,
  );
}
