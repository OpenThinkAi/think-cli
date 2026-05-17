import { Command } from 'commander';

/**
 * `think daemon` — lifecycle commands for the resident think daemon.
 *
 * This file is the CLI stub for AGT-278. Only `start` is wired up today.
 * `stop` and `status` land in downstream tickets (AGT-279+).
 */

const startSubcommand = new Command('start')
  .description(
    'Run the think daemon in the current shell (for development / debugging). ' +
      'Use --foreground to keep the process attached to the terminal and log to stderr.',
  )
  .option('--foreground', 'Stay attached to the terminal; log to stderr instead of daemon.log')
  .option('--socket-path <path>', 'Override the default Unix socket path')
  .action(async (opts: { foreground: boolean; socketPath?: string }) => {
    // Lazy-import keeps cold-start cost for other commands minimal.
    const { runDaemon } = await import('../daemon/index.js');
    await runDaemon({
      foreground: opts.foreground,
      socketPath: opts.socketPath,
    });
  });

export const daemonCommand = new Command('daemon')
  .description('Manage the think resident daemon process')
  .addCommand(startSubcommand);
