import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig } from '../lib/config.js';
import { ensureRepoCloned, fetchBranch, readFileFromBranch, appendAndCommit } from '../lib/git.js';
import { getPendingEngrams, markEvaluated, pruneExpiredEngrams } from '../db/engram-queries.js';
import { closeEngramsDb } from '../db/engrams.js';
import { readCuratorMd, assembleCurationPrompt, parseMemoriesJsonl, runCuration } from '../lib/curator.js';

export const curateCommand = new Command('curate')
  .description('Run curation: evaluate pending engrams and append memories to the cortex branch')
  .option('--dry-run', 'Preview what would be committed without pushing')
  .action(async (opts: { dryRun?: boolean }) => {
    const config = getConfig();
    const cortex = config.cortex?.active;

    if (!cortex) {
      console.error(chalk.red('No active cortex. Run: think cortex switch <name>'));
      process.exit(1);
    }

    if (!config.cortex?.repo) {
      console.error(chalk.red('No cortex repo configured. Run: think cortex setup'));
      process.exit(1);
    }

    const author = config.cortex.author;

    // 1. Ensure repo is cloned and fetch latest
    ensureRepoCloned();
    fetchBranch(cortex);

    // 2. Read existing memories from branch
    const memoriesRaw = readFileFromBranch(cortex, 'memories.jsonl') ?? '';
    const existingMemories = parseMemoriesJsonl(memoriesRaw);

    // 3. Read pending engrams
    const pending = getPendingEngrams(cortex);
    if (pending.length === 0) {
      console.log(chalk.dim('No pending engrams to evaluate.'));
      closeEngramsDb(cortex);
      return;
    }

    console.log(chalk.cyan(`Evaluating ${pending.length} engrams against ${existingMemories.length} existing memories...`));

    // 4. Read curator.md
    const curatorMd = readCuratorMd();

    // 5. Assemble and run curation prompt
    const prompt = assembleCurationPrompt({
      existingMemories,
      curatorMd,
      pendingEngrams: pending,
      author,
    });

    let newEntries;
    try {
      newEntries = await runCuration(prompt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Curation failed: ${message}`));
      closeEngramsDb(cortex);
      process.exit(1);
    }

    // Always set author and timestamp — don't trust the LLM to fill these correctly
    for (const entry of newEntries) {
      entry.author = author;
      if (!entry.ts) entry.ts = new Date().toISOString();
    }

    // 6. Identify promoted and dropped engram IDs
    const promotedIds = new Set<string>();
    for (const entry of newEntries) {
      for (const id of entry.source_ids) {
        promotedIds.add(id);
      }
    }

    const droppedIds = pending
      .filter(e => !promotedIds.has(e.id))
      .map(e => e.id);

    // 7. Dry run — show preview and exit
    if (opts.dryRun) {
      console.log();
      if (newEntries.length === 0) {
        console.log(chalk.dim('Curator would produce no new memories.'));
      } else {
        console.log(chalk.cyan('Would append:'));
        for (const entry of newEntries) {
          console.log(chalk.green(`  + `) + `[${entry.ts}] ${entry.content}`);
        }
      }
      console.log();
      console.log(`${pending.length} evaluated, ${newEntries.length} would promote, ${droppedIds.length} would drop`);
      closeEngramsDb(cortex);
      return;
    }

    // 8. Append to memories.jsonl and push
    if (newEntries.length > 0) {
      const newLines = newEntries.map(e => JSON.stringify(e));
      const commitMsg = `curate: ${author}, ${pending.length} engrams, ${newEntries.length} memories`;

      try {
        appendAndCommit(cortex, newLines, commitMsg);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Failed to push memories: ${message}`));
        closeEngramsDb(cortex);
        process.exit(1);
      }
    }

    // 9. Mark engrams as evaluated
    if (promotedIds.size > 0) {
      markEvaluated(cortex, [...promotedIds], true);
    }
    if (droppedIds.length > 0) {
      markEvaluated(cortex, droppedIds, false);
    }

    // 10. Prune expired engrams
    const pruned = pruneExpiredEngrams(cortex);

    // 11. Report
    console.log();
    console.log(`${chalk.green('✓')} Curation complete`);
    console.log(`  ${pending.length} evaluated, ${newEntries.length} promoted, ${droppedIds.length} dropped`);
    if (pruned > 0) {
      console.log(`  ${pruned} expired engrams pruned`);
    }

    closeEngramsDb(cortex);
  });
