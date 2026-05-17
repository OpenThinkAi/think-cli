/**
 * Daemon RPC client helper — AGT-280
 *
 * Provides a single `daemonRpc(method, params)` call that:
 *   1. Opens a Unix socket connection to the think daemon.
 *   2. Sends one JSON-line request.
 *   3. Reads lines from the socket until it receives the response whose
 *      `request_id` matches the outgoing request.
 *   4. Returns the `result` or throws a `DaemonRpcError`.
 *
 * The function keeps no persistent connection — each call opens + closes
 * a fresh socket. That is intentional for the current scope (AGT-280 framing
 * only). Connection pooling is a downstream concern.
 */

import net from 'node:net';
import { v4 as uuidv4 } from 'uuid';
import { getDaemonSocketPath } from './paths.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Structured error returned by the daemon in an error response. */
export class DaemonRpcError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DaemonRpcError';
  }
}

// ---------------------------------------------------------------------------
// daemonRpc
// ---------------------------------------------------------------------------

/**
 * Send one RPC call to the think daemon and return the result.
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
  const requestId = uuidv4();

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
        if (obj['request_id'] !== requestId) continue;

        // This line is our response.
        if ('error' in obj) {
          const err = obj['error'] as { code?: string; message?: string };
          settle(() =>
            reject(new DaemonRpcError(err.code ?? 'unknown_error', err.message ?? 'daemon error')),
          );
        } else {
          settle(() => resolve(obj['result']));
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
