import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { Command } from 'commander';
import { probeDaemon } from '../lib/daemon-client.js';
import { isDaemonRunning } from '../lib/daemon-status.js';

/**
 * `think daemon` — lifecycle commands for the resident think daemon.
 *
 * This file is the CLI stub for AGT-278. Only `start` is wired up today.
 * `stop` and `status` land in downstream tickets.
 *
 * AGT-289: `status` subcommand added — reports daemon state or spawn-failure
 * reason (last 20 lines of daemon.log) when daemon is unavailable.
 */

/** Compute the default socket path without importing daemon/index.ts so the
 * lazy `await import(...)` in the action handler is not defeated. */
function defaultSocketPath(): string {
  const override = process.env.THINK_HOME;
  return path.join(override || path.join(os.homedir(), '.think'), 'daemon.sock');
}

function defaultLogPath(): string {
  const override = process.env.THINK_HOME;
  return path.join(override || path.join(os.homedir(), '.think'), 'daemon.log');
}

const startSubcommand = new Command('start')
  .description('Start the think daemon in the foreground.')
  .option('--socket-path <path>', 'Unix socket path (default: $THINK_HOME/daemon.sock or ~/.think/daemon.sock)')
  .action(async (opts: { socketPath?: string }) => {
    // Lazy-import keeps daemon/index.ts out of the startup parse path for all
    // other `think` commands. No static import of daemon/index.ts in this file.
    const { runDaemon } = await import('../daemon/index.js');
    await runDaemon({
      foreground: true, // only supported mode until socket binding lands (AGT-279)
      socketPath: opts.socketPath ?? defaultSocketPath(),
    });
  });

/**
 * `think daemon status` — AGT-289
 *
 * Reports whether the daemon is running. On spawn failure, surfaces the last
 * 20 lines of daemon.log so the user can see the failure reason without
 * having to find the log file manually.
 *
 * Exit codes: 0 = running, 1 = stopped.
 * Primary status line always goes to stdout (scriptable).
 * Log tail (diagnostic detail) goes to stderr.
 */
const statusSubcommand = new Command('status')
  .description('Show whether the think daemon is running.')
  .action(async () => {
    const logPath = defaultLogPath();

    // First: check PID file for a definitive "running" answer.
    const pidStatus = isDaemonRunning();
    if (pidStatus.running) {
      console.log(`daemon running (pid ${pidStatus.pid})`);
      return;
    }

    // PID file absent or stale — probe the socket without spawning.
    const socketAlive = await probeDaemon(500);
    if (socketAlive) {
      console.log('daemon running (socket responding; no PID file)');
      return;
    }

    // Daemon is not running. Primary status line on stdout; log tail on stderr.
    console.log('daemon stopped');

    // Show last 20 lines of daemon.log to help diagnose why it stopped.
    let logTail: string;
    try {
      const content = fs.readFileSync(logPath, 'utf8');
      const lines = content.split('\n');
      logTail = lines.slice(-20).join('\n').trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      logTail = '';
    }

    if (logTail) {
      console.error(`last log (${logPath}):`);
      console.error(logTail);
    } else {
      console.error(`no log output found (${logPath} is empty or missing)`);
    }
    process.exitCode = 1;
  });

export const daemonCommand = new Command('daemon')
  .description('Manage the think resident daemon process')
  .addCommand(startSubcommand)
  .addCommand(statusSubcommand);
