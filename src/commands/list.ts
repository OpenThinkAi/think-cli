import { Command } from 'commander';
import chalk from 'chalk';
import { getEntries, getEntriesByWeek, type Entry } from '../db/queries.js';
import { getEngrams, type Engram } from '../db/engram-queries.js';
import { closeDb } from '../db/client.js';
import { closeEngramsDb } from '../db/engrams.js';
import { getConfig } from '../lib/config.js';
import { subWeeks, startOfWeek, endOfWeek } from 'date-fns';

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

function formatEngram(engram: Engram): string {
  const ts = engram.created_at.slice(0, 16).replace('T', ' ');
  const badge = chalk.green('[engram]'.padEnd(12));
  return `${chalk.gray(ts)}  ${badge} ${engram.content}`;
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
  .action(function (this: Command, opts: {
    since?: string;
    until?: string;
    category?: string;
    tag?: string;
    limit: string;
    week?: boolean;
    lastWeek?: boolean;
  }) {
    const globalOpts = this.optsWithGlobals() as { cortex?: string };
    const config = getConfig();
    const cortex = globalOpts.cortex ?? config.cortex?.active;

    if (cortex) {
      // Read from cortex engram DB
      let since: Date | undefined;
      if (opts.week) {
        since = startOfWeek(new Date(), { weekStartsOn: 1 });
      } else if (opts.lastWeek) {
        since = startOfWeek(subWeeks(new Date(), 1), { weekStartsOn: 1 });
      } else if (opts.since) {
        since = new Date(opts.since);
      }

      const engrams = getEngrams(cortex, {
        since,
        limit: parseInt(opts.limit, 10),
      });

      if (engrams.length === 0) {
        console.log(chalk.dim('No engrams found.'));
      } else {
        for (const engram of engrams) {
          console.log(formatEngram(engram));
        }
        console.log(chalk.dim(`\n${engrams.length} engrams`));
      }

      closeEngramsDb(cortex);
    } else {
      // Original path — local think.db
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
    }
  });
