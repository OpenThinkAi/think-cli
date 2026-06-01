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
import { getRetroSurfacingTelemetry } from '../db/usage-queries.js';
import { closeUsageDb } from '../db/usage-db.js';
import {
  computeRetroValueSignal,
  resolveRetroValueWeights,
  type ResolvedRetroValueWeights,
} from '../lib/retro-value-signal.js';

/**
 * Default number of curator runs without recall before relegation fires. The
 * daemon-scheduled curation loop (AGT-462) imports this so the manual command
 * and the scheduled pass share a single source of truth.
 */
export const DEFAULT_RELEGATE_AFTER_RUNS = 50;

/**
 * Sink for the human-readable progress lines the curation passes emit. The CLI
 * command supplies a chalk/console-backed logger; the daemon curation loop
 * (AGT-462) supplies one that routes to `daemonLog`. Factoring the logging out
 * of the curation body is what lets the daemon reuse the exact same merge →
 * promote → relegate work without dragging in Commander or stdout formatting.
 */
export interface CurationLogger {
  /** Section / progress line (cyan in the CLI). */
  info(msg: string): void;
  /** A pair was merged (label-only cyan in the CLI, matching promoted/relegated). */
  merged(msg: string): void;
  /** A retro was promoted (green in the CLI). */
  promoted(msg: string): void;
  /** A retro was relegated (yellow in the CLI). */
  relegated(msg: string): void;
  /** Dimmed/secondary detail line. */
  detail(msg: string): void;
}

/** Counts returned by a single curation pass. */
export interface CurationResult {
  merged: number;
  promoted: number;
  relegated: number;
}

/** Default logger used by the manual CLI command — preserves the prior output. */
const cliLogger: CurationLogger = {
  info: (msg) => console.log(chalk.cyan(msg)),
  merged: (msg) => console.log(chalk.cyan('  merged:') + msg),
  promoted: (msg) => console.log(chalk.green('  promoted:') + msg),
  relegated: (msg) => console.log(chalk.yellow('  relegated:') + msg),
  detail: (msg) => console.log(chalk.dim(msg)),
};

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

  promote — a retro whose composite value signal clears the promote
           threshold is marked promoted=1, making it eligible for surfacing
           in retro recall paths. The signal folds independent
           re-reports (occurrences), deliberate brief/session-start
           surfacings, and recency of high-similarity surfacings into one
           score; no LLM judgment is applied. With no surfacing telemetry it
           reduces to the legacy "occurrences >= 2" behaviour by default.

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

  cortex.retroValueSignal        Weights/thresholds for the composite value
                                 signal that gates promotion. Notable:
                                 promoteThreshold (default 5.0),
                                 occurrenceWeight (3.0), briefWeight (2.0),
                                 sessionStartWeight (2.0), midSessionWeight
                                 (0.25).
  Set a field via: think config set cortex.retroValueSignal.promoteThreshold <n>

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
    const valueWeights = resolveRetroValueWeights(config.cortex?.retroValueSignal);

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
      await runRetroCuration(cortex, opts.dryRun ?? false, relegateAfterRuns, valueWeights);
    } finally {
      releaseLock();
      closeCortexDb(cortex);
      closeUsageDb();
    }
  });

async function runRetroCuration(
  cortex: string,
  dryRun: boolean,
  relegateAfterRuns: number,
  valueWeights: ResolvedRetroValueWeights,
): Promise<void> {
  let result: CurationResult;
  try {
    result = await runCurationPasses(cortex, dryRun, relegateAfterRuns, valueWeights, cliLogger);
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

  // Report
  console.log();
  if (dryRun) {
    console.log(`${chalk.cyan('✓')} Retro curator dry run complete`);
  } else {
    console.log(`${chalk.green('✓')} Retro curation complete`);
  }
  console.log(`  ${result.merged} merged, ${result.promoted} promoted, ${result.relegated} relegated`);
  if (!dryRun) {
    const total = getPendingRetros(cortex).length;
    console.log(`  ${total} retro${total === 1 ? '' : 's'} in cortex (none deleted)`);
  }
}

/**
 * Run the three curation passes (merge → promote → relegate) for one cortex and
 * return the per-pass counts. This is the reusable core shared by the manual
 * `think curate-retros` command and the daemon-scheduled curation loop
 * (AGT-462 / design doc §5 M6): both drive the identical logic, differing only
 * in the injected {@link CurationLogger}.
 *
 * Throws on a dedupe failure (including {@link LlmConsentError}) so callers can
 * decide how to surface it — the CLI prints a red error and sets a non-zero
 * exit code; the daemon logs a WARN and retries on the next cadence. When the
 * dedupe step throws, no promotion/relegation runs (matching prior behaviour).
 */
export async function runCurationPasses(
  cortex: string,
  dryRun: boolean,
  relegateAfterRuns: number,
  valueWeights: ResolvedRetroValueWeights,
  logger: CurationLogger,
): Promise<CurationResult> {
  // 1. Dedupe pass: FTS-candidate pairs → LLM equivalence judgment → merge
  const candidatePairs = getCandidatePairs(cortex);
  let mergeCount = 0;

  if (candidatePairs.length > 0) {
    logger.info(`Evaluating ${candidatePairs.length} candidate pair${candidatePairs.length === 1 ? '' : 's'} for deduplication...`);

    const prompt = assembleRetroDedupePrompt(candidatePairs);
    const judgments = await runRetroDedupe(prompt);

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
        logger.detail(
          `  [dry-run] would merge: "${merged.content.slice(0, 60)}${merged.content.length > 60 ? '...' : ''}" → canonical`,
        );
      } else {
        mergeRetro(cortex, canonical.id, merged.id);
        occurrenceDelta.set(canonical.id, delta + 1);
        logger.merged(
          ` "${merged.content.slice(0, 60)}${merged.content.length > 60 ? '...' : ''}" → canonical (occurrences now ${canonical.occurrences + 1 + delta})`,
        );
      }
      mergeCount++;
    }
  }

  // 2. Promotion pass: re-fetch after dedupe (occurrences may have changed), then promote
  //    deterministically. Promotion is gated on the composite value signal
  //    (design doc §5 M5) instead of raw occurrences: it folds independent re-reports,
  //    deliberate brief/session-start surfacings, and recency of high-similarity surfacings
  //    into one score, so a recurring real lesson promotes even when its raw surface-count
  //    is low, and vector-noise surfacings don't push junk over on their own.
  //
  //    A retro is still eligible only if it hasn't already earned relegation — i.e. its
  //    last_recalled_at is either absent or recent enough. This prevents the
  //    promote-then-relegate cycle where a previously-relegated retro oscillates between
  //    states every run without any new recall or occurrence evidence.
  const afterDedupe = getPendingRetros(cortex);
  const telemetry = getRetroSurfacingTelemetry(cortex, valueWeights.highSimilarityThreshold);
  const now = new Date();
  const toPromote = afterDedupe.filter(r => {
    if (r.promoted !== 0) return false;
    const t = telemetry.get(r.id);
    const signal = computeRetroValueSignal(
      {
        occurrences: r.occurrences,
        briefCount: t?.briefCount ?? 0,
        sessionStartCount: t?.sessionStartCount ?? 0,
        midSessionCount: t?.midSessionCount ?? 0,
        lastHighSimilarityAt: t?.lastHighSimilarityAt ?? null,
      },
      valueWeights,
      now,
    );
    if (signal < valueWeights.promoteThreshold) return false;
    if (r.last_recalled_at === null) return true;
    return runsSince(cortex, r.last_recalled_at) < relegateAfterRuns;
  });
  const promoteCount = toPromote.length;

  for (const r of toPromote) {
    if (dryRun) {
      logger.detail(
        `  [dry-run] would promote: "${r.content.slice(0, 60)}${r.content.length > 60 ? '...' : ''}" (occurrences=${r.occurrences})`,
      );
    } else {
      setRetroPromoted(cortex, [r.id], 1);
      logger.promoted(
        ` "${r.content.slice(0, 60)}${r.content.length > 60 ? '...' : ''}" (occurrences=${r.occurrences})`,
      );
    }
  }

  // 3. Relegation pass: promoted retros not recalled in N runs → demote (row stays).
  //    Active as of AGT-457 — the recall path writes last_recalled_at back on
  //    every surfacing, so a promoted retro that stops being recalled relegates.
  const relegationCandidates = getPromotedRetrosForRelegation(cortex);
  if (relegationCandidates.length === 0 && afterDedupe.some(r => r.promoted === 1)) {
    logger.detail('  (no relegation candidates: every promoted retro has been recalled recently or never recalled at all)');
  }
  const toRelegate = relegationCandidates.filter(r => {
    return runsSince(cortex, r.last_recalled_at!) >= relegateAfterRuns;
  });
  const relegateCount = toRelegate.length;

  for (const r of toRelegate) {
    if (dryRun) {
      logger.detail(
        `  [dry-run] would relegate: "${r.content.slice(0, 60)}${r.content.length > 60 ? '...' : ''}" (last_recalled_at=${r.last_recalled_at})`,
      );
    } else {
      setRetroPromoted(cortex, [r.id], 0);
      logger.relegated(
        ` "${r.content.slice(0, 60)}${r.content.length > 60 ? '...' : ''}" (last_recalled_at=${r.last_recalled_at})`,
      );
    }
  }

  // 4. Record the run
  if (!dryRun) {
    recordCuratorRun(cortex);
  }

  return { merged: mergeCount, promoted: promoteCount, relegated: relegateCount };
}
