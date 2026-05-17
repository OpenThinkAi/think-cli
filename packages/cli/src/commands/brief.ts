import { existsSync } from 'node:fs';
import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig } from '../lib/config.js';
import { closeCortexDb } from '../db/engrams.js';
import { searchRetros, bumpRecallStats } from '../db/retro-queries.js';
import { getIndexDbPath } from '../lib/paths.js';
import { renderPersonalAll } from './recall.js';
import { pullForRead } from '../lib/auto-propagate.js';

export const briefCommand = new Command('brief')
  .description('Task-start brief: personal-cortex memories + repo-cortex retros')
  .argument('[query]', 'Optional search query forwarded to both sections')
  .option('--cortex <name>', 'Repo cortex to read retros from (required)')
  .option('--days <n>', 'Days of personal memories to include', '14')
  .option('--limit <n>', 'Max retros to return', '20')
  .option('--no-sync', 'Skip auto pull-on-read (debugging / offline use)')
  .addHelpText('after', `
Scope:
  Combines two sources into one task-start context dump:
    1. Personal context — memories and long-term events from your active
       cortex (same output as: think recall --all).
    2. Retros — promoted observations from the named repo cortex
       (same as: think retro recall --cortex <name>).

  --cortex is required. It identifies the repo/tool cortex for retros;
  your active personal cortex is always used for memories regardless of
  --cortex. The target cortex must already exist (created on first retro
  emission via: think retro "..." --cortex <name>).

  Agents: run at task start to inherit prior lessons for a codebase.

Examples:
  think brief --cortex fx-tracker
  think brief "migrations" --cortex my-repo
  think brief --cortex think-cli --days 7
`)
  .action(async function (this: Command, query: string | undefined, opts: {
    cortex?: string;
    days: string;
    limit: string;
    sync: boolean;
  }) {
    const globalOpts = this.optsWithGlobals() as { cortex?: string };
    const targetCortex = opts.cortex ?? globalOpts.cortex;

    if (!targetCortex) {
      console.error(chalk.red('think brief: --cortex is required.'));
      console.error(chalk.red('Pass it as: think brief --cortex <name>  or  think -C <name> brief'));
      process.exitCode = 1;
      return;
    }

    const config = getConfig();
    const activeCortex = config.cortex?.active;

    if (!activeCortex) {
      console.error(chalk.red('No active cortex. Run: think cortex switch <name>'));
      process.exitCode = 1;
      return;
    }

    if (!existsSync(getIndexDbPath(targetCortex))) {
      console.error(chalk.red(`think brief: no cortex named "${targetCortex}" exists. Cortexes are created on first retro emission.`));
      process.exitCode = 1;
      return;
    }

    try {
      await pullForRead(targetCortex, { skip: !opts.sync });
    } catch {
      // Degrade silently; brief renders whatever's locally available
    }

    const days = parseInt(opts.days, 10);
    const limit = parseInt(opts.limit, 10);

    console.log(chalk.cyan.bold('Personal context:'));
    console.log();
    renderPersonalAll(activeCortex, { days, query });
    closeCortexDb(activeCortex);

    console.log(chalk.cyan.bold(`Retros for [${targetCortex}]:`));
    console.log();
    const retros = searchRetros(targetCortex, { query, limit });

    if (retros.length === 0) {
      console.log(chalk.dim(`  no retros found for ${targetCortex}`));
      console.log();
    } else {
      for (const r of retros) {
        const ts = chalk.gray(r.created_at.slice(0, 10));
        const kindLabel = r.kind ? chalk.dim(` [${r.kind}]`) : '';
        const occLabel = r.occurrences > 1 ? chalk.dim(` (×${r.occurrences})`) : '';
        console.log(`  ${ts}${kindLabel}${occLabel} ${r.content}`);
      }
      console.log();
      bumpRecallStats(targetCortex, retros.map(r => r.id));
    }

    closeCortexDb(targetCortex);
  });
