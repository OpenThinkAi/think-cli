import { Command } from 'commander';
import chalk from 'chalk';
import { getEntries, getEntriesByWeek, type Entry } from '../db/queries.js';
import { getMemories, type MemoryRow } from '../db/memory-queries.js';
import { closeDb } from '../db/client.js';
import { closeCortexDb } from '../db/engrams.js';
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

function formatMemory(row: MemoryRow): string {
  const ts = row.ts.slice(0, 16).replace('T', ' ');
  const badge = chalk.green(`[${row.kind ?? 'memory'}]`.padEnd(12));
  return `${chalk.gray(ts)}  ${badge} ${row.content}`;
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
      // Read from the cortex entry store (memories/events/retros). AGT-1303
      // repointed this off the retired engrams table.
      if (opts.category || opts.tag) {
        console.log(chalk.yellow('Note: --category and --tag filters are not supported for cortex entries.'));
      }

      let since: Date | undefined;
      let until: Date | undefined;
      if (opts.week) {
        since = startOfWeek(new Date(), { weekStartsOn: 1 });
      } else if (opts.lastWeek) {
        const lastWeekDate = subWeeks(new Date(), 1);
        since = startOfWeek(lastWeekDate, { weekStartsOn: 1 });
        until = endOfWeek(lastWeekDate, { weekStartsOn: 1 });
      } else {
        if (opts.since) since = new Date(opts.since);
        if (opts.until) until = new Date(opts.until);
      }

      const rows = getMemories(cortex, {
        since: since?.toISOString(),
        until: until?.toISOString(),
        limit: parseInt(opts.limit, 10),
      });

      if (rows.length === 0) {
        console.log(chalk.dim('No entries found.'));
      } else {
        for (const row of rows) {
          console.log(formatMemory(row));
        }
        console.log(chalk.dim(`\n${rows.length} entries`));
      }

      closeCortexDb(cortex);
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
