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
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getThinkDir } from './paths.js';
import { getConfig } from './config.js';
import { DEFAULT_DAEMON_TCP_PORT } from './daemon-constants.js';
import { isDaemonRunning } from './daemon-status.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default per-call timeout in milliseconds. */
const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/** Initial retry delay in milliseconds (doubles on each attempt). */
const INITIAL_RETRY_DELAY_MS = 50;

/**
 * Maximum total time to wait for the daemon to start (milliseconds).
 *
 * The daemon now blocks "ready" until the embedding model is loaded
 * (Xenova/bge-small-en-v1.5, ~34s even with cached files). Set to 90s
 * to give plenty of headroom for slow machines and first-run downloads.
 * This is the spawn-timeout only — the per-call timeout (DEFAULT_CALL_TIMEOUT_MS)
 * is unchanged at 30s and governs individual RPC round-trips.
 *
 * @internal — exported for tests that assert a minimum value; do not rely on
 *             this in production code.
 */
export const SPAWN_TIMEOUT_MS = 90_000;

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
 * Path to the spawn-mutex lockfile (issue #60).
 *
 * Held by a CLI process that is mid-spawn. Concurrent CLI calls inspect this
 * file (via {@link tryAcquireSpawnLock}) to decide whether to skip spawning
 * and just wait for the in-progress daemon to come up.
 */
function getDaemonSpawnLockPath(): string {
  return path.join(getThinkDir(), 'daemon.spawn.lock');
}

/**
 * Resolve the daemon entry path given the directory of the calling module.
 *
 * Walks candidate directories outward from `thisDir` looking for the
 * `@openthink/think` `package.json` sentinel, then returns
 * `<pkg-root>/dist/daemon/index.js`. Name-pinning is required because the
 * monorepo workspace root has its own `package.json` that we must NOT match.
 *
 * Layouts handled:
 *   - bundled (`dist/daemon-client-HASH.js`):  thisDir=dist/   → ../package.json
 *   - dev source (`src/lib/daemon-client.ts`): thisDir=src/lib → ../../package.json
 *
 * Exported for testing; runtime callers use `getDaemonEntryPath()` below.
 * Mirrors the pattern in `version.ts`'s `readPackageVersion`.
 */
export function resolveDaemonEntryFromDir(thisDir: string): string {
  const candidates = [
    path.join(thisDir, '..'),             // dist/<file>.js, src/<file>.ts
    path.join(thisDir, '..', '..'),       // dist/<dir>/<file>.js, src/<dir>/<file>.ts
    path.join(thisDir, '..', '..', '..'), // src/<dir>/<dir>/<file>.ts
  ];
  for (const root of candidates) {
    const manifest = path.join(root, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(manifest, 'utf-8')) as { name?: string };
      if (parsed.name === '@openthink/think') {
        return path.join(root, 'dist', 'daemon', 'index.js');
      }
    } catch {
      // unreadable / not JSON — try next candidate
    }
  }
  throw new Error(
    `could not locate @openthink/think package root from ${thisDir} — install may be corrupted`,
  );
}

/** Absolute path to the daemon entry point in the compiled `dist/` tree. */
export function getDaemonEntryPath(): string {
  // fileURLToPath is the correct ESM replacement for __dirname — it strips
  // the Windows drive-letter slash that `.pathname` leaves behind.
  const thisFile = fileURLToPath(import.meta.url);
  return resolveDaemonEntryFromDir(path.dirname(thisFile));
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
    const requestId = resp.request_id;
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
      if (_activeConnection === this) _activeConnection = null;
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
      if (_activeConnection === this) _activeConnection = null;
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(err);
      }
      this.pending.clear();
    }
  }
}

// ---------------------------------------------------------------------------
// DaemonUnavailableError — AGT-289
// ---------------------------------------------------------------------------

/**
 * Thrown by `connectDaemon()` when the daemon could not be spawned or did not
 * become reachable within the 5-second timeout.
 *
 * Callers should catch this and fall back to degraded-mode direct DB access
 * rather than aborting. The `logPath` field points to the daemon log file for
 * diagnostics.
 */
export class DaemonUnavailableError extends Error {
  /** Absolute path to the daemon log file (always ~/{THINK_HOME}/daemon.log). */
  readonly logPath: string;

  constructor(message: string, logPath: string) {
    super(message);
    this.name = 'DaemonUnavailableError';
    this.logPath = logPath;
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
// Spawn mutex (issue #60)
//
// Two concurrent `think` invocations during the ~30s embed-model warmup window
// would both see the socket unresponsive and both spawn a daemon. Only one wins
// the bind; the loser would still go through warmup, write its PID file over
// the winner's, and — in edge cases where bind contention races with socket
// chmod — could even unlink the winner's socket. Hence the orphan leak.
//
// The mutex is a simple atomic O_EXCL lockfile at ~/.think/daemon.spawn.lock
// containing "<pid>:<timestamp_ms>". A second CLI that arrives during the spawn
// window sees the lock and skips its spawn step, dropping into the retry loop
// to wait for the in-flight daemon. Stale locks (holder PID dead, or older than
// SPAWN_TIMEOUT_MS) are reclaimed.
// ---------------------------------------------------------------------------

/**
 * Result of {@link tryAcquireSpawnLock}.
 *
 * `acquired` means this caller now owns the lock and must spawn the daemon.
 * `held-by-other` means another CLI is already spawning; skip the spawn step.
 */
type SpawnLockResult =
  | { kind: 'acquired'; release: () => void }
  | { kind: 'held-by-other' };

/**
 * Parse a spawn-lock file's content into pid + timestamp, or null if corrupt.
 * Format: "<pid>:<timestamp_ms>" — one line.
 */
function parseSpawnLock(raw: string): { pid: number; timestampMs: number } | null {
  const [pidStr, tsStr] = raw.trim().split(':');
  const pid = parseInt(pidStr ?? '', 10);
  const timestampMs = parseInt(tsStr ?? '', 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return null;
  return { pid, timestampMs };
}

/**
 * Is a lock stale? A lock is stale when the holder PID is dead OR the
 * timestamp is older than `staleAfterMs`. Corrupt locks are treated as stale.
 */
function isSpawnLockStale(
  lockPath: string,
  staleAfterMs: number,
  now: number = Date.now(),
): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (err: unknown) {
    // ENOENT here means the file vanished between the caller's O_EXCL EEXIST
    // and our readFileSync (very tight TOCTOU window). Return false ("not
    // stale") so the caller does NOT attempt to unlink — the file is already
    // gone, and the caller returns `held-by-other`, letting the retry loop
    // pick up whichever daemon is coming up. Conservative and safe.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    // Unreadable for any other reason — assume stale so we can recover.
    return true;
  }

  const parsed = parseSpawnLock(raw);
  if (parsed === null) return true;

  if (now - parsed.timestampMs > staleAfterMs) return true;

  // PID liveness via kill(pid, 0). ESRCH → dead → stale. EPERM → alive (we
  // just can't signal it). Any other error → treat as stale to avoid wedging.
  try {
    process.kill(parsed.pid, 0);
    return false; // alive
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return false; // alive, just not ours
    return true; // ESRCH or anything else
  }
}

/**
 * Try to atomically acquire the spawn lock.
 *
 * Returns `{ kind: 'acquired', release }` if this caller now owns the lock.
 * The caller is then responsible for spawning the daemon and calling
 * `release()` once it has either successfully connected or given up.
 *
 * Returns `{ kind: 'held-by-other' }` if another live CLI holds the lock —
 * the caller should NOT spawn; it should wait in the retry loop for the
 * holder's daemon to come up.
 *
 * @param staleAfterMs Age beyond which a lock is considered stale and reclaimed.
 *                     Should match SPAWN_TIMEOUT_MS so we never wait longer for
 *                     a lock than the retry loop is willing to wait for a socket.
 */
function tryAcquireSpawnLock(staleAfterMs: number): SpawnLockResult {
  const lockPath = getDaemonSpawnLockPath();
  const dir = path.dirname(lockPath);
  fs.mkdirSync(dir, { recursive: true });

  const content = `${process.pid}:${Date.now()}\n`;

  // Up to two tries: first attempt, then one reclaim-after-stale retry.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try {
        fs.writeSync(fd, content);
      } finally {
        fs.closeSync(fd);
      }
      // We hold the lock. Build the release closure.
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        try {
          // Only unlink if the file is still ours. Best-effort PID check —
          // if it's already been reclaimed by a stale-sweep, we just leave it.
          const raw = fs.readFileSync(lockPath, 'utf8');
          const parsed = parseSpawnLock(raw);
          if (parsed && parsed.pid === process.pid) {
            fs.unlinkSync(lockPath);
          }
        } catch {
          // ENOENT or unreadable — nothing to clean up.
        }
      };
      return { kind: 'acquired', release };
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        // Permission error or full disk — fall back to "held by other" so the
        // caller waits rather than crashing. The retry loop will surface a
        // clearer error if the daemon never comes up.
        return { kind: 'held-by-other' };
      }
      // EEXIST: check staleness and possibly reclaim.
      if (attempt === 0 && isSpawnLockStale(lockPath, staleAfterMs)) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Lost the reclaim race — another CLI got there first. Treat as held.
          return { kind: 'held-by-other' };
        }
        continue; // retry the create
      }
      return { kind: 'held-by-other' };
    }
  }
  return { kind: 'held-by-other' };
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
 *
 * Throws immediately if the compiled daemon entry point does not exist,
 * so the caller gets an actionable error instead of silently exhausting
 * the 5-second retry loop with an empty daemon.log.
 */
function spawnDaemon(): void {
  const entry = getDaemonEntryPath();
  if (!fs.existsSync(entry)) {
    throw new DaemonUnavailableError(
      `daemon binary not found at ${entry} — run \`npm run build\` first`,
      getDaemonLogPath(),
    );
  }
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
   *
   * @internal — test-injection seam only; do not use in production code.
   */
  _spawnOverride?: () => void;

  /**
   * Override the total retry window in ms.
   * Defaults to SPAWN_TIMEOUT_MS (90s). Tests that expect a quick failure can
   * pass a smaller value (e.g. 500) so they don't wait 90s.
   *
   * @internal — test-injection seam only.
   */
  _spawnTimeoutOverride?: number;
}

/**
 * Return a connected {@link DaemonClient}, spawning the daemon first if it
 * is not yet running.
 *
 * Flow:
 *  1. Try to connect. Success → return.
 *  2. ENOENT / ECONNREFUSED → check whether a daemon is already alive
 *     (PID file) or another CLI is mid-spawn (spawn lock). Spawn only if
 *     neither is true.
 *  3. Retry connect with exponential backoff for up to SPAWN_TIMEOUT_MS.
 *  4. After timeout: throw with a pointer to daemon.log.
 *  5. Any non-retryable connect error: propagate immediately.
 *
 * Issue #60: prior versions spawned a daemon on every cache miss, so two
 * concurrent CLI calls during the embed-model warmup window both spawned —
 * producing orphan daemons that ran background loops (compaction queue,
 * pull loop, embed model) independently of the supervised daemon.
 */
export async function connectDaemon(
  options: ConnectDaemonOptions = {},
): Promise<DaemonClient> {
  const doSpawn = options._spawnOverride ?? spawnDaemon;
  const spawnTimeout = options._spawnTimeoutOverride ?? SPAWN_TIMEOUT_MS;

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

  // Two pre-spawn checks to prevent the orphan-leak race (#60):
  //   1. PID file says a daemon is alive → it's mid-warmup, just wait for
  //      its socket. No spawn needed.
  //   2. Spawn lock says another CLI is already spawning → wait for it.
  // Only if neither check fires do we spawn ourselves.
  let lockRelease: (() => void) | null = null;
  const pidStatus = isDaemonRunning();
  if (!pidStatus.running) {
    const lock = tryAcquireSpawnLock(spawnTimeout);
    if (lock.kind === 'acquired') {
      lockRelease = lock.release;
      try {
        doSpawn();
      } catch (spawnErr) {
        // Spawn failed before we even entered the retry loop — release the
        // lock so subsequent CLIs can try again, then re-throw.
        lockRelease();
        throw spawnErr;
      }
    }
    // else: another CLI is spawning. Fall through to the retry loop.
  }
  // else: a daemon process exists. Fall through to the retry loop.

  try {
    // Retry loop with exponential backoff.
    const deadline = Date.now() + spawnTimeout;
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

    throw new DaemonUnavailableError(
      `daemon failed to start; check ${getDaemonLogPath()}`,
      getDaemonLogPath(),
    );
  } finally {
    // Release the spawn lock regardless of success/failure so subsequent CLIs
    // don't have to wait out staleAfterMs to retry. No-op if we didn't hold it.
    lockRelease?.();
  }
}

// ---------------------------------------------------------------------------
// probeDaemon — non-spawning availability check (AGT-289)
// ---------------------------------------------------------------------------

/**
 * Probe whether the daemon socket is currently accepting connections WITHOUT
 * spawning the daemon if it isn't running.
 *
 * Returns `true` if a connection is established (daemon is up).
 * Returns `false` if the socket is absent, refuses connections, or doesn't
 * respond within `timeoutMs` (default: 500 ms).
 *
 * Use this for any "check if daemon is available" path (status command,
 * degraded-mode detection) to avoid the implicit side-effect of starting the
 * daemon. Use `connectDaemon()` only when you intend to actually use the
 * daemon for real work.
 *
 * @remarks Used by CLI commands and tests only; not part of the daemon wire protocol API.
 */
export async function probeDaemon(timeoutMs: number = 500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const target = getConnectTarget();
    const socket = net.createConnection(target);
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(false);
      }
    }, timeoutMs);

    socket.once('connect', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(true);
      }
    });

    socket.once('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(false);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// AGT-280 compatibility: simple one-shot daemonRpc + DaemonRpcError
// ---------------------------------------------------------------------------

/**
 * Structured error returned by the daemon in an error response.
 * Used by `daemonRpc` — callers can branch on `err.code`.
 */
export class DaemonRpcError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DaemonRpcError';
  }
}

/**
 * Send one RPC call to the think daemon and return the result.
 *
 * Opens a fresh connection, sends one request, awaits the matching response,
 * then closes the socket. For persistent connections across multiple calls
 * in a single CLI invocation, prefer `connectDaemon()`.
 *
 * @throws {DaemonRpcError}  when the daemon returns an error response.
 * @throws {Error}           when the connection fails or the socket closes
 *                           before a matching response is received.
 */
export async function daemonRpc(
  method: string,
  params: Record<string, unknown> = {},
  opts: {
    /** Override the socket path (useful in tests). */
    socketPath?: string;
    /** Connect + response timeout in ms. Default: 5000. */
    timeoutMs?: number;
  } = {},
): Promise<unknown> {
  const socketPath = opts.socketPath ?? getDaemonSocketPath();
  const timeoutMs = opts.timeoutMs ?? 5000;
  const requestId = randomUUID();

  return new Promise<unknown>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });

    let settled = false;
    let buffer = '';

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new Error(`daemonRpc: timed out after ${timeoutMs}ms waiting for response to ${method}`));
      }
    }, timeoutMs);

    function settle(fn: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    }

    socket.on('connect', () => {
      const payload = JSON.stringify({ request_id: requestId, method, params }) + '\n';
      socket.write(payload);
    });

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');

      // Process all complete lines.
      let nlIdx: number;
      while ((nlIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nlIdx).trim();
        buffer = buffer.slice(nlIdx + 1);

        if (line.length === 0) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          // Ignore unparseable lines and keep waiting.
          continue;
        }

        if (typeof parsed !== 'object' || parsed === null) continue;

        const obj = parsed as Record<string, unknown>;
        // NOTE: framing-level errors (payload_too_large, parse_error) arrive
        // with request_id "" because the line's id is unknown at framing time.
        // Those responses never match `requestId` and are silently skipped;
        // the caller sees a timeout rather than the framing error code.
        // In practice the client always sends well-formed sub-1MB requests,
        // so this path is unreachable in normal operation.
        if (obj['request_id'] !== requestId) continue;

        // This line is our response.
        if ('error' in obj) {
          const err = obj['error'] as { code?: string; message?: string };
          settle(() =>
            reject(new DaemonRpcError(err.code ?? 'unknown_error', err.message ?? 'daemon error')),
          );
        } else if ('result' in obj) {
          settle(() => resolve(obj['result']));
        } else {
          settle(() =>
            reject(new Error(`daemonRpc: malformed response — no result or error field`)),
          );
        }
        return;
      }
    });

    socket.on('error', (err: Error) => {
      settle(() => reject(err));
    });

    socket.on('close', () => {
      settle(() =>
        reject(new Error(`daemonRpc: socket closed before receiving response to ${method}`)),
      );
    });
  });
}
