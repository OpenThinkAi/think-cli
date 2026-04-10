import { Command } from 'commander';
import chalk from 'chalk';
import { insertEntry } from '../db/queries.js';
import { closeDb } from '../db/client.js';

export const logCommand = new Command('log')
  .description('Log a note or entry')
  .argument('<message>', 'The message to log')
  .option('-s, --source <source>', 'Source of the entry', 'manual')
  .option('-c, --category <category>', 'Category: note, sync, meeting, decision, idea', 'note')
  .option('-t, --tags <tags>', 'Comma-separated tags')
  .option('--silent', 'Suppress output')
  .action((message: string, opts: { source: string; category: string; tags?: string; silent?: boolean }) => {
    const tags = opts.tags ? opts.tags.split(',').map(t => t.trim()) : undefined;
    const entry = insertEntry({
      content: message,
      source: opts.source,
      category: opts.category,
      tags,
    });

    if (!opts.silent) {
      const catBadge = chalk.dim(`[${entry.category}]`);
      const ts = chalk.gray(entry.timestamp.slice(0, 16).replace('T', ' '));
      console.log(`${chalk.green('✓')} Logged ${catBadge} ${ts}`);
      console.log(`  ${entry.content}`);
      if (tags && tags.length > 0) {
        console.log(`  ${chalk.cyan('tags:')} ${tags.join(', ')}`);
      }
    }

    closeDb();
  });

export const syncCommand = new Command('sync')
  .description('Log a sync/work-log entry (shorthand for log --category sync)')
  .argument('<message>', 'The message to log')
  .option('-s, --source <source>', 'Source of the entry', 'manual')
  .option('-t, --tags <tags>', 'Comma-separated tags')
  .option('--silent', 'Suppress output')
  .action((message: string, opts: { source: string; tags?: string; silent?: boolean }) => {
    const tags = opts.tags ? opts.tags.split(',').map(t => t.trim()) : undefined;
    const entry = insertEntry({
      content: message,
      source: opts.source,
      category: 'sync',
      tags,
    });

    if (!opts.silent) {
      const catBadge = chalk.dim('[sync]');
      const ts = chalk.gray(entry.timestamp.slice(0, 16).replace('T', ' '));
      console.log(`${chalk.green('✓')} Logged ${catBadge} ${ts}`);
      console.log(`  ${entry.content}`);
      if (tags && tags.length > 0) {
        console.log(`  ${chalk.cyan('tags:')} ${tags.join(', ')}`);
      }
    }

    closeDb();
  });
