import { Command } from 'commander';
import { logCommand, syncCommand } from './commands/log.js';
import { listCommand } from './commands/list.js';
import { summaryCommand } from './commands/summary.js';
import { networkSyncCommand } from './commands/sync-run.js';
import { networkStatusCommand } from './commands/sync-status.js';

const program = new Command();

program
  .name('think')
  .description('Local-first CLI tool for capturing notes, work logs, and ideas with P2P sync')
  .version('0.1.0');

program.addCommand(logCommand);
program.addCommand(syncCommand);
program.addCommand(listCommand);
program.addCommand(summaryCommand);

const networkCommand = new Command('network')
  .description('P2P sync network commands');
networkCommand.addCommand(networkSyncCommand);
networkCommand.addCommand(networkStatusCommand);
program.addCommand(networkCommand);

program.parse();
