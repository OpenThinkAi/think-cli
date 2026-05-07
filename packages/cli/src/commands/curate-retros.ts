import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig } from '../lib/config.js';
import { closeCortexDb } from '../db/engrams.js';
import {
  getPendingRetros,
  getPromotedRetrosForRelegation,
  mergeRetro,
  setRetroPromoted,
  recordCuratorRun,
  runsSince,
} from '../db/retro-queries.js';
import {
  getCandidatePairs,
  assembleRetroDedupePrompt,
  runRetroDedupe,
} from '../lib/retro-curator.js';
import { acquireCurateLock } from '../lib/curate-lock.js';

const DEFAULT_RELEGATE_AFTER_RUNS = 50;

export const curateRetrosCommand = new Command('curate-retros')
  .description('Run retro curator: dedupe, promote, and relegate retros (no deletion)')
  .option('--dry-run', 'Preview changes without saving')
  .action(async function (this: Command, opts: { dryRun?: boolean }) {
    const globalOpts = this.optsWithGlobals() as { cortex?: string };
    const config = getConfig();
    const cortex = globalOpts.cortex ?? config.cortex?.active;

    if (!cortex) {
      console.error(chalk.red('No cortex specified. Use -C <name> or run: think cortex switch <name>'));
      process.exitCode = 1;
      return;
    }

    const relegateAfterRuns = config.cortex?.retroRelegateAfterRuns ?? DEFAULT_RELEGATE_AFTER_RUNS;

    let releaseLock: () => void = () => {};
    if (!opts.dryRun) {
      const lock = acquireCurateLock(`retros-${cortex}`);
      if (!lock.acquired) {
        console.log(chalk.yellow(`Retro curation already running for cortex '${cortex}' (pid ${lock.heldByPid ?? '?'}). Skipping.`));
        return;
      }
      releaseLock = lock.release;
    }

    try {
      await runRetroCuration(cortex, opts.dryRun ?? false, relegateAfterRuns);
    } finally {
      releaseLock();
      closeCortexDb(cortex);
    }
  });

async function runRetroCuration(cortex: string, dryRun: boolean, relegateAfterRuns: number): Promise<void> {
  // 1. Dedupe pass: FTS-candidate pairs → LLM equivalence judgment → merge
  const candidatePairs = getCandidatePairs(cortex);
  let mergeCount = 0;

  if (candidatePairs.length > 0) {
    console.log(chalk.cyan(`Evaluating ${candidatePairs.length} candidate pair${candidatePairs.length === 1 ? '' : 's'} for deduplication...`));

    const prompt = assembleRetroDedupePrompt(candidatePairs);
    let judgments;
    try {
      judgments = await runRetroDedupe(prompt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Retro dedupe failed: ${message}`));
      process.exitCode = 1;
      return;
    }

    for (const judgment of judgments) {
      if (!judgment.equivalent) continue;

      const pair = candidatePairs.find(
        p =>
          (p.a.id === judgment.a && p.b.id === judgment.b) ||
          (p.a.id === judgment.b && p.b.id === judgment.a),
      );
      if (!pair) continue;

      // Older-by-created_at is canonical
      const [canonical, merged] =
        pair.a.created_at <= pair.b.created_at
          ? [pair.a, pair.b]
          : [pair.b, pair.a];

      if (dryRun) {
        console.log(
          chalk.dim(
            `  [dry-run] would merge: "${merged.content.slice(0, 60)}${merged.content.length > 60 ? '...' : ''}" → canonical`,
          ),
        );
      } else {
        mergeRetro(cortex, canonical.id, merged.id);
        console.log(
          chalk.cyan('  merged:') +
            ` "${merged.content.slice(0, 60)}${merged.content.length > 60 ? '...' : ''}" → canonical (occurrences now ${canonical.occurrences + 1})`,
        );
      }
      mergeCount++;
    }
  }

  // 2. Promotion pass: re-fetch (dedupe may have updated occurrences), then promote deterministically
  const afterDedupe = getPendingRetros(cortex);
  const toPromote = afterDedupe.filter(r => r.occurrences >= 2 && r.promoted === 0);
  const promoteCount = toPromote.length;

  for (const r of toPromote) {
    if (dryRun) {
      console.log(
        chalk.dim(
          `  [dry-run] would promote: "${r.content.slice(0, 60)}${r.content.length > 60 ? '...' : ''}" (occurrences=${r.occurrences})`,
        ),
      );
    } else {
      setRetroPromoted(cortex, [r.id], 1);
      console.log(
        chalk.green('  promoted:') +
          ` "${r.content.slice(0, 60)}${r.content.length > 60 ? '...' : ''}" (occurrences=${r.occurrences})`,
      );
    }
  }

  // 3. Relegation pass: promoted retros not recalled in N runs → demote (row stays)
  const relegationCandidates = getPromotedRetrosForRelegation(cortex);
  const toRelegate = relegationCandidates.filter(r => {
    const runs = runsSince(cortex, r.last_recalled_at!);
    return runs >= relegateAfterRuns;
  });
  const relegateCount = toRelegate.length;

  for (const r of toRelegate) {
    if (dryRun) {
      console.log(
        chalk.dim(
          `  [dry-run] would relegate: "${r.content.slice(0, 60)}${r.content.length > 60 ? '...' : ''}" (last_recalled_at=${r.last_recalled_at})`,
        ),
      );
    } else {
      setRetroPromoted(cortex, [r.id], 0);
      console.log(
        chalk.yellow('  relegated:') +
          ` "${r.content.slice(0, 60)}${r.content.length > 60 ? '...' : ''}" (last_recalled_at=${r.last_recalled_at})`,
      );
    }
  }

  // 4. Record the run
  if (!dryRun) {
    recordCuratorRun(cortex);
  }

  // 5. Report
  console.log();
  if (dryRun) {
    console.log(`${chalk.cyan('✓')} Retro curator dry run complete`);
  } else {
    console.log(`${chalk.green('✓')} Retro curation complete`);
  }
  console.log(`  ${mergeCount} merged, ${promoteCount} promoted, ${relegateCount} relegated`);
  if (!dryRun) {
    const total = getPendingRetros(cortex).length;
    console.log(`  ${total} retro${total === 1 ? '' : 's'} in cortex (none deleted)`);
  }
}
