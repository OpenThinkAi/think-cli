import path from 'node:path';
import os from 'node:os';
import { Command } from 'commander';

/**
 * `think daemon` — lifecycle commands for the resident think daemon.
 *
 * This file is the CLI stub for AGT-278. Only `start` is wired up today.
 * `stop` and `status` land in downstream tickets.
 */

/** Compute the default socket path without importing daemon/index.ts so the
 * lazy `await import(...)` in the action handler is not defeated. */
function defaultSocketPath(): string {
  const override = process.env.THINK_HOME;
  return path.join(override || path.join(os.homedir(), '.think'), 'daemon.sock');
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

export const daemonCommand = new Command('daemon')
  .description('Manage the think resident daemon process')
  .addCommand(startSubcommand);
