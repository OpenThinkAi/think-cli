import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig } from '../lib/config.js';
import { ensureRepoCloned, fetchBranch, readFileFromBranch, branchExists } from '../lib/git.js';
import { parseMemoriesJsonl } from '../lib/curator.js';

export const pullCommand = new Command('pull')
  .argument('<cortex>', 'Cortex branch to pull memories from')
  .description("Pull another cortex's memories (read-only)")
  .option('--days <n>', 'Days of memories to include', '14')
  .action(async (cortex: string, opts: { days: string }) => {
    const config = getConfig();

    if (!config.cortex?.repo) {
      console.error(chalk.red('No cortex repo configured. Run: think cortex setup'));
      process.exit(1);
    }

    ensureRepoCloned();

    if (!branchExists(cortex)) {
      console.error(chalk.red(`Cortex '${cortex}' does not exist.`));
      process.exit(1);
    }

    fetchBranch(cortex);

    const memoriesRaw = readFileFromBranch(cortex, 'memories.jsonl') ?? '';
    const allMemories = parseMemoriesJsonl(memoriesRaw);

    const days = parseInt(opts.days, 10);
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const recentMemories = allMemories.filter(m => m.ts >= cutoff);

    if (recentMemories.length === 0) {
      console.log(chalk.dim(`No memories in ${cortex} from the last ${days} days.`));
      return;
    }

    console.log(chalk.cyan(`${cortex} memories (last ${days} days):`));
    for (const m of recentMemories) {
      const ts = m.ts.slice(0, 16).replace('T', ' ');
      console.log(`  ${chalk.gray(ts)} ${chalk.dim(m.author + ':')} ${m.content}`);
    }
    console.log(chalk.dim(`\n${recentMemories.length} memories`));
  });
