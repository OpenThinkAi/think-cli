import { Command } from 'commander';
import chalk from 'chalk';
import { getEntries, getEntriesByWeek, type Entry } from '../db/queries.js';
import { getEngrams, type Engram } from '../db/engram-queries.js';
import { generateSummary } from '../lib/claude.js';
import { closeDb } from '../db/client.js';
import { closeEngramsDb } from '../db/engrams.js';
import { getConfig } from '../lib/config.js';
import { subWeeks, startOfWeek } from 'date-fns';

function formatRaw(entries: Entry[]): string {
  return entries
    .map((e) => {
      const ts = e.timestamp.slice(0, 16).replace('T', ' ');
      const tags = e.tags !== '[]' ? ` [${e.tags}]` : '';
      return `${ts}  [${e.category}]  ${e.content}${tags}`;
    })
    .join('\n');
}

function formatRawEngrams(engrams: Engram[]): string {
  return engrams
    .map((e) => {
      const ts = e.created_at.slice(0, 16).replace('T', ' ');
      return `${ts}  [engram]  ${e.content}`;
    })
    .join('\n');
}

function engramsToEntries(engrams: Engram[]): Entry[] {
  return engrams.map((e) => ({
    id: e.id,
    timestamp: e.created_at,
    source: 'manual',
    category: 'note',
    content: e.content,
    tags: '[]',
  }));
}

export const summaryCommand = new Command('summary')
  .description('Generate a summary of entries (AI-powered or raw)')
  .option('-w, --week', 'Current week (default)')
  .option('--last-week', 'Last week')
  .option('--since <date>', 'Start date (ISO or YYYY-MM-DD)')
  .option('--until <date>', 'End date (ISO or YYYY-MM-DD)')
  .option('-c, --category <category>', 'Filter by category')
  .option('-t, --tag <tag>', 'Filter by tag')
  .option('--raw', 'Skip AI formatting, just dump entries')
  .action(async function (this: Command, opts: {
    week?: boolean;
    lastWeek?: boolean;
    since?: string;
    until?: string;
    category?: string;
    tag?: string;
    raw?: boolean;
  }) {
    const globalOpts = this.optsWithGlobals() as { cortex?: string };
    const config = getConfig();
    const cortex = globalOpts.cortex ?? config.cortex?.active;

    if (cortex) {
      // Read from cortex engram DB
      let since: Date | undefined;
      if (opts.lastWeek) {
        since = startOfWeek(subWeeks(new Date(), 1), { weekStartsOn: 1 });
      } else if (opts.since) {
        since = new Date(opts.since);
      } else {
        since = startOfWeek(new Date(), { weekStartsOn: 1 });
      }

      const engrams = getEngrams(cortex, { since });

      try {
        if (engrams.length === 0) {
          console.log(chalk.dim('No engrams found for the specified period.'));
          return;
        }

        if (opts.raw) {
          console.log(formatRawEngrams(engrams));
          console.log(chalk.dim(`\n${engrams.length} engrams`));
        } else {
          try {
            console.log(chalk.dim('Generating summary...'));
            const summary = await generateSummary(engramsToEntries(engrams));
            console.log(summary);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(chalk.red(`Error generating summary: ${msg}`));
            console.log(chalk.dim('\nFalling back to raw output:\n'));
            console.log(formatRawEngrams(engrams));
          }
        }
      } finally {
        closeEngramsDb(cortex);
      }
    } else {
      // Original path — local think.db
      let entries: Entry[];

      if (opts.lastWeek) {
        entries = getEntriesByWeek(1);
      } else if (opts.since || opts.until) {
        entries = getEntries({
          since: opts.since ? new Date(opts.since) : undefined,
          until: opts.until ? new Date(opts.until) : undefined,
          category: opts.category,
          tag: opts.tag,
        });
      } else {
        entries = getEntriesByWeek(0);
      }

      if ((opts.week || opts.lastWeek || (!opts.since && !opts.until)) && (opts.category || opts.tag)) {
        entries = entries.filter((e) => {
          if (opts.category && e.category !== opts.category) return false;
          if (opts.tag && !e.tags.includes(`"${opts.tag}"`)) return false;
          return true;
        });
      }

      if (entries.length === 0) {
        console.log(chalk.dim('No entries found for the specified period.'));
        closeDb();
        return;
      }

      if (opts.raw) {
        console.log(formatRaw(entries));
        console.log(chalk.dim(`\n${entries.length} entries`));
      } else {
        try {
          console.log(chalk.dim('Generating summary...'));
          const summary = await generateSummary(entries);
          console.log(summary);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(chalk.red(`Error generating summary: ${msg}`));
          console.log(chalk.dim('\nFalling back to raw output:\n'));
          console.log(formatRaw(entries));
        }
      }

      closeDb();
    }
  });
