import { Command } from 'commander';
import { readPackageVersion } from './lib/version.js';
import { logCommand, syncCommand } from './commands/log.js';
import { listCommand } from './commands/list.js';
import { summaryCommand } from './commands/summary.js';
import { deleteCommand } from './commands/delete.js';
import { exportCommand } from './commands/export.js';
import { importCommand } from './commands/import.js';
import { initCommand } from './commands/init.js';
import { auditCommand } from './commands/audit.js';
import { cortexCommand } from './commands/cortex.js';
import { curateCommand } from './commands/curate.js';
import { monitorCommand } from './commands/monitor.js';
import { recallCommand } from './commands/recall.js';
import { memoryCommand } from './commands/memory.js';
import { curatorCommand } from './commands/curator-cmd.js';
import { pullCommand } from './commands/pull.js';
import { pauseCommand, resumeCommand } from './commands/pause.js';
import { configCommand } from './commands/config-cmd.js';
import { updateCommand } from './commands/update.js';
import { migrateDataCommand } from './commands/migrate-data.js';
import { longTermCommand } from './commands/long-term.js';
import { serveCommand } from './commands/serve.js';
import { subscribeCommand } from './commands/subscribe.js';

const program = new Command();

program
  .name('think')
  .description('Local-first CLI tool for capturing notes, work logs, and ideas')
  .version(readPackageVersion())
  .option('-C, --cortex <name>', 'Use a specific cortex for this command');

program.addCommand(logCommand);
program.addCommand(syncCommand);
program.addCommand(listCommand);
program.addCommand(summaryCommand);
program.addCommand(deleteCommand);
program.addCommand(exportCommand);
program.addCommand(importCommand);
program.addCommand(initCommand);
program.addCommand(auditCommand);
program.addCommand(cortexCommand);
program.addCommand(curateCommand);
program.addCommand(monitorCommand);
program.addCommand(recallCommand);
program.addCommand(memoryCommand);
program.addCommand(curatorCommand);
program.addCommand(pullCommand);
program.addCommand(pauseCommand);
program.addCommand(resumeCommand);
program.addCommand(configCommand);
program.addCommand(updateCommand);
program.addCommand(migrateDataCommand);
program.addCommand(longTermCommand);
program.addCommand(serveCommand);
program.addCommand(subscribeCommand);

program.parse();
