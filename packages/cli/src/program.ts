import { Command } from 'commander';
import { readPackageVersion } from './lib/version.js';
import { syncCommand } from './commands/log.js';
import { listCommand } from './commands/list.js';
import { summaryCommand } from './commands/summary.js';
import { deleteCommand } from './commands/delete.js';
import { supersessionCommand } from './commands/supersession.js';
import { exportCommand } from './commands/export.js';
import { importCommand } from './commands/import.js';
import { initCommand } from './commands/init.js';
import { auditCommand } from './commands/audit.js';
import { cortexCommand } from './commands/cortex.js';
import { recallCommand } from './commands/recall.js';
import { memoryCommand } from './commands/memory.js';
import { pullCommand } from './commands/pull.js';
import { pauseCommand, resumeCommand } from './commands/pause.js';
import { configCommand } from './commands/config-cmd.js';
import { updateCommand } from './commands/update.js';
import { migrateEngramsCommand } from './commands/migrate-engrams.js';
import { longTermCommand } from './commands/long-term.js';
import { serveCommand } from './commands/serve.js';
import { subscribeCommand } from './commands/subscribe.js';
import { retroCommand } from './commands/retro.js';
import { retroMigrateCommand } from './commands/retro-migrate.js';
import { eventCommand } from './commands/event.js';
import { curateRetrosCommand } from './commands/curate-retros.js';
import { briefCommand } from './commands/brief.js';
import { daemonCommand } from './commands/daemon.js';
import { reindexCommand } from './commands/reindex.js';
import { hookCommand } from './commands/hook.js';
import { mcpCommand } from './commands/mcp.js';
import { usageCommand } from './commands/usage.js';
import { dashboardCommand } from './commands/dashboard.js';
import { doctorCommand } from './commands/doctor.js';
import { refreshBlocksInternalCommand } from './commands/refresh-blocks-internal.js';
import { curateCommand, monitorCommand, curatorCommand, migrateDataCommand, logCommand } from './commands/removed-commands.js';
import { reportPendingHeal } from './lib/heal-summary.js';

/**
 * Builds the `think` commander program exactly as production registers it —
 * every command, in the same order, with the same hidden/visible flags — but
 * with no side effects: no path migration, no `.parse()`. `src/index.ts` is
 * the sole production caller; `scripts/gen-command-table.ts` (AGT-1311) is
 * the other, so the generated README table is always read off the live
 * registry rather than a hand-maintained mirror of it that can drift.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name('think')
    .description('Local-first CLI tool for capturing notes, work logs, and ideas')
    .version(readPackageVersion())
    .option('-C, --cortex <name>', 'Use a specific cortex for this command');

  program.addCommand(syncCommand);
  program.addCommand(listCommand);
  program.addCommand(summaryCommand);
  program.addCommand(deleteCommand);
  program.addCommand(supersessionCommand);
  program.addCommand(exportCommand);
  program.addCommand(importCommand);
  program.addCommand(initCommand);
  program.addCommand(auditCommand);
  program.addCommand(cortexCommand);
  program.addCommand(recallCommand);
  program.addCommand(memoryCommand);
  program.addCommand(pullCommand);
  program.addCommand(pauseCommand);
  program.addCommand(resumeCommand);
  program.addCommand(configCommand);
  program.addCommand(updateCommand);
  program.addCommand(migrateEngramsCommand);
  program.addCommand(longTermCommand);
  program.addCommand(serveCommand);
  program.addCommand(subscribeCommand);
  program.addCommand(retroCommand);
  program.addCommand(retroMigrateCommand);
  program.addCommand(eventCommand);
  program.addCommand(curateRetrosCommand);
  program.addCommand(briefCommand);
  program.addCommand(daemonCommand);
  program.addCommand(reindexCommand);
  program.addCommand(hookCommand);
  program.addCommand(mcpCommand);
  program.addCommand(usageCommand);
  program.addCommand(dashboardCommand);
  program.addCommand(doctorCommand);
  // Plumbing for `think update` (AGT-1306) — never user-facing, so hidden from
  // --help. See commands/refresh-blocks-internal.ts.
  program.addCommand(refreshBlocksInternalCommand, { hidden: true });

  // think-3 (AGT-1325): commands AGT-1303 deleted outright. Re-registered
  // hidden (excluded from --help, the generated command table, and the
  // vocabulary lint's scanned surfaces) so typing one gets our own one-line
  // removal pointer instead of commander's generic "unknown command". See
  // commands/removed-commands.ts.
  program.addCommand(curateCommand, { hidden: true });
  program.addCommand(monitorCommand, { hidden: true });
  program.addCommand(curatorCommand, { hidden: true });
  program.addCommand(migrateDataCommand, { hidden: true });
  program.addCommand(logCommand, { hidden: true });

  // AGT-1307 — the first interactive command after a self-heal prints its
  // one-time summary. Runs before every command's own action; see
  // lib/heal-summary.ts for what gets skipped (daemon subcommands, --json,
  // refresh-blocks-internal) and why.
  program.hook('preAction', (_thisCommand, actionCommand) => {
    reportPendingHeal(actionCommand);
  });

  return program;
}
