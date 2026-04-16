import { Command } from 'commander';
import chalk from 'chalk';
import { getMemories, getMemoryCount } from '../db/memory-queries.js';
import { closeCortexDb } from '../db/engrams.js';

export const pullCommand = new Command('pull')
  .argument('<cortex>', 'Cortex to read memories from')
  .description("Read another cortex's memories from local store")
  .option('--days <n>', 'Days of memories to include', '14')
  .action(async (cortex: string, opts: { days: string }) => {
    const count = getMemoryCount(cortex);

    if (count === 0) {
      console.log(chalk.dim(`No local memories for cortex '${cortex}'.`));
      console.log(chalk.dim('Run: think cortex pull  (to sync from remote first)'));
      closeCortexDb(cortex);
      return;
    }

    const days = parseInt(opts.days, 10);
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const recentMemories = getMemories(cortex, { since: cutoff });

    if (recentMemories.length === 0) {
      console.log(chalk.dim(`No memories in ${cortex} from the last ${days} days.`));
      closeCortexDb(cortex);
      return;
    }

    console.log(chalk.cyan(`${cortex} memories (last ${days} days):`));
    for (const m of recentMemories) {
      const ts = m.ts.slice(0, 16).replace('T', ' ');
      console.log(`  ${chalk.gray(ts)} ${chalk.dim(m.author + ':')} ${m.content}`);
    }
    console.log(chalk.dim(`\n${recentMemories.length} memories`));

    closeCortexDb(cortex);
  });
