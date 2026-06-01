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
import { LlmConsentError } from '../lib/llm-consent.js';

const DEFAULT_RELEGATE_AFTER_RUNS = 50;

export const curateRetrosCommand = new Command('curate-retros')
  .description('Run retro curator: dedupe, promote, and relegate retros (no deletion)')
  .option('--dry-run', 'Preview changes without saving')
  .addHelpText('after', `
Storage contract:
  All retros are preserved permanently — this command never deletes rows.
  Three operations are performed, all reversible or audit-preserving:

  merge  — semantically equivalent pairs are deduplicated: the older entry
           becomes canonical (occurrences++), the newer is tombstoned with
           tombstone_reason="merged_into:<id>". Both rows remain in storage.

  promote — a retro with occurrences >= 2 is marked promoted=1, making it
           eligible for surfacing in retro recall paths. Promotion is purely
           frequency-driven; no LLM judgment is applied.

  relegate — a promoted retro whose last_recalled_at is older than N
           curator runs has promoted=0 set. The row is NOT deleted. A
           subsequent recall or new occurrence can re-promote it.

           Note: relegation requires last_recalled_at to be set. As of
           AGT-457 the recall path writes it back on every surfacing, so a
           promoted retro that stops being recalled will eventually relegate.
           Retros that have never been recalled (last_recalled_at IS NULL)
           are never relegated.

  --cortex is required. Retros are scoped to a specific codebase or tool,
  not the user's current working context.

Configuration:
  cortex.retroRelegateAfterRuns  Number of curator runs without recall
                                 before relegation fires (default: 50).
  Set via: think config set cortex.retroRelegateAfterRuns <n>

Examples:
  think -C fx-tracker curate-retros
  think curate-retros --cortex my-repo --dry-run
`)
  .action(async function (this: Command, opts: { dryRun?: boolean }) {
    const globalOpts = this.optsWithGlobals() as { cortex?: string };
    const cortex = globalOpts.cortex;

    if (!cortex) {
      console.error(chalk.red('think curate-retros: --cortex is required (retros are scoped to a specific codebase or tool, not the active cortex).'));
      console.error(chalk.red('Pass it as: think curate-retros --cortex <name>  or  think -C <name> curate-retros'));
      process.exitCode = 1;
      return;
    }

    const config = getConfig();
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
      if (err instanceof LlmConsentError) {
        console.error(chalk.red(err.message));
        process.exitCode = 1;
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Retro dedupe failed: ${message}`));
      console.error(chalk.dim('  (no changes made; promotion and relegation passes skipped)'));
      process.exitCode = 1;
      return;
    }

    // Track in-memory occurrence deltas so a canonical absorbing multiple duplicates
    // in one pass logs the correct count even before the DB is re-read.
    const occurrenceDelta = new Map<string, number>();

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

      const delta = occurrenceDelta.get(canonical.id) ?? 0;

      if (dryRun) {
        console.log(
          chalk.dim(
            `  [dry-run] would merge: "${merged.content.slice(0, 60)}${merged.content.length > 60 ? '...' : ''}" → canonical`,
          ),
        );
      } else {
        mergeRetro(cortex, canonical.id, merged.id);
        occurrenceDelta.set(canonical.id, delta + 1);
        console.log(
          chalk.cyan('  merged:') +
            ` "${merged.content.slice(0, 60)}${merged.content.length > 60 ? '...' : ''}" → canonical (occurrences now ${canonical.occurrences + 1 + delta})`,
        );
      }
      mergeCount++;
    }
  }

  // 2. Promotion pass: re-fetch after dedupe (occurrences may have changed), then promote
  //    deterministically. A retro is eligible only if it hasn't already earned relegation —
  //    i.e., its last_recalled_at is either absent or recent enough. This prevents the
  //    promote-then-relegate cycle where a previously-relegated retro oscillates between
  //    states every run without any new recall or occurrence evidence.
  const afterDedupe = getPendingRetros(cortex);
  const toPromote = afterDedupe.filter(r => {
    if (r.occurrences < 2 || r.promoted !== 0) return false;
    if (r.last_recalled_at === null) return true;
    return runsSince(cortex, r.last_recalled_at) < relegateAfterRuns;
  });
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

  // 3. Relegation pass: promoted retros not recalled in N runs → demote (row stays).
  //    Active as of AGT-457 — the recall path writes last_recalled_at back on
  //    every surfacing, so a promoted retro that stops being recalled relegates.
  const relegationCandidates = getPromotedRetrosForRelegation(cortex);
  if (relegationCandidates.length === 0 && afterDedupe.some(r => r.promoted === 1)) {
    console.log(chalk.dim('  (no relegation candidates: every promoted retro has been recalled recently or never recalled at all)'));
  }
  const toRelegate = relegationCandidates.filter(r => {
    return runsSince(cortex, r.last_recalled_at!) >= relegateAfterRuns;
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
