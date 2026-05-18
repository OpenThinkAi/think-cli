/**
 * `think retro "<content>"` — AGT-294
 *
 * Routes through the daemon sync RPC with kind="retro". Text is never
 * rewritten (no compaction); supersession check runs asynchronously on
 * the daemon side (AGT-305, out of scope here).
 *
 * Flags:
 *   --cortex <name>     Override active cortex (retros may target any cortex)
 *   --topic <topic>     Attach a topic tag (repeatable); passed through to daemon
 *
 * v2 `think retro add` and `think retro recall` subcommands are removed
 * per AGT-294 AC #5 (clean break). The v2 retro-curator (`think curate-retros`)
 * may coexist but is not invoked by this path (AC #6).
 *
 * Mirror of the `think sync` pattern in commands/log.ts (AGT-293).
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig } from '../lib/config.js';
import { connectDaemon, DaemonUnavailableError } from '../lib/daemon-client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Response shape for the daemon `sync` RPC.
 * Mirrors DaemonSyncResult in commands/log.ts (AGT-293).
 * Kept local to avoid coupling the CLI command layer to the daemon entry point.
 */
interface DaemonSyncResult {
  entry_id: string;
  status: 'stored' | 'queued';
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip ANSI/control characters from a daemon-sourced string before printing.
 * The daemon socket is an IPC boundary — a rogue responder could otherwise
 * inject OSC/CSI sequences into the terminal. Covers both the C0 range
 * (\x00-\x1f, DEL) and the 8-bit C1 range (\x80-\x9f).
 */
function stripControls(s: unknown): string {
  return String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const retroCommand = new Command('retro')
  .description('Record a permanent codebase observation to a cortex')
  .argument('<content>', 'The observation to record')
  .option('--cortex <name>', 'Target cortex (required; overrides -C global flag)')
  .option('--topic <topic>', 'Tag this retro with a topic (repeatable)', (val: string, prev: string[]) => [...prev, val], [] as string[])
  .addHelpText('after', `
Storage contract:
  Retros have no TTL and are never purged. Text is preserved exactly as written.
  Supersession check (AGT-305) runs asynchronously on the daemon side.

  --cortex is required (pass it directly or via the global -C flag).
  Retros scope to a specific codebase or tool, not the current working context.

  A cortex must already exist (run 'think cortex create <name>' if needed).

Examples:
  think retro "users hate the modal" --topic ux
  think retro "always run migrations in a transaction" --cortex my-repo
  think -C fx-tracker retro "strategy engine type contracts are not documented"
  think retro "AGT-169 pattern" --cortex think-cli --topic prior_decision
`)
  .action(async function (this: Command, content: string, opts: { cortex?: string; topic: string[] }) {
    const globalOpts = this.optsWithGlobals() as { cortex?: string };
    const config = getConfig();

    const cortex = opts.cortex ?? globalOpts.cortex ?? config.cortex?.active;

    if (!cortex) {
      console.error(chalk.red('think retro: --cortex is required (no fallback to working directory — retros are scoped to a specific codebase or tool).'));
      console.error(chalk.red('Pass it as: think retro "..." --cortex <name>  or  think -C <name> retro "..."'));
      process.exitCode = 1;
      return;
    }

    const topics = opts.topic.length > 0 ? opts.topic : undefined;

    try {
      const client = await connectDaemon();
      let result: DaemonSyncResult;
      try {
        result = await client.call('sync', {
          cortex,
          content,
          kind: 'retro',
          ...(topics ? { topics } : {}),
        }) as DaemonSyncResult;
      } finally {
        try { client.close(); } catch { /* best-effort */ }
      }

      const safeEntryId = stripControls(result.entry_id);
      console.log(`${chalk.green('✓')} stored retro ${safeEntryId}`);

      if (Array.isArray(result.warnings) && result.warnings.length > 0) {
        for (const w of result.warnings) {
          console.log(chalk.dim(`  note: ${stripControls(w)}`));
        }
      }
    } catch (err: unknown) {
      if (err instanceof DaemonUnavailableError) {
        console.error(chalk.red('think retro: daemon unavailable.'));
        console.error(chalk.red(`  Start it with: think daemon start`));
        console.error(chalk.dim(`  (log: ${err.logPath})`));
        process.exitCode = 1;
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        const cleaned = stripControls(msg);
        const display = cleaned.length > 200 ? cleaned.slice(0, 200) + '…' : cleaned;
        console.error(chalk.red(`think retro: daemon error — ${display}`));
        process.exitCode = 1;
      }
    }
  });
