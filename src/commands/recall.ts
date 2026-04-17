import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig } from '../lib/config.js';
import { searchEngrams } from '../db/engram-queries.js';
import { searchMemories, getLongtermSummary } from '../db/memory-queries.js';
import { closeCortexDb } from '../db/engrams.js';

export const recallCommand = new Command('recall')
  .argument('<query>', 'What to recall')
  .description('Search memories and local engrams')
  .option('--engrams', 'Also search local engrams (not just memories)')
  .option('--all', 'Dump all recent memories + long-term summary (ignores query for memories)')
  .option('--days <n>', 'Days of memories to include (only with --all)', '14')
  .option('--limit <n>', 'Max results to return', '20')
  .action(async (query: string, opts: { engrams?: boolean; all?: boolean; days: string; limit: string }) => {
    const config = getConfig();
    const cortex = config.cortex?.active;

    if (!cortex) {
      console.error(chalk.red('No active cortex. Run: think cortex switch <name>'));
      process.exit(1);
    }

    const limit = parseInt(opts.limit, 10);

    if (opts.all) {
      // Legacy behavior: dump everything
      const { getMemories } = await import('../db/memory-queries.js');
      const days = parseInt(opts.days, 10);
      const cutoff = new Date(Date.now() - days * 86400000).toISOString();
      const recentMemories = getMemories(cortex, { since: cutoff });
      const longterm = getLongtermSummary(cortex);
      const matchingEngrams = searchEngrams(cortex, query);

      if (recentMemories.length > 0) {
        console.log(chalk.cyan(`Team memories (last ${days} days):`));
        for (const m of recentMemories) {
          const ts = m.ts.slice(0, 16).replace('T', ' ');
          console.log(`  ${chalk.gray(ts)} ${chalk.dim(m.author + ':')} ${m.content}`);
          if (m.decisions) {
            try {
              const decisions = JSON.parse(m.decisions) as string[];
              for (const d of decisions) {
                console.log(`    ${chalk.yellow('⚡')} ${chalk.yellow(d)}`);
              }
            } catch { /* skip malformed */ }
          }
        }
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
      return;
    }

    // Default: FTS search against memories
    const matchingMemories = searchMemories(cortex, query, limit);

    if (matchingMemories.length > 0) {
      console.log(chalk.cyan(`Matching memories (${matchingMemories.length}):`));
      for (const m of matchingMemories) {
        const ts = m.ts.slice(0, 16).replace('T', ' ');
        console.log(`  ${chalk.gray(ts)} ${chalk.dim(m.author + ':')} ${m.content}`);
        if (m.decisions) {
          try {
            const decisions = JSON.parse(m.decisions) as string[];
            for (const d of decisions) {
              console.log(`    ${chalk.yellow('⚡')} ${chalk.yellow(d)}`);
            }
          } catch { /* skip malformed */ }
        }
      }
      console.log();
    } else {
      // Fall back to long-term summary when no FTS matches
      const longterm = getLongtermSummary(cortex);
      if (longterm) {
        console.log(chalk.dim('No matching memories. Showing long-term context:'));
        console.log(`  ${longterm}`);
        console.log();
      } else {
        console.log(chalk.dim('No matching memories.'));
        console.log();
      }
    }

    // Optionally include engrams
    if (opts.engrams) {
      const matchingEngrams = searchEngrams(cortex, query, limit);
      if (matchingEngrams.length > 0) {
        console.log(chalk.cyan(`Matching engrams (${matchingEngrams.length}):`));
        for (const e of matchingEngrams) {
          const ts = e.created_at.slice(0, 16).replace('T', ' ');
          console.log(`  ${chalk.gray(ts)} ${e.content}`);
        }
        console.log();
      }
    }

    closeCortexDb(cortex);
  });
