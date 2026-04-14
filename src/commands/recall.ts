import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'node:fs';
import { getConfig } from '../lib/config.js';
import { ensureRepoCloned, fetchBranch, readFileFromBranch } from '../lib/git.js';
import { searchEngrams } from '../db/engram-queries.js';
import { closeEngramsDb } from '../db/engrams.js';
import { parseMemoriesJsonl } from '../lib/curator.js';
import { getLongtermPath } from '../lib/paths.js';

export const recallCommand = new Command('recall')
  .argument('<query>', 'What to recall')
  .description('Search memories from the cortex branch + local engrams')
  .option('--days <n>', 'Days of memories to include', '14')
  .action(async (query: string, opts: { days: string }) => {
    const config = getConfig();
    const cortex = config.cortex?.active;

    if (!cortex) {
      console.error(chalk.red('No active cortex. Run: think cortex switch <name>'));
      process.exit(1);
    }

    ensureRepoCloned();
    fetchBranch(cortex);

    // Read memories from branch
    const memoriesRaw = readFileFromBranch(cortex, 'memories.jsonl') ?? '';
    const allMemories = parseMemoriesJsonl(memoriesRaw);

    // Filter to recent window
    const days = parseInt(opts.days, 10);
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const recentMemories = allMemories.filter(m => m.ts >= cutoff);

    // Search local engrams
    const matchingEngrams = searchEngrams(cortex, query);

    // Read long-term summary if present
    const ltPath = getLongtermPath(cortex);
    const longterm = fs.existsSync(ltPath) ? fs.readFileSync(ltPath, 'utf-8').trim() : null;

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

    closeEngramsDb(cortex);
  });
