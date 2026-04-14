import { Command } from 'commander';
import { spawn } from 'node:child_process';
import chalk from 'chalk';
import { insertEntry } from '../db/queries.js';
import { closeDb } from '../db/client.js';
import { getConfig } from '../lib/config.js';
import { insertEngram, getPendingEngrams } from '../db/engram-queries.js';
import { closeEngramsDb } from '../db/engrams.js';
import { checkForUpdate } from '../lib/update-check.js';

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
  .action(function (this: Command, message: string, opts: { source: string; tags?: string; silent?: boolean }) {
    const globalOpts = this.optsWithGlobals() as { cortex?: string };
    const config = getConfig();

    if (config.paused) {
      // Silently skip — don't break CLAUDE.md auto-logging
      return;
    }

    const cortex = globalOpts.cortex ?? config.cortex?.active;

    if (cortex) {
      // Route to cortex engram DB
      const engram = insertEngram(cortex, { content: message });

      if (!opts.silent) {
        const badge = chalk.cyan(`[${cortex}]`);
        const ts = chalk.gray(engram.created_at.slice(0, 16).replace('T', ' '));
        console.log(`${chalk.green('✓')} ${badge} engram saved ${ts}`);
        console.log(`  ${engram.content}`);
      }

      // Auto-curate if threshold is set and reached
      const curateEveryN = config.cortex?.curateEveryN;
      if (curateEveryN && curateEveryN > 0) {
        const pending = getPendingEngrams(cortex);
        if (pending.length >= curateEveryN) {
          if (!opts.silent) {
            console.log(chalk.dim(`  ${pending.length} pending engrams — triggering curation...`));
          }
          // Close DB before spawning — the child process will open its own connection
          // WAL mode ensures the child can read what we just wrote
          closeEngramsDb(cortex);
          // Use process.execPath + process.argv[1] so it works regardless of how think was invoked
          spawn(process.execPath, [process.argv[1], 'curate'], { detached: true, stdio: 'ignore' }).unref();
          return;
        }
      }

      closeEngramsDb(cortex);
    } else {
      // Original path — local think.db
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
    }

    // Non-blocking update check (cached, runs at most once per 24h)
    if (!opts.silent) {
      const updateMsg = checkForUpdate();
      if (updateMsg) {
        console.log(chalk.yellow(`  ℹ ${updateMsg}`));
      }
    }
  });
