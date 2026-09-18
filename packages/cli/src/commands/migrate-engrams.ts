/**
 * `think migrate-engrams` — AGT-1302.
 *
 * The one-shot rescue of the v2 `engrams` tier runs by itself on the first
 * daemon start after the upgrade (daemon/index.ts). This command exists for the
 * two cases that start cannot serve: previewing what the rescue will move
 * (`--dry-run`), and running it on demand on a machine whose daemon has not
 * been restarted.
 *
 * The rescue itself — and the structured result `think doctor` (AGT-1308) and
 * the heal summary (AGT-1307) report from — lives in `lib/engram-migration.ts`.
 * This file is only the terminal surface.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { migrateStrandedEngrams, type EngramMigrationSummary } from '../lib/engram-migration.js';
import { closeAllCortexDbs } from '../db/engrams.js';

export const migrateEngramsCommand = new Command('migrate-engrams')
  .description('Re-submit entries stranded in the legacy pre-daemon table')
  .option('--dry-run', 'Report what would be migrated, per cortex, and write nothing')
  .addHelpText('after', `
What it does:
  Every unevaluated row in the legacy 'engrams' table — including rows past
  their expiry — is written through the normal write path: rows carrying
  decision text become events, the rest become memories, each keeping its
  original timestamp and tagged with the 'migrated-engram' topic. Rows from
  'think subscribe poll' are local-only and are skipped.

  Idempotent: each rescued row is stamped as it is migrated, so a second run
  moves nothing. The engrams table itself is left in place.

  This runs automatically on the first daemon start after upgrading, so you
  normally do not need to run it at all.

Examples:
  think migrate-engrams --dry-run      preview the counts, write nothing
  think migrate-engrams                migrate now (loads the embedding model)
`)
  .action(async (opts: { dryRun?: boolean }) => {
    const dryRun = opts.dryRun === true;

    if (!dryRun) {
      console.log(chalk.dim('Migrating stranded engram rows (this loads the embedding model)…'));
    }

    const summary = await migrateStrandedEngrams({
      dryRun,
      log: dryRun ? undefined : (msg) => console.log(chalk.dim(`  ${msg}`)),
    });

    printSummary(summary, dryRun);

    // Non-zero when something is still stranded through no choice of the
    // user's, so a setup script can gate on it.
    const stuck = summary.cortexes.some((c) => c.error !== undefined) || summary.totals.failed > 0;
    if (stuck) process.exitCode = 1;

    closeAllCortexDbs();
  });

/** `1 memory` / `2 memories` — never `1 memory/ies`. */
function countOf(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function printSummary(summary: EngramMigrationSummary, dryRun: boolean): void {
  const touched = summary.cortexes.filter(
    (c) =>
      c.error !== undefined ||
      c.events + c.memories + c.skippedSubscribe + c.skippedInvalid + c.failed + c.repaired > 0,
  );

  console.log();
  if (summary.cortexes.length === 0) {
    // Distinct from "all clean": no cortex DB was found at all, which usually
    // means THINK_HOME points somewhere unexpected.
    console.log(chalk.dim('No cortexes found under THINK_HOME — nothing to migrate.'));
    return;
  }
  if (touched.length === 0) {
    console.log(chalk.dim('No stranded engram rows in any cortex — nothing to migrate.'));
    return;
  }

  console.log(chalk.cyan(dryRun ? 'Would migrate:' : 'Migrated:'));
  for (const c of touched) {
    if (c.error !== undefined) {
      console.log(`  ${chalk.yellow('⚠')} ${c.cortex}: ${c.error}`);
      continue;
    }
    // The two skip categories mean different things — a subscribe row was
    // meant to stay local, an unusable row wants a human — so they are never
    // merged into one "skipped" number.
    const parts = [
      countOf(c.events, 'event', 'events'),
      countOf(c.memories, 'memory', 'memories'),
      `${c.skippedSubscribe} subscribe skipped`,
      `${c.skippedInvalid} unusable`,
    ];
    if (c.repaired > 0) parts.push(`${c.repaired} already migrated`);
    if (c.failed > 0) parts.push(chalk.yellow(`${c.failed} failed`));
    console.log(`  ${c.cortex}: ${parts.join(', ')}`);

    // Every skipped or altered row is named, so nothing disappears into a
    // counter — an unusable legacy row is left in place to be looked at.
    for (const warning of c.warnings) {
      console.log(chalk.dim(`    - ${warning}`));
    }
  }

  const t = summary.totals;
  console.log();
  console.log(
    chalk.dim(
      `${countOf(t.events, 'event', 'events')}, ` +
        `${countOf(t.memories, 'memory', 'memories')}, ` +
        `${countOf(t.skippedSubscribe, 'subscribe row', 'subscribe rows')} skipped, ` +
        `${countOf(t.skippedInvalid, 'unusable row', 'unusable rows')} left in place` +
        (t.failed > 0 ? `, ${t.failed} failed` : ''),
    ),
  );
  if (dryRun) {
    console.log(chalk.dim('Dry run — nothing was written. Re-run without --dry-run to migrate.'));
  }
}
