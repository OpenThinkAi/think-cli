/**
 * Shared constants for the think daemon — used by both the daemon process
 * (packages/cli/src/daemon/index.ts) and the CLI client
 * (packages/cli/src/lib/daemon-client.ts).
 *
 * Keeping the TCP port here ensures the server and client always agree on
 * the fallback Windows bind address without duplicating the magic number.
 */

/**
 * Default TCP port for the Windows fallback (loopback-only).
 * Overridable via `config.daemon.tcpPort`.
 */
export const DEFAULT_DAEMON_TCP_PORT = 47821;
