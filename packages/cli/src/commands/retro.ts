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
import { getConfig } from '../lib/config.js';
import { detectWorkingContext, contextTopic, normalizeContext } from '../lib/working-context.js';

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
  /** AGT-455: true when this write was folded into an existing near-duplicate retro. */
  folded?: boolean;
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
  .description('Record a durable lesson onto your home cortex, tagged by repo context')
  .argument('<content>', 'The observation to record'))
  .option('--force', 'Bypass the write-time quality gate (length floor + junk-shape check)')
  .option('--context <name>', 'Context this lesson is about (default: the git repo you are in)')
  .addHelpText('after', `
Requirements:
  Requires the think daemon (start it with: think daemon start).

Storage model (iterative-learning v3 — see docs/iterative-learning-v3-locality.md):
  A retro is stored on your HOME cortex (the active cortex, or -C <name>) and
  TAGGED with the context it is about — it is no longer routed to a separate
  per-context branch. The context is auto-detected from the git repo you run the
  command in (its root basename), encoded as a 'repo:<context>' topic so recall
  and 'think brief' can scope to it. Different teams/home cortices can hold
  different lessons for the same context — that is intended.

  Common case is zero-flag:  think retro "<lesson>"   (context auto-detected)
  Outside a git repo, the retro is stored untagged (a global lesson).

  Retros have no TTL and are never purged. Text is preserved exactly as written.
  Supersession check runs asynchronously on the daemon side.

Cortex vs context (v3):
  '-C <name>' / '--cortex <name>' now selects the HOME cortex to STORE on
  (your team/personal corpus). It no longer routes to a per-context branch.
  Use '--context <name>' to set the repo tag when auto-detection is wrong.
  Old 'think retro "..." --cortex <repo>' invocations now store on a cortex
  named <repo>; update them to '--context <repo>' (run 'think retro-migrate'
  to fold legacy per-repo cortices into your home cortex).

Reads:
  To recall retros, use: think recall --kind retro [--topic repo:<context>]
  At task start:          think brief        (scopes to the current repo context)

Examples:
  think retro "tests run after merge, before push — don't push without checks"
  think retro "users hate the modal" --topic ux
  think retro "strategy engine type contracts are undocumented" --context fx-tracker
  think -C engineering retro "always run migrations in a transaction"
`)
  .action(async function (this: Command, content: string, opts: { topic: string[]; cortex?: string; context?: string; force?: boolean }) {

    // Guard against v2 muscle memory: "think retro add <obs>" or
    // "think retro recall" — the former would silently write "add" as the
    // retro content; the latter would write "recall". Both are silent-corruption
    // footguns. Print a targeted migration message instead.
    if (content === 'add') {
      console.error(chalk.red('think retro: "add" is no longer a subcommand.'));
      console.error(chalk.yellow('  v3 usage: think retro "<your observation>"   (context auto-detected)'));
      console.error(chalk.yellow('  (drop "add" — the content is now the first positional argument)'));
      process.exitCode = 1;
      return;
    }
    if (content === 'recall') {
      console.error(chalk.red('think retro: "recall" is no longer a subcommand.'));
      console.error(chalk.yellow('  To read retros, use: think recall --kind retro [--topic repo:<context>]'));
      process.exitCode = 1;
      return;
    }

    const { topics } = extractWriteOpts(opts);
    const config = getConfig();

    // ── Storage cortex (the user's home/team) ────────────────────────────────
    // v3 reverses the old "retros require --cortex and live on a per-context
    // branch" rule. Storage is now the home cortex: the global `-C`/`--cortex`
    // (read from the parent program opts), else the active cortex from config.
    //
    // Note: `--cortex` is both a program-global (`-C`) and a command-local
    // option (from addWriteOptions), but commander routes the long name to the
    // program option in every position, so `this.parent.opts().cortex` is the
    // single source of truth and the command-local copy is never populated.
    // `--cortex`/`-C` therefore means storage only; use `--context` for the
    // repo tag.
    const globalCortex = (this.parent?.opts() as { cortex?: string } | undefined)?.cortex;
    const storageCortex = globalCortex ?? config.cortex?.active;

    if (!storageCortex) {
      console.error(chalk.red('think retro: no home cortex set.'));
      console.error(chalk.red('Set one with: think cortex switch <name>   or pass: think -C <name> retro "..."'));
      process.exitCode = 1;
      return;
    }

    // ── Context tag (what the lesson is about) ────────────────────────────────
    // Precedence: explicit --context  >  the git repo we're in (auto)  >  none
    // (untagged "global" lesson).
    const context: string | null = opts.context
      ? normalizeContext(opts.context)
      : detectWorkingContext();

    // Fold the context into the topics as a reserved 'repo:<context>' tag so it
    // rides the existing topics_json column + recall topic filter (AGT-320).
    const baseTopics = topics ?? [];
    const finalTopics = context ? [...baseTopics, contextTopic(context)] : baseTopics;

    try {
      const client = await connectDaemon();
      let result: DaemonSyncResult;
      try {
        result = await client.call('sync', {
          cortex: storageCortex,
          content,
          kind: 'retro',
          ...(finalTopics.length > 0 ? { topics: finalTopics } : {}),
          ...(opts.force ? { force: true } : {}),
        }) as DaemonSyncResult;
      } finally {
        try { client.close(); } catch { /* best-effort */ }
      }

      const safeEntryId = stripControls(result.entry_id);
      const ctxTag = context ? chalk.dim(` (context: ${context})`) : chalk.dim(' (untagged — not in a git repo)');
      const badge = chalk.cyan(`[${storageCortex}]`) + ctxTag;
      const excerpt = content.length > 60 ? content.slice(0, 60) + '…' : content;
      if (result.folded) {
        // AGT-455: the write was a near-duplicate of an existing retro and was
        // folded into it (occurrences++). entry_id is the existing canonical row.
        console.log(`${chalk.green('✓')} ${badge} folded into existing retro ${safeEntryId} (near-duplicate)`);
      } else if (result.status === 'queued') {
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
        // Generous cap so git's remediation hint (e.g. "Please commit your
        // changes or stash them…") survives instead of being cut mid-sentence (#69).
        const display = cleaned.length > 1000 ? cleaned.slice(0, 1000) + '…' : cleaned;
        console.error(chalk.red(`think retro: daemon error — ${display}`));
        process.exitCode = 1;
      }
    }
  });
