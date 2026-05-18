/**
 * `think daemon` — lifecycle commands for the resident think daemon.
 *
 * Subcommands:
 *   start   Start the daemon (no-op if already running; --foreground to run in current shell)
 *   stop    Send the shutdown RPC and wait up to 5s for the daemon to exit
 *   status  Print running/stale state + pid + socket path
 *
 * Note: `--socket-path` is intentionally absent from all three subcommands.
 * `stop` and `status` gate on `isDaemonRunning()`, which reads the default PID
 * file. Until `isDaemonRunning()` accepts a custom PID-file path, a daemon
 * started with a custom socket could not be stopped or checked — so the flag
 * would create a half-working interface. Deferred to AGT-287+.
 */

import path from 'node:path';
import os from 'node:os';
import { Command, Option } from 'commander';

/** Compute the default socket path without importing daemon/index.ts. */
function defaultSocketPath(): string {
  const override = process.env.THINK_HOME;
  return path.join(override || path.join(os.homedir(), '.think'), 'daemon.sock');
}

// ---------------------------------------------------------------------------
// `think daemon start`
// ---------------------------------------------------------------------------

const startSubcommand = new Command('start')
  .description(
    'Start the think daemon in the background; no-op if already running. ' +
    'Pass --foreground to run in the current shell (required for process supervisors). ' +
    'BEHAVIORAL NOTE: prior versions ran in the foreground by default; v3 defaults to ' +
    'background. Scripts that relied on `think daemon start` blocking must pass --foreground.',
  )
  .option(
    '--foreground',
    'Run the daemon in the current shell instead of spawning in the background.',
  )
  // --socket-path is deferred: stop/status gate on isDaemonRunning() which reads
  // the default PID file; until that accepts a custom path, a custom-socket daemon
  // cannot be stopped or checked. Keep the option as hidden+deprecated to give a
  // clear message rather than Commander's generic "unknown option" error.
  .addOption(
    new Option('--socket-path <path>')
      .hideHelp()
      .default(undefined),
  )
  .action(async (opts: { foreground?: boolean; socketPath?: string }) => {
    if (opts.socketPath) {
      process.stderr.write(
        `error: --socket-path is not yet supported; stop/status cannot locate a custom-socket daemon until pid-file path override is implemented\n`,
      );
      process.exit(1);
      return;
    }
    const { isDaemonRunning } = await import('../lib/daemon-status.js');
    const status = isDaemonRunning();

    if (status.running) {
      // Already running — exit 0 per AC #2.
      process.stdout.write(`daemon already running (pid=${status.pid})\n`);
      return;
    }

    if (opts.foreground) {
      // Run in the current process (foreground mode).
      const socketPath = defaultSocketPath();
      const { runDaemon } = await import('../daemon/index.js');
      await runDaemon({ foreground: true, socketPath });
    } else {
      // Background spawn via the connect-helper (handles spawn + retry).
      const { connectDaemon } = await import('../lib/daemon-client.js');
      const client = await connectDaemon().catch((err: unknown) => {
        process.stderr.write(
          `error: could not start daemon — ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
        return undefined;
      });
      if (!client) return;
      client.close();
      process.stdout.write(`daemon started\n`);
    }
  });

// ---------------------------------------------------------------------------
// `think daemon stop`
// ---------------------------------------------------------------------------

const stopSubcommand = new Command('stop')
  .description('Send the shutdown RPC to the daemon and wait up to 5s for it to exit.')
  .action(async () => {
    const { isDaemonRunning } = await import('../lib/daemon-status.js');
    const { connectDaemon, probeDaemon } = await import('../lib/daemon-client.js');
    const status = isDaemonRunning();

    // PID file is the primary signal, but a daemon running without a PID file
    // (e.g. crash-restart with no rewrite, supervisor edge case, manual rm of
    // the pid file) is still reachable on the socket. If we declared no-op
    // here, the user would see success while the daemon kept running — which
    // is worse than a delayed shutdown. Probe the socket as a fallback.
    // `enteredViaProbe` toggles the poll-loop exit signal: when entry was via
    // probe, we must also confirm via probe (PID file never existed).
    let enteredViaProbe = false;
    if (!status.running) {
      const socketAlive = await probeDaemon(500);
      if (!socketAlive) {
        // Idempotent: mirror `start`'s already-running exit 0 contract.
        process.stdout.write(`daemon not running (no-op)\n`);
        return;
      }
      enteredViaProbe = true;
    }

    // Connect and issue the shutdown RPC.
    const client = await connectDaemon().catch((err: unknown) => {
      process.stderr.write(
        `error: could not connect to daemon — ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
      return undefined;
    });
    if (!client) return;

    try {
      await client.call('shutdown', {}, 5000);
    } catch (err: unknown) {
      // The daemon often closes the socket before the response arrives — expected;
      // these cases fall through to the poll loop because the shutdown likely landed.
      //
      // Unexpected errors (not socket-close/ECONNRESET/EPIPE) mean the shutdown RPC
      // was not delivered. Exit immediately rather than polling: the daemon may still
      // be running, and polling would give a confusing success message.
      const msg = err instanceof Error ? err.message : String(err);
      const isExpected =
        msg.includes('socket closed') ||
        msg.includes('connection closed') ||
        msg.includes('ECONNRESET') ||
        msg.includes('EPIPE');
      if (!isExpected) {
        client.close();
        process.stderr.write(`error: shutdown RPC failed — ${msg}\n`);
        process.exit(1);
        return;
      }
    } finally {
      client.close();
    }

    // Wait up to 5 s for the daemon process to exit. Exit signal depends on
    // how we entered: PID-file disappearance is authoritative when we started
    // from a PID-file-running daemon; socket-probe failure is the only signal
    // available when we entered via probe (no PID file at any point).
    const deadline = Date.now() + 5000;
    const POLL_MS = 100;

    while (Date.now() < deadline) {
      const after = isDaemonRunning();
      if (!after.running) {
        if (!enteredViaProbe) {
          process.stdout.write(`daemon stopped\n`);
          return;
        }
        const stillAlive = await probeDaemon(200);
        if (!stillAlive) {
          process.stdout.write(`daemon stopped\n`);
          return;
        }
      }
      await new Promise<void>((r) => setTimeout(r, POLL_MS));
    }

    process.stderr.write(
      `error: daemon did not exit cleanly within 5s — use \`kill <pid>\` to force-terminate\n`,
    );
    process.exit(1);
  });

// ---------------------------------------------------------------------------
// `think daemon status`
// ---------------------------------------------------------------------------

const statusSubcommand = new Command('status')
  .description(
    'Print the current running state, pid, socket path, and (when available) uptime and version. ' +
    'Output is provisional key=value lines; machine-parseable --json support is planned. ' +
    'FORMAT NOTE: prior versions printed prose (`daemon running (pid N)`). v3 emits ' +
    'key=value lines (`pid=N`, `socket=…`, `status=running`); existing parsers must update.',
  )
  .action(async () => {
    const { isDaemonRunning } = await import('../lib/daemon-status.js');
    const { connectDaemon, probeDaemon } = await import('../lib/daemon-client.js');
    const status = isDaemonRunning();

    // PID file is the primary signal, with a socket-probe fallback so a daemon
    // running without a PID file is still visible. `pid=unknown` is emitted in
    // that case to signal the partial state without breaking the key=value
    // contract.
    let pidLine: string;
    if (status.running) {
      pidLine = `pid=${status.pid}`;
    } else {
      const socketAlive = await probeDaemon(500);
      if (!socketAlive) {
        process.stderr.write(`error: daemon is not running — run 'think daemon start' to start it\n`);
        process.exit(1);
        return;
      }
      pidLine = `pid=unknown`;
    }

    const socketPath = defaultSocketPath();

    // These three lines are always emitted regardless of RPC outcome.
    // Output format: provisional key=value lines (unstable until --json lands, AGT-287+).
    // `status=running` is emitted on ALL paths so scripts can exact-match it.
    process.stdout.write(`${pidLine}\n`);
    process.stdout.write(`socket=${socketPath}\n`);
    process.stdout.write(`status=running\n`);

    // Try the `status` RPC (AGT-287 may not be landed yet — degrade gracefully).
    // `rpc=unavailable(...)` is added only when the RPC is unreachable.
    try {
      const client = await connectDaemon();
      let rpcResult: unknown;
      try {
        rpcResult = await client.call('status', {}, 5000);
      } finally {
        client.close();
      }

      // AGT-287 result shape: { uptime_ms, version, queue_depths, ... }
      const r = (typeof rpcResult === 'object' && rpcResult !== null)
        ? rpcResult as Record<string, unknown>
        : {};

      if (r['uptime_ms'] !== undefined) {
        const uptimeSec = Math.floor(Number(r['uptime_ms']) / 1000);
        process.stdout.write(`uptime=${uptimeSec}s\n`);
      }
      if (r['version'] !== undefined) {
        // Sanitize: strip newlines to preserve key=value output integrity.
        const version = String(r['version']).split('\n')[0];
        process.stdout.write(`version=${version}\n`);
      }
    } catch (err: unknown) {
      // Graceful degradation: if the `status` method doesn't exist yet (METHOD_NOT_FOUND),
      // or the RPC connection fails, emit rpc=unavailable and keep going.
      //
      // DaemonConnection.processLine (daemon-client.ts) throws a plain Error with the
      // message format `daemon error [<CODE>]: <message>`. Until the client surfaces a
      // typed DaemonRpcError with a `.code` property on this code path, we match the
      // literal bracket-wrapped code in the message. The exact format is stable and
      // unit-tested in tests/lib/daemon-client.test.ts.
      //
      // Strip newlines from the error message: multi-line Node errors (e.g. ECONNRESET
      // with a stack trace) would corrupt the key=value output format.
      const rawMsg = err instanceof Error ? err.message : String(err);
      // Take the first line only: Node error messages can include multi-line
      // stack traces that would corrupt the key=value output format.
      const msg = rawMsg.split('\n')[0];
      const isNoEndpoint = msg.includes('[METHOD_NOT_FOUND]');
      const rpcDetail = isNoEndpoint ? 'no status endpoint' : msg;
      // `rpc=unavailable` is a scalar anchor; rpc_detail carries the human-readable
      // reason. Note: rpc_detail values may contain spaces (e.g. Node error messages);
      // the format is provisional until --json lands.
      process.stdout.write(`rpc=unavailable\n`);
      process.stdout.write(`rpc_detail=${rpcDetail}\n`);
    }
  });

// ---------------------------------------------------------------------------
// Top-level `think daemon` group
// ---------------------------------------------------------------------------

export const daemonCommand = new Command('daemon')
  .description('Manage the think resident daemon process')
  .addCommand(startSubcommand)
  .addCommand(stopSubcommand)
  .addCommand(statusSubcommand);
