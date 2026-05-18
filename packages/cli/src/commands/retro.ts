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
import { connectDaemon, DaemonUnavailableError } from '../lib/daemon-client.js';
import { addWriteOptions, extractWriteOpts } from '../lib/write-options.js';

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

export const retroCommand = addWriteOptions(new Command('retro')
  .description('Record a permanent codebase observation to a cortex')
  .argument('<content>', 'The observation to record'))
  .addHelpText('after', `
Requirements:
  Requires the think daemon (start it with: think daemon start).

Storage contract:
  Retros have no TTL and are never purged. Text is preserved exactly as written.
  Supersession check (AGT-305) runs asynchronously on the daemon side.

  --cortex is required. No fallback to the active cortex — retros are scoped
  to a specific codebase or tool, not the user's current working context.
  A cortex must already exist (run 'think cortex create <name>' if needed).

v2 migration notes:
  - 'think retro add "<obs>"' → 'think retro "<obs>"' (drop "add")
  - 'think retro recall' → 'think recall --kind retro' (use unified recall)
  - '--kind convention|invariant|prior_decision|gotcha' → '--topic <tag>' (open string)

Reads:
  To recall retros, use: think recall --kind retro [--cortex <name>]

Examples:
  think retro "users hate the modal" --topic ux
  think retro "always run migrations in a transaction" --cortex fx-tracker
  think -C fx-tracker retro "strategy engine type contracts are not documented"
  think retro "AGT-169 pattern" --cortex think-cli --topic prior_decision
`)
  .action(async function (this: Command, content: string, opts: { topic: string[]; cortex?: string }) {
    const globalOpts = this.optsWithGlobals() as { cortex?: string };

    // Guard against v2 muscle memory: "think retro add <obs>" or
    // "think retro recall" — the former would silently write "add" as the
    // retro content; the latter would write "recall". Both are silent-corruption
    // footguns. Print a targeted migration message instead.
    if (content === 'add') {
      console.error(chalk.red('think retro: "add" is no longer a subcommand.'));
      console.error(chalk.yellow('  v3 usage: think retro "<your observation>" --cortex <name>'));
      console.error(chalk.yellow('  (drop "add" — the content is now the first positional argument)'));
      process.exitCode = 1;
      return;
    }
    if (content === 'recall') {
      console.error(chalk.red('think retro: "recall" is no longer a subcommand.'));
      console.error(chalk.yellow('  To read retros, use: think recall --kind retro [--cortex <name>]'));
      process.exitCode = 1;
      return;
    }

    const { topics, cortex: localCortex } = extractWriteOpts(opts);

    // Intentionally no fallback to config.cortex?.active — retros are scoped
    // to a specific codebase or tool, not the user's current working context.
    const cortex = localCortex ?? globalOpts.cortex;

    if (!cortex) {
      console.error(chalk.red('think retro: --cortex is required. Retros scope to a specific codebase or tool.'));
      console.error(chalk.red('Pass it as: think retro "..." --cortex <name>  or  think -C <name> retro "..."'));
      process.exitCode = 1;
      return;
    }

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
      const badge = chalk.cyan(`[${cortex}]`);
      const excerpt = content.length > 60 ? content.slice(0, 60) + '…' : content;
      if (result.status === 'queued') {
        console.log(`${chalk.yellow('⏳')} ${badge} queued retro ${safeEntryId}`);
      } else {
        console.log(`${chalk.green('✓')} ${badge} stored retro ${safeEntryId}`);
      }
      console.log(`  ${excerpt}`);

      if (Array.isArray(result.warnings) && result.warnings.length > 0) {
        for (const w of result.warnings) {
          console.log(chalk.dim(`  note: ${stripControls(w)}`));
        }
      }
    } catch (err: unknown) {
      if (err instanceof DaemonUnavailableError) {
        console.error(chalk.red('think retro: daemon unavailable.'));
        console.error(chalk.red(`  Start it with: think daemon start`));
        console.error(chalk.dim(`  (log: ${stripControls(err.logPath)})`));
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
