import { Command } from 'commander';
import chalk from 'chalk';
import { getEntries, getEntriesByWeek, type Entry } from '../db/queries.js';
import { closeDb } from '../db/client.js';

const categoryColors: Record<string, (s: string) => string> = {
  note: chalk.blue,
  sync: chalk.green,
  meeting: chalk.magenta,
  decision: chalk.yellow,
  idea: chalk.cyan,
};

function formatEntry(entry: Entry): string {
  const ts = entry.timestamp.slice(0, 16).replace('T', ' ');
  const colorFn = categoryColors[entry.category] ?? chalk.white;
  const badge = colorFn(`[${entry.category}]`.padEnd(12));
  return `${chalk.gray(ts)}  ${badge} ${entry.content}`;
}

export const listCommand = new Command('list')
  .description('List entries with optional filters')
  .option('--since <date>', 'Show entries since date (ISO or YYYY-MM-DD)')
  .option('--until <date>', 'Show entries until date (ISO or YYYY-MM-DD)')
  .option('-c, --category <category>', 'Filter by category')
  .option('-t, --tag <tag>', 'Filter by tag')
  .option('-n, --limit <n>', 'Max entries to show', '20')
  .option('-w, --week', 'Show current week')
  .option('--last-week', 'Show last week')
  .action((opts: {
    since?: string;
    until?: string;
    category?: string;
    tag?: string;
    limit: string;
    week?: boolean;
    lastWeek?: boolean;
  }) => {
    let entries: Entry[];

    if (opts.week) {
      entries = getEntriesByWeek(0);
    } else if (opts.lastWeek) {
      entries = getEntriesByWeek(1);
    } else {
      entries = getEntries({
        since: opts.since ? new Date(opts.since) : undefined,
        until: opts.until ? new Date(opts.until) : undefined,
        category: opts.category,
        tag: opts.tag,
        limit: parseInt(opts.limit, 10),
      });
    }

    if (entries.length === 0) {
      console.log(chalk.dim('No entries found.'));
    } else {
      for (const entry of entries) {
        console.log(formatEntry(entry));
      }
      console.log(chalk.dim(`\n${entries.length} entries`));
    }

    closeDb();
  });
