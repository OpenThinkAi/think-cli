import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig } from '../lib/config.js';
import { searchEngrams } from '../db/engram-queries.js';
import { getMemories, getLongtermSummary } from '../db/memory-queries.js';
import { closeCortexDb } from '../db/engrams.js';

export const recallCommand = new Command('recall')
  .argument('<query>', 'What to recall')
  .description('Search memories and local engrams')
  .option('--days <n>', 'Days of memories to include', '14')
  .action(async (query: string, opts: { days: string }) => {
    const config = getConfig();
    const cortex = config.cortex?.active;

    if (!cortex) {
      console.error(chalk.red('No active cortex. Run: think cortex switch <name>'));
      process.exit(1);
    }

    // Read memories from local SQLite
    const days = parseInt(opts.days, 10);
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const recentMemories = getMemories(cortex, { since: cutoff });

    // Search local engrams
    const matchingEngrams = searchEngrams(cortex, query);

    // Read long-term summary from local SQLite
    const longterm = getLongtermSummary(cortex);

    // Output
    if (recentMemories.length > 0) {
      console.log(chalk.cyan(`Team memories (last ${days} days):`));
      for (const m of recentMemories) {
        const ts = m.ts.slice(0, 16).replace('T', ' ');
        console.log(`  ${chalk.gray(ts)} ${chalk.dim(m.author + ':')} ${m.content}`);
      }
      console.log();
    } else {
      console.log(chalk.dim('No recent memories.'));
      console.log();
    }

    if (longterm) {
      console.log(chalk.cyan('Long-term context:'));
      console.log(`  ${longterm}`);
      console.log();
    }

    if (matchingEngrams.length > 0) {
      console.log(chalk.cyan(`Matching engrams (local):`));
      for (const e of matchingEngrams) {
        const ts = e.created_at.slice(0, 16).replace('T', ' ');
        console.log(`  ${chalk.gray(ts)} ${e.content}`);
      }
      console.log();
    }

    if (recentMemories.length === 0 && matchingEngrams.length === 0 && !longterm) {
      console.log(chalk.dim('No results found.'));
    }

    closeCortexDb(cortex);
  });
