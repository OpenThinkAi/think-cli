import path from 'node:path';
import os from 'node:os';
import { Command } from 'commander';

/**
 * `think daemon` — lifecycle commands for the resident think daemon.
 *
 * This file is the CLI stub for AGT-278. Only `start` is wired up today.
 * `stop` and `status` land in downstream tickets.
 */

/** Compute the default socket path here to avoid a static import of daemon/index.ts
 * (which would defeat the lazy `await import(...)` in the action handler). */
function defaultSocketPath(): string {
  const override = process.env.THINK_HOME;
  return path.join(override || path.join(os.homedir(), '.think'), 'daemon.sock');
}

const startSubcommand = new Command('start')
  .description(
    'Run the think daemon. Background mode is coming soon; the default is foreground.',
  )
  .option(
    '--foreground',
    'Write logs to stderr and keep the process in the foreground (current default)',
  )
  .option('--socket-path <path>', 'Unix socket path (default: $THINK_HOME/daemon.sock or ~/.think/daemon.sock)')
  .action(async (opts: { foreground: boolean | undefined; socketPath?: string }) => {
    // Lazy-import keeps daemon/index.ts out of the startup parse path for all
    // other `think` commands. No static import of daemon/index.ts in this file.
    const { runDaemon } = await import('../daemon/index.js');
    await runDaemon({
      // Default to foreground until socket binding lands.
      foreground: opts.foreground ?? true,
      socketPath: opts.socketPath ?? defaultSocketPath(),
    });
  });

export const daemonCommand = new Command('daemon')
  .description('Manage the think resident daemon process')
  .addCommand(startSubcommand);
