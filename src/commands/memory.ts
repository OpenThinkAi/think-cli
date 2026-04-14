import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig } from '../lib/config.js';
import { ensureRepoCloned, fetchBranch, readFileFromBranch, getFileLog } from '../lib/git.js';
import { parseMemoriesJsonl } from '../lib/curator.js';

export const memoryCommand = new Command('memory')
  .description('Show current memories from the cortex branch')
  .option('--history', 'Show git log for memories.jsonl')
  .action(async (opts: { history?: boolean }) => {
    const config = getConfig();
    const cortex = config.cortex?.active;

    if (!cortex) {
      console.error(chalk.red('No active cortex. Run: think cortex switch <name>'));
      process.exit(1);
    }

    ensureRepoCloned();
    fetchBranch(cortex);

    if (opts.history) {
      const log = getFileLog(cortex, 'memories.jsonl');
      if (log) {
        console.log(log);
      } else {
        console.log(chalk.dim('No history.'));
      }
      return;
    }

    const memoriesRaw = readFileFromBranch(cortex, 'memories.jsonl') ?? '';
    const memories = parseMemoriesJsonl(memoriesRaw);

    if (memories.length === 0) {
      console.log(chalk.dim('No memories yet. Run: think curate'));
      return;
    }

    for (const m of memories) {
      const ts = m.ts.slice(0, 16).replace('T', ' ');
      console.log(`${chalk.gray(ts)}  ${chalk.dim(m.author + ':')} ${m.content}`);
    }

    console.log(chalk.dim(`\n${memories.length} memories`));
  });
