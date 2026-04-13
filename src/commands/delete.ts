import { Command } from 'commander';
import chalk from 'chalk';
import { getEntries, deleteEntry, deleteEntriesByContent } from '../db/queries.js';
import { closeDb } from '../db/client.js';

export const deleteCommand = new Command('delete')
  .description('Soft-delete entries (tombstoned, excluded from summaries)')
  .option('--id <id>', 'Delete a specific entry by ID')
  .option('--match <pattern>', 'Delete entries matching a text pattern')
  .option('--last', 'Delete the most recent entry')
  .action(async (opts: { id?: string; match?: string; last?: boolean }) => {
    try {
      if (opts.id) {
        const deleted = deleteEntry(opts.id);
        if (deleted) {
          console.log(chalk.green('✓') + ' Entry deleted');
        } else {
          console.log(chalk.yellow('No matching entry found'));
        }
      } else if (opts.match) {
        const count = deleteEntriesByContent(opts.match);
        console.log(chalk.green('✓') + ` Deleted ${count} entry(ies) matching "${opts.match}"`);
      } else if (opts.last) {
        const entries = getEntries({ limit: 1 });
        if (entries.length === 0) {
          console.log(chalk.yellow('No entries to delete'));
        } else {
          deleteEntry(entries[0].id);
          console.log(chalk.green('✓') + ` Deleted: ${entries[0].content}`);
        }
      } else {
        console.log('Specify --id, --match, or --last. See think delete --help');
      }
      closeDb();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Delete error: ${message}`));
      closeDb();
      process.exit(1);
    }
  });
