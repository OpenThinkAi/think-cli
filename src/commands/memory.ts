import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig } from '../lib/config.js';
import { getMemories } from '../db/memory-queries.js';
import { closeCortexDb } from '../db/engrams.js';

export const memoryCommand = new Command('memory')
  .description('Show current memories from local store')
  .option('--history', 'Show recent memory timeline')
  .action(async (opts: { history?: boolean }) => {
    const config = getConfig();
    const cortex = config.cortex?.active;

    if (!cortex) {
      console.error(chalk.red('No active cortex. Run: think cortex switch <name>'));
      process.exit(1);
    }

    const memories = getMemories(cortex, { limit: opts.history ? 50 : undefined });

    if (memories.length === 0) {
      console.log(chalk.dim('No memories yet. Run: think curate'));
      closeCortexDb(cortex);
      return;
    }

    if (opts.history) {
      for (const m of memories.reverse()) {
        const ts = m.ts.slice(0, 16).replace('T', ' ');
        const preview = m.content.length > 80 ? m.content.slice(0, 80) + '...' : m.content;
        console.log(`${chalk.gray(ts)}  ${chalk.dim(m.author + ':')} ${preview}`);
      }
    } else {
      for (const m of memories) {
        const ts = m.ts.slice(0, 16).replace('T', ' ');
        console.log(`${chalk.gray(ts)}  ${chalk.dim(m.author + ':')} ${m.content}`);
      }
    }

    console.log(chalk.dim(`\n${memories.length} memories`));
    closeCortexDb(cortex);
  });
