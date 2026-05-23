/**
 * Proxy-subscribe WS client — AGT-311
 *
 * If `config.proxy.url` is set, opens a WebSocket connection to the proxy
 * and listens for push notifications from accessible cortexes.
 *
 * Wire protocol (incoming message from proxy):
 *   { "type": "push", "cortex": "<name>", "commit_sha": "<sha>" }
 *
 * On receipt of a push message, calls `onPush(cortex, commit_sha)` so the
 * daemon can interrupt the polling backoff and fetch immediately.
 *
 * Reconnects on disconnect with exponential backoff. If the proxy is
 * unreachable from startup, logs a warning and falls back to polling.
 *
 * Security properties:
 * - URL validated to ws:// or wss:// before use; userinfo stripped from logs.
 * - Incoming messages capped at MAX_MESSAGE_BYTES (1 KB) to prevent DoS.
 * - JSON is parsed only after the size check.
 * - All external-origin strings (cortex, commit_sha, close reason) are
 *   stripped of CR/LF before log interpolation to prevent log injection.
 * - The onPush consumer is responsible for validating `cortex` against a
 *   known-good allowlist before using it in any path or command construction
 *   (a compromised proxy can supply arbitrary cortex strings).
 */

import { getConfig } from '../lib/config.js';
import { isValidProxyUrl, redactUrl } from '../lib/proxy-url.js';
import { daemonLog } from './log.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Initial reconnect delay in milliseconds. */
export const RECONNECT_INITIAL_MS = 1_000;
/** Reconnect delay multiplier applied after each failure. */
export const RECONNECT_MULTIPLIER = 2;
/** Maximum reconnect delay cap in milliseconds. */
export const RECONNECT_MAX_MS = 60_000;

/** Maximum accepted byte-length for an incoming WS message (1 KB). */
const MAX_MESSAGE_BYTES = 1_024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Called when a push notification arrives from the proxy. */
export type OnPushCallback = (cortex: string, commitSha: string) => void;

/** Handle returned by startProxySubscribe; call stop() to tear down. */
export interface ProxySubscribeHandle {
  stop(): void;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Write a timestamped proxy-subscribe line to both stderr and daemon.log. */
function log(level: 'INFO' | 'WARN' | 'DEBUG', msg: string): void {
  daemonLog('proxy-subscribe', `${level}: ${msg}`);
}

/**
 * Strip CR and LF characters from a string before interpolating it into
 * a log line. Prevents log-injection by a malicious or compromised proxy
 * that sends field values containing embedded newlines.
 */
function stripNewlines(s: string): string {
  return s.replace(/[\r\n]/g, ' ');
}

// ---------------------------------------------------------------------------
// startProxySubscribe
// ---------------------------------------------------------------------------

/**
 * Starts the proxy-subscribe WS client.
 *
 * If `config.proxy.url` is not set (or blank) or has an invalid scheme,
 * returns immediately with a no-op handle (polling-only fallback).
 * If the connection fails from startup, logs a WARN and retries with
 * exponential backoff (not a no-op — the returned handle is the live retry
 * handle and should be passed to shutdown's stop() call).
 *
 * Note: `getConfig()` is called once at invocation time. Changes to
 * `proxy.url` in the config file require a daemon restart to take effect.
 *
 * @param onPush  Called on each `{ type: "push", cortex, commit_sha }` message.
 *                Wire to `triggerImmediatePull(cortex)` from AGT-310 when that
 *                export lands; defaults to no-op until then.
 *                IMPORTANT: validate `cortex` against a known-good allowlist
 *                before passing it to any path or git operation — the value
 *                comes from the proxy (external network party).
 */
export function startProxySubscribe(onPush: OnPushCallback): ProxySubscribeHandle {
  const config = getConfig();
  const proxyUrl = config.proxy?.url?.trim() ?? '';

  if (!proxyUrl) {
    log('DEBUG', 'proxy.url not configured — proxy-subscribe disabled (polling only)');
    return { stop() {} };
  }

  if (!isValidProxyUrl(proxyUrl)) {
    log('WARN', `proxy.url is not a valid ws:// or wss:// URL (got: ${JSON.stringify(proxyUrl)}) — proxy-subscribe disabled`);
    return { stop() {} };
  }

  const logUrl = redactUrl(proxyUrl);

  let stopped = false;
  let ws: WebSocket | null = null;
  let reconnectDelayMs = RECONNECT_INITIAL_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function connect(): void {
    if (stopped) return;

    log('DEBUG', `connecting to proxy at ${logUrl}`);

    let socket: WebSocket;
    try {
      socket = new WebSocket(proxyUrl);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log('WARN', `failed to construct WebSocket (url=${logUrl}): ${errMsg} — will retry`);
      scheduleReconnect();
      return;
    }

    ws = socket;

    socket.addEventListener('open', () => {
      log('INFO', `connected to proxy at ${logUrl}`);
      // Reset backoff on successful connection.
      reconnectDelayMs = RECONNECT_INITIAL_MS;
    });

    socket.addEventListener('message', (event: MessageEvent) => {
      handleMessage(event.data);
    });

    socket.addEventListener('error', (event: Event) => {
      // WebSocket error events carry no useful message in Node.js; log minimal info.
      const errMsg = (event as ErrorEvent).message ?? '(no detail)';
      log('WARN', `WebSocket error: ${errMsg}`);
    });

    socket.addEventListener('close', (event: CloseEvent) => {
      ws = null;
      if (stopped) return;
      const safeReason = stripNewlines(event.reason || '(none)');
      log('WARN', `disconnected from proxy (code=${event.code}, reason=${safeReason}) — scheduling reconnect in ${reconnectDelayMs}ms`);
      scheduleReconnect();
    });
  }

  function handleMessage(data: unknown): void {
    // Enforce message size limit before parsing.
    const raw = typeof data === 'string' ? data : (data instanceof Buffer ? data.toString('utf8') : null);
    if (raw === null) {
      log('WARN', 'received non-string WS message — ignoring');
      return;
    }
    if (Buffer.byteLength(raw, 'utf8') > MAX_MESSAGE_BYTES) {
      log('WARN', `received oversized message (>${MAX_MESSAGE_BYTES} bytes) — ignoring`);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log('WARN', 'received non-JSON WS message — ignoring');
      return;
    }

    if (typeof parsed !== 'object' || parsed === null) {
      log('WARN', 'received non-object JSON WS message — ignoring');
      return;
    }

    const msg = parsed as Record<string, unknown>;

    if (msg['type'] !== 'push') {
      // Unknown message type — silently ignore (forward-compat).
      return;
    }

    const cortex = msg['cortex'];
    const commitSha = msg['commit_sha'];

    if (typeof cortex !== 'string' || cortex.length === 0) {
      log('WARN', 'push message missing or invalid "cortex" field — ignoring');
      return;
    }
    if (typeof commitSha !== 'string' || commitSha.length === 0) {
      log('WARN', 'push message missing or invalid "commit_sha" field — ignoring');
      return;
    }

    // Format guards at the trust boundary — values come from an external
    // network party and must not be forwarded raw to path/git operations.
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(cortex)) {
      log('WARN', 'push message "cortex" field failed format check — ignoring');
      return;
    }
    // Accept SHA-1 (40 hex) or SHA-256 (64 hex).
    if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(commitSha)) {
      log('WARN', 'push message "commit_sha" field failed format check — ignoring');
      return;
    }

    if (stopped) return;
    log('DEBUG', `push notification: cortex=${stripNewlines(cortex)} commit=${stripNewlines(commitSha)}`);
    try {
      onPush(cortex, commitSha);
    } catch (errCaught) {
      const errMsg = errCaught instanceof Error ? errCaught.message : String(errCaught);
      log('WARN', `onPush callback threw: ${errMsg}`);
    }
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    const delay = reconnectDelayMs;
    // Advance backoff for next failure, capped at max.
    reconnectDelayMs = Math.min(reconnectDelayMs * RECONNECT_MULTIPLIER, RECONNECT_MAX_MS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  // Start the initial connection attempt.
  connect();

  return {
    stop(): void {
      stopped = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws !== null) {
        try {
          ws.close();
        } catch {
          // best-effort
        }
        ws = null;
      }
    },
  };
}
