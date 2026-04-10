import { Command } from 'commander';
import chalk from 'chalk';
import { getEntries, getEntriesByWeek, type Entry } from '../db/queries.js';
import { generateSummary } from '../lib/claude.js';
import { closeDb } from '../db/client.js';

function formatRaw(entries: Entry[]): string {
  return entries
    .map((e) => {
      const ts = e.timestamp.slice(0, 16).replace('T', ' ');
      const tags = e.tags !== '[]' ? ` [${e.tags}]` : '';
      return `${ts}  [${e.category}]  ${e.content}${tags}`;
    })
    .join('\n');
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
  .action(async (opts: {
    week?: boolean;
    lastWeek?: boolean;
    since?: string;
    until?: string;
    category?: string;
    tag?: string;
    raw?: boolean;
  }) => {
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
      // Default to current week
      entries = getEntriesByWeek(0);
    }

    // Apply category/tag filters for week-based queries too
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
  });
