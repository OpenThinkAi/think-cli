/**
 * `think retro-migrate` — iterative-learning v3 (retro locality).
 *
 * Folds retros from legacy per-repo cortices into a home cortex, tagging each
 * with its source as a `repo:<source>` context. DRY-RUN by default; pass
 * --apply to mutate. The heavy lifting (synced copy + synced tombstone +
 * idempotency) runs in the daemon (`retro_migrate` RPC) so writes propagate to
 * every peer — see daemon/retro-migrate-handler.ts.
 *
 * Usage:
 *   think retro-migrate --to engineering --from stamp-cli,think-cli      (dry-run)
 *   think retro-migrate --to engineering --from stamp-cli,think-cli --apply
 *   think -C personal retro-migrate                  (target from -C, all sources)
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { connectDaemon, DaemonUnavailableError } from '../lib/daemon-client.js';
import { getConfig } from '../lib/config.js';
import { listLocalBranches } from '../lib/git.js';
import type { RetroMigrateResult } from '../daemon/retro-migrate-handler.js';

export const retroMigrateCommand = new Command('retro-migrate')
  .description('Fold legacy per-repo cortices into your home cortex, tagged by repo context (dry-run by default)')
  .option('--to <name>', 'Target home cortex to migrate retros INTO (default: -C or active cortex)')
  .option('--from <list>', 'Comma-separated source cortices (default: all other local cortices with retros)')
  .option('--apply', 'Actually perform the migration (default is a dry-run preview)')
  .addHelpText('after', `
What it does:
  For each source cortex, copies every retro onto the target home cortex tagged
  repo:<source> (so 'think brief' / recall scope to it), then tombstones the
  source copy. Both halves sync to all peers. Idempotent — re-running, or running
  after another peer migrated, is a no-op.

  Forward-only: once a tombstone is pushed it is synced. Preview with the default
  dry-run before passing --apply.

Examples:
  think retro-migrate --to engineering --from stamp-cli,think-cli
  think retro-migrate --to engineering --from stamp-cli,think-cli --apply
  think -C personal retro-migrate                 (target = personal, all sources)
`)
  .action(async function (this: Command, opts: { to?: string; from?: string; apply?: boolean }) {
    const globalCortex = (this.parent?.opts() as { cortex?: string } | undefined)?.cortex;
    const config = getConfig();
    const to = opts.to ?? globalCortex ?? config.cortex?.active;

    if (!to) {
      console.error(chalk.red('think retro-migrate: no target cortex. Pass --to <name> or set an active cortex (-C / think cortex switch).'));
      process.exitCode = 1;
      return;
    }

    // Resolve sources: explicit --from, else every local cortex except the target.
    let from: string[];
    if (opts.from !== undefined) {
      from = opts.from.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    } else {
      try {
        from = listLocalBranches().filter((c) => c !== to);
      } catch (err) {
        console.error(chalk.red(`think retro-migrate: could not enumerate local cortices — ${err instanceof Error ? err.message : String(err)}`));
        console.error(chalk.red('Pass sources explicitly with --from <a,b,c>.'));
        process.exitCode = 1;
        return;
      }
    }

    if (from.length === 0) {
      console.error(chalk.yellow('think retro-migrate: no source cortices to migrate from.'));
      return;
    }

    const apply = opts.apply === true;

    let result: RetroMigrateResult;
    try {
      const client = await connectDaemon();
      try {
        result = await client.call('retro_migrate', { to, from, apply }) as RetroMigrateResult;
      } finally {
        try { client.close(); } catch { /* best-effort */ }
      }
    } catch (err) {
      if (err instanceof DaemonUnavailableError) {
        console.error(chalk.red('think retro-migrate: daemon unavailable. Start it with: think daemon start'));
      } else {
        console.error(chalk.red(`think retro-migrate: ${err instanceof Error ? err.message : String(err)}`));
      }
      process.exitCode = 1;
      return;
    }

    const mode = apply ? chalk.green('APPLIED') : chalk.yellow('DRY-RUN');
    console.log(`${mode} — target home cortex: ${chalk.cyan(to)}`);
    for (const s of result.sources) {
      const verb = apply ? 'migrated' : 'would migrate';
      const skip = s.skipped > 0 ? chalk.dim(` (${s.skipped} already migrated)`) : '';
      console.log(`  ${chalk.cyan(s.source)}: ${verb} ${s.migrated} of ${s.total} retro${s.total === 1 ? '' : 's'}${skip}`);
    }
    const verb = apply ? 'Migrated' : 'Would migrate';
    console.log(`${verb} ${result.totalMigrated} retro${result.totalMigrated === 1 ? '' : 's'} total` +
      (result.totalSkipped > 0 ? chalk.dim(`; ${result.totalSkipped} skipped (already migrated)`) : ''));
    if (!apply && result.totalMigrated > 0) {
      console.log(chalk.yellow('Re-run with --apply to perform the migration.'));
    }
  });
