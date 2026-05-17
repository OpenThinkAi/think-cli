import { Command } from 'commander';
import { getDefaultSocketPath } from '../daemon/index.js';

/**
 * `think daemon` — lifecycle commands for the resident think daemon.
 *
 * This file is the CLI stub for AGT-278. Only `start` is wired up today.
 * `stop` and `status` land in downstream tickets (AGT-279+).
 */

const startSubcommand = new Command('start')
  .description(
    'Run the think daemon. Pass --foreground to keep the process attached to the terminal ' +
      '(the only functional mode until socket binding lands).',
  )
  .option('--foreground', 'Write logs to stderr and keep the process in the foreground')
  .option(
    '--socket-path <path>',
    'Override the Unix socket path (respects $THINK_HOME)',
  )
  .action(async (opts: { foreground: boolean | undefined; socketPath?: string }) => {
    // Lazy-import keeps cold-start cost for other commands minimal.
    const { runDaemon } = await import('../daemon/index.js');
    await runDaemon({
      foreground: opts.foreground ?? false,
      socketPath: opts.socketPath ?? getDefaultSocketPath(),
    });
  });

export const daemonCommand = new Command('daemon')
  .description('Manage the think resident daemon process')
  .addCommand(startSubcommand);
