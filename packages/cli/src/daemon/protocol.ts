/**
 * JSON-line framing for the think daemon socket protocol — AGT-280
 *
 * Wire format:
 *   request  → { "request_id": "<uuid>", "method": "<string>", "params": {...} }\n
 *   response → { "request_id": "<uuid>", "result": <any> }\n
 *           OR { "request_id": "<uuid>", "error": { "code": "<string>", "message": "<string>" } }\n
 *
 * Invariants:
 *   - One JSON object per line, terminated by \n.
 *   - Per-line limit: 1 MB. Exceeding it returns code "payload_too_large"
 *     and does NOT close the connection.
 *   - Malformed JSON returns code "parse_error" and does NOT close the
 *     connection.
 *   - request_id from the incoming line is always echoed back so a caller
 *     can correlate concurrent requests on a single connection.
 */

import net from 'node:net';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum accepted byte-length per line (1 MiB). */
const MAX_LINE_BYTES = 1 * 1024 * 1024; // 1 MB

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed incoming request from a client. */
export interface DaemonRequest {
  request_id: string;
  method: string;
  params: Record<string, unknown>;
}

/** Successful response payload. */
export interface DaemonResultResponse {
  request_id: string;
  result: unknown;
}

/** Error response payload. */
export interface DaemonErrorResponse {
  request_id: string;
  error: {
    code: string;
    message: string;
  };
}

export type DaemonResponse = DaemonResultResponse | DaemonErrorResponse;

// ---------------------------------------------------------------------------
// sendResponse
// ---------------------------------------------------------------------------

/**
 * Serialize `response` as a single JSON line and write it to `socket`.
 * Fire-and-forget: the socket buffers internally; callers don't await.
 */
export function sendResponse(socket: net.Socket, response: DaemonResponse): void {
  socket.write(JSON.stringify(response) + '\n');
}

// ---------------------------------------------------------------------------
// parseLineFraming
// ---------------------------------------------------------------------------

/**
 * Async iterator that yields one parsed {@link DaemonRequest} per
 * newline-terminated JSON line received on `socket`.
 *
 * Error handling (per AC):
 *   - Lines that exceed MAX_LINE_BYTES get a "payload_too_large" error
 *     response; the buffer is cleared; iteration continues.
 *   - Lines that fail JSON.parse get a "parse_error" error response;
 *     iteration continues.
 *   - If `request_id` is missing/non-string the error is echoed with
 *     request_id="" so the caller can still correlate somewhat.
 *   - Socket close/end/error ends the iteration.
 */
export async function* parseLineFraming(
  socket: net.Socket,
): AsyncGenerator<DaemonRequest> {
  // We accumulate raw bytes; split on \n each time data arrives.
  const chunks: Buffer[] = [];
  let bufferedBytes = 0;
  let tooLarge = false; // current line already exceeded the limit

  // We drive iteration via an async queue backed by a simple resolve chain.
  const queue: Array<DaemonRequest | null> = []; // null = end-of-stream sentinel
  let waiting: ((value: DaemonRequest | null) => void) | null = null;

  function enqueue(item: DaemonRequest | null): void {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(item);
    } else {
      queue.push(item);
    }
  }

  function nextItem(): Promise<DaemonRequest | null> {
    if (queue.length > 0) {
      return Promise.resolve(queue.shift()!);
    }
    return new Promise<DaemonRequest | null>((resolve) => {
      waiting = resolve;
    });
  }

  // ---------------------------------------------------------------------------
  // Line processing
  // ---------------------------------------------------------------------------

  function processLine(lineBuffer: Buffer): void {
    const line = lineBuffer.toString('utf8').trim();
    if (line.length === 0) return;

    // Try to extract request_id even from invalid JSON for error responses.
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendResponse(socket, {
        request_id: '',
        error: { code: 'parse_error', message },
      });
      return;
    }

    if (typeof parsed !== 'object' || parsed === null) {
      sendResponse(socket, {
        request_id: '',
        error: { code: 'parse_error', message: 'expected a JSON object' },
      });
      return;
    }

    const obj = parsed as Record<string, unknown>;
    const requestId = typeof obj['request_id'] === 'string' ? obj['request_id'] : '';

    if (typeof obj['method'] !== 'string') {
      sendResponse(socket, {
        request_id: requestId,
        error: { code: 'invalid_request', message: 'missing or invalid "method" field' },
      });
      return;
    }

    const params =
      typeof obj['params'] === 'object' && obj['params'] !== null
        ? (obj['params'] as Record<string, unknown>)
        : {};

    enqueue({ request_id: requestId, method: obj['method'], params });
  }

  // ---------------------------------------------------------------------------
  // Socket event listeners
  // ---------------------------------------------------------------------------

  function onData(chunk: Buffer): void {
    let offset = 0;

    while (offset < chunk.length) {
      const nl = chunk.indexOf(0x0a /* '\n' */, offset);

      if (nl === -1) {
        // No newline in this chunk — accumulate (or discard if already over limit).
        const remaining = chunk.subarray(offset);
        if (tooLarge || bufferedBytes + remaining.length > MAX_LINE_BYTES) {
          if (!tooLarge) {
            // Send the error once per oversized line.
            // We don't know the request_id because the line isn't complete yet.
            sendResponse(socket, {
              request_id: '',
              error: { code: 'payload_too_large', message: `line exceeds ${MAX_LINE_BYTES} byte limit` },
            });
            tooLarge = true;
          }
          // Drain — don't accumulate; just discard bytes belonging to this line.
          chunks.length = 0;
          bufferedBytes = 0;
        } else {
          chunks.push(remaining);
          bufferedBytes += remaining.length;
        }
        offset = chunk.length;
      } else {
        // Found a newline at position nl.
        const part = chunk.subarray(offset, nl);

        if (tooLarge || bufferedBytes + part.length > MAX_LINE_BYTES) {
          // Overflow — the error was already sent (or we just hit the limit
          // exactly at the newline boundary).
          if (!tooLarge) {
            sendResponse(socket, {
              request_id: '',
              error: { code: 'payload_too_large', message: `line exceeds ${MAX_LINE_BYTES} byte limit` },
            });
          }
          tooLarge = false;
          chunks.length = 0;
          bufferedBytes = 0;
        } else {
          // Assemble the complete line.
          chunks.push(part);
          const lineBuffer = Buffer.concat(chunks);
          chunks.length = 0;
          bufferedBytes = 0;
          processLine(lineBuffer);
        }

        offset = nl + 1;
      }
    }
  }

  function onEnd(): void {
    enqueue(null);
  }

  function onError(): void {
    enqueue(null);
  }

  socket.on('data', onData);
  socket.on('end', onEnd);
  socket.on('error', onError);
  // 'close' fires when socket.destroy() is called locally (no preceding 'end'
  // or 'error'). Without this listener, nextItem() would hang indefinitely and
  // the finally block would never clean up.
  socket.on('close', onEnd);

  try {
    while (true) {
      const item = await nextItem();
      if (item === null) break;
      yield item;
    }
  } finally {
    socket.off('data', onData);
    socket.off('end', onEnd);
    socket.off('error', onError);
    socket.off('close', onEnd);
  }
}

// ---------------------------------------------------------------------------
// Built-in method registry
// ---------------------------------------------------------------------------

export type MethodHandler = (
  params: Record<string, unknown>,
) => Promise<unknown> | unknown;

const builtinMethods: Map<string, MethodHandler> = new Map([
  ['ping', () => 'pong'],
]);

/**
 * Shared empty methods map. Pass as the third argument to `dispatchRequest`
 * when no supplemental handlers are needed, to avoid per-call allocations.
 */
export const NO_EXTRA_METHODS: ReadonlyMap<string, never> = new Map();

/**
 * Dispatch one parsed request to the appropriate handler and write the
 * response back on `socket`.
 *
 * Callers (daemon/index.ts) can pass an additional `methods` map to
 * supplement the built-ins as more API methods land. Pass `NO_EXTRA_METHODS`
 * when no supplemental handlers are needed.
 */
export async function dispatchRequest(
  socket: net.Socket,
  request: DaemonRequest,
  methods: ReadonlyMap<string, MethodHandler> = NO_EXTRA_METHODS,
): Promise<void> {
  const handler = methods.get(request.method) ?? builtinMethods.get(request.method);

  if (!handler) {
    sendResponse(socket, {
      request_id: request.request_id,
      error: { code: 'method_not_found', message: `unknown method: ${request.method}` },
    });
    return;
  }

  try {
    const result = await handler(request.params);
    sendResponse(socket, { request_id: request.request_id, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendResponse(socket, {
      request_id: request.request_id,
      error: { code: 'internal_error', message },
    });
  }
}
