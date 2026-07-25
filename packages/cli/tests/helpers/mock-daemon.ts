/**
 * In-process mock daemon for command/lib tests.
 *
 * Starts a `net.Server` on a Unix socket speaking the daemon's JSON-line RPC
 * protocol, so tests exercise the real socket path without spawning an
 * external process. `handlers` maps method names to fixed response values or
 * zero-arg handler functions; unknown methods get a METHOD_NOT_FOUND error,
 * matching the real daemon's behavior.
 *
 * Shared by tests/commands/daemon-command.test.ts and
 * tests/lib/daemon-drift.test.ts — keep protocol changes here, in one place.
 */

import net from 'node:net';

export function startMockDaemon(
  socketPath: string,
  handlers: Record<string, unknown>,
): Promise<{ close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const sockets: net.Socket[] = [];
    const server = net.createServer((socket) => {
      sockets.push(socket);
      let buf = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let req: Record<string, unknown>;
          try { req = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
          const method = String(req['method']);
          const handler = handlers[method];
          let result: unknown;
          if (typeof handler === 'function') {
            result = (handler as (p: Record<string, unknown>) => unknown)(
              (req['params'] ?? {}) as Record<string, unknown>,
            );
          } else if (handler !== undefined) {
            result = handler;
          } else {
            const errResp = JSON.stringify({
              request_id: req['request_id'],
              error: { code: 'METHOD_NOT_FOUND', message: `unknown method: ${method}` },
            });
            socket.write(errResp + '\n');
            continue;
          }
          socket.write(
            JSON.stringify({ request_id: req['request_id'], result }) + '\n',
          );
        }
      });
      socket.on('error', () => { /* client hangup — ignore */ });
    });

    server.listen(socketPath, () => resolve({
      close: () =>
        new Promise<void>((res) => {
          for (const s of sockets) try { s.destroy(); } catch { /* */ }
          server.close(() => res());
        }),
    }));

    server.once('error', reject);
  });
}
