/**
 * `think delete` — soft-delete entries from the ACTIVE cortex (issue #84).
 *
 * Routes through the daemon `delete` RPC, which tombstones the entry in the
 * cortex index (the same store `recall` reads) AND appends a tombstone line to
 * L1 so the deletion propagates to peers of a shared cortex and survives
 * `think reindex`.
 *
 * Pre-#84 this command targeted an `entries` table in the legacy local
 * `think.db` — a table that does not exist in cortex index DBs — so deleting a
 * synced entry silently no-oped (and `--match` printed a ✓ for 0 deletions).
 * The legacy path is retained ONLY for installs with no cortex configured.
 *
 * Exit code: 1 when nothing was deleted, so scripts and agents can
 * distinguish a no-op from a successful retraction.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig } from '../lib/config.js';
import { connectDaemon, DaemonUnavailableError } from '../lib/daemon-client.js';

interface DeleteRpcResult {
  deleted: number;
  entries: { id: string; content: string }[];
}

function snippet(content: string): string {
  const oneLine = content.replace(/\s+/g, ' ').trim();
  return oneLine.length > 72 ? `${oneLine.slice(0, 72)}…` : oneLine;
}

export const deleteCommand = new Command('delete')
  .description('Soft-delete entries from the active cortex (tombstoned locally and propagated to peers)')
  .option('--id <id>', 'Delete a specific entry by ID')
  .option('--match <pattern>', 'Delete entries whose content contains the pattern')
  .option('--last', 'Delete the most recent entry')
  .option('--force', 'Allow --match to delete more than 20 entries at once')
  .action(async function (this: Command, opts: { id?: string; match?: string; last?: boolean; force?: boolean }) {
    const globalOpts = this.optsWithGlobals() as { cortex?: string };
    const config = getConfig();
    const cortex = globalOpts.cortex ?? config.cortex?.active;

    const selectors = [opts.id, opts.match, opts.last].filter(Boolean).length;
    if (selectors !== 1) {
      console.log('Specify exactly one of --id, --match, or --last. See think delete --help');
      process.exitCode = 1;
      return;
    }

    if (!cortex) {
      // Legacy install with no cortex configured: fall back to the local
      // think.db `entries` store this command historically targeted.
      await legacyLocalDelete(opts);
      return;
    }

    let result: DeleteRpcResult;
    try {
      const client = await connectDaemon();
      try {
        result = await client.call('delete', {
          cortex,
          ...(opts.id ? { id: opts.id } : {}),
          ...(opts.match ? { match: opts.match } : {}),
          ...(opts.last ? { last: true } : {}),
          ...(opts.force ? { force: true } : {}),
        }) as DeleteRpcResult;
      } finally {
        try { client.close(); } catch { /* best-effort */ }
      }
    } catch (err) {
      if (err instanceof DaemonUnavailableError) {
        console.error(chalk.red(
          `Delete error: the daemon is required to delete from cortex '${cortex}' ` +
          `(the tombstone must be queued for sync). Start it with: think daemon start`,
        ));
      } else {
        console.error(chalk.red(`Delete error: ${err instanceof Error ? err.message : String(err)}`));
      }
      process.exitCode = 1;
      return;
    }

    const badge = chalk.cyan(`[${cortex}]`);
    if (result.deleted === 0) {
      const what = opts.id
        ? `no live entry with id ${opts.id}`
        : opts.match
          ? `no live entries matching "${opts.match}"`
          : 'no live entries';
      console.log(chalk.yellow(`${badge} ${what} — nothing deleted`));
      process.exitCode = 1;
      return;
    }

    console.log(`${chalk.green('✓')} ${badge} deleted ${result.deleted} ${result.deleted === 1 ? 'entry' : 'entries'} (tombstone queued for sync)`);
    for (const entry of result.entries) {
      console.log(chalk.dim(`  ${entry.id}  ${snippet(entry.content)}`));
    }
  });

/**
 * Pre-cortex behavior for installs where no cortex is configured. Kept intact
 * apart from the #84 reporting fix: a zero-delete is no longer presented as
 * success.
 */
async function legacyLocalDelete(opts: { id?: string; match?: string; last?: boolean }): Promise<void> {
  const { getEntries, deleteEntry, deleteEntriesByContent } = await import('../db/queries.js');
  const { closeDb } = await import('../db/client.js');

  try {
    if (opts.id) {
      if (deleteEntry(opts.id)) {
        console.log(chalk.green('✓') + ' Entry deleted');
      } else {
        console.log(chalk.yellow('No matching entry found'));
        process.exitCode = 1;
      }
    } else if (opts.match) {
      const count = deleteEntriesByContent(opts.match);
      if (count > 0) {
        console.log(chalk.green('✓') + ` Deleted ${count} entry(ies) matching "${opts.match}"`);
      } else {
        console.log(chalk.yellow(`No entries matching "${opts.match}" — nothing deleted`));
        process.exitCode = 1;
      }
    } else {
      const entries = getEntries({ limit: 1 });
      if (entries.length === 0) {
        console.log(chalk.yellow('No entries to delete'));
        process.exitCode = 1;
      } else {
        deleteEntry(entries[0].id);
        console.log(chalk.green('✓') + ` Deleted: ${entries[0].content}`);
      }
    }
    closeDb();
  } catch (err) {
    console.error(chalk.red(`Delete error: ${err instanceof Error ? err.message : String(err)}`));
    closeDb();
    process.exitCode = 1;
  }
}
