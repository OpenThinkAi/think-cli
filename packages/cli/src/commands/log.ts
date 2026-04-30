import { Command } from 'commander';
import { spawn } from 'node:child_process';
import chalk from 'chalk';
import { insertEntry } from '../db/queries.js';
import { closeDb } from '../db/client.js';
import { getConfig } from '../lib/config.js';
import { insertEngram, getPendingEngrams } from '../db/engram-queries.js';
import { closeCortexDb } from '../db/engrams.js';
import { checkForUpdate } from '../lib/update-check.js';
import { validateEngramContent } from '../lib/sanitize.js';

export const logCommand = new Command('log')
  .description('Log a note or entry')
  .argument('<message>', 'The message to log')
  .option('-s, --source <source>', 'Source of the entry', 'manual')
  .option('-c, --category <category>', 'Category: note, sync, meeting, decision, idea', 'note')
  .option('-t, --tags <tags>', 'Comma-separated tags')
  .option('--silent', 'Suppress output')
  .action((message: string, opts: { source: string; category: string; tags?: string; silent?: boolean }) => {
    const validated = validateEngramContent(message);
    message = validated.content;
    if (!opts.silent && validated.warnings.length > 0) {
      for (const w of validated.warnings) {
        console.log(chalk.yellow(`  ⚠ ${w}`));
      }
    }

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
  .option('-e, --episode <key>', 'Tag this engram with an episode identifier')
  .option('--context <json>', 'Attach structured JSON metadata to this engram')
  .option('-d, --decision <text>', 'Record a decision (repeatable)', (val: string, prev: string[]) => [...prev, val], [] as string[])
  .option('--silent', 'Suppress output')
  .action(function (this: Command, message: string, opts: { source: string; tags?: string; episode?: string; context?: string; decision?: string[]; silent?: boolean }) {
    const globalOpts = this.optsWithGlobals() as { cortex?: string };
    const config = getConfig();

    if (config.paused) {
      // Silently skip — don't break CLAUDE.md auto-logging
      return;
    }

    const cortex = globalOpts.cortex ?? config.cortex?.active;

    if (cortex) {
      // Validate and sanitize content before storage
      const validated = validateEngramContent(message);
      message = validated.content;
      if (!opts.silent && validated.warnings.length > 0) {
        for (const w of validated.warnings) {
          console.log(chalk.yellow(`  ⚠ ${w}`));
        }
      }

      // Validate --context is valid JSON if provided
      if (opts.context) {
        try {
          JSON.parse(opts.context);
        } catch {
          console.error(chalk.red('Error: --context must be valid JSON'));
          process.exitCode = 1;
          return;
        }
      }

      // Route to cortex engram DB
      const decisions = opts.decision?.length ? opts.decision : undefined;
      const engram = insertEngram(cortex, { content: message, episodeKey: opts.episode, context: opts.context, decisions });

      if (!opts.silent) {
        const badge = chalk.cyan(`[${cortex}]`);
        const ts = chalk.gray(engram.created_at.slice(0, 16).replace('T', ' '));
        const episodeLabel = opts.episode ? chalk.dim(` (episode: ${opts.episode})`) : '';
        console.log(`${chalk.green('✓')} ${badge} engram saved ${ts}${episodeLabel}`);
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
          closeCortexDb(cortex);
          // Use process.execPath + process.argv[1] so it works regardless of how think was invoked
          spawn(process.execPath, [process.argv[1], 'curate'], { detached: true, stdio: 'ignore' }).unref();
          return;
        }
      }

      closeCortexDb(cortex);
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
