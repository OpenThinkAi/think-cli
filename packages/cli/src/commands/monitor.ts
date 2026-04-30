import { Command } from 'commander';
import chalk from 'chalk';
import { subDays } from 'date-fns';
import { getConfig } from '../lib/config.js';
import { getEngrams } from '../db/engram-queries.js';
import { closeCortexDb } from '../db/engrams.js';

export const monitorCommand = new Command('monitor')
  .description('Show what got promoted to memory vs. dropped')
  .option('--days <n>', 'Days to look back', '7')
  .action((opts: { days: string }) => {
    const config = getConfig();
    const cortex = config.cortex?.active;

    if (!cortex) {
      console.error(chalk.red('No active cortex. Run: think cortex switch <name>'));
      process.exit(1);
    }

    const days = parseInt(opts.days, 10);
    const since = subDays(new Date(), days);
    const engrams = getEngrams(cortex, { since });

    if (engrams.length === 0) {
      console.log(chalk.dim(`No engrams in the last ${days} days.`));
      closeCortexDb(cortex);
      return;
    }

    let promoted = 0;
    let dropped = 0;
    let pending = 0;

    for (const e of engrams) {
      const ts = e.created_at.slice(0, 16).replace('T', ' ');
      const content = e.content.length > 80 ? e.content.slice(0, 77) + '...' : e.content;

      if (e.promoted === null) {
        console.log(`${chalk.yellow('?')} ${chalk.gray(ts)}  ${content}`);
        pending++;
      } else if (e.promoted === 1) {
        console.log(`${chalk.green('✓')} ${chalk.gray(ts)}  ${content}`);
        promoted++;
      } else {
        console.log(`${chalk.dim('✗')} ${chalk.gray(ts)}  ${chalk.dim(content)}`);
        dropped++;
      }
    }

    console.log();
    console.log(`${engrams.length} total: ${chalk.green(`${promoted} promoted`)}, ${chalk.dim(`${dropped} dropped`)}, ${chalk.yellow(`${pending} pending`)}`);

    closeCortexDb(cortex);
  });
