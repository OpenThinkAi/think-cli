import { Command, Option } from 'commander';
import { spawn } from 'node:child_process';
import chalk from 'chalk';
import { insertEntry } from '../db/queries.js';
import { closeDb } from '../db/client.js';
import { getConfig } from '../lib/config.js';
import { insertEngram, getPendingEngrams } from '../db/engram-queries.js';
import { closeCortexDb } from '../db/engrams.js';
import { checkForUpdate } from '../lib/update-check.js';
import { validateEngramContent, stripControls } from '../lib/sanitize.js';
import { connectDaemon, DaemonUnavailableError } from '../lib/daemon-client.js';
import type { SyncResult as DaemonSyncResult } from '../daemon/sync-handler.js';

export const logCommand = new Command('log')
  .description('Log a note or entry')
  .argument('<message>', 'The message to log')
  .option('-s, --source <source>', 'Source of the entry', 'manual')
  .option('-c, --category <category>', 'Category: note, sync, meeting, decision, idea', 'note')
  .option('-t, --tags <tags>', 'Comma-separated tags')
  .option('--silent', 'Suppress output')
  .action((message: string, opts: { source: string; category: string; tags?: string; silent?: boolean }) => {
    const validated = validateEngramContent(message);
    message = validated.content;
    if (!opts.silent && validated.warnings.length > 0) {
      for (const w of validated.warnings) {
        console.log(chalk.yellow(`  ⚠ ${w}`));
      }
    }

    const tags = opts.tags ? opts.tags.split(',').map(t => t.trim()) : undefined;
    const entry = insertEntry({
      content: message,
      source: opts.source,
      category: opts.category,
      tags,
    });

    if (!opts.silent) {
      const catBadge = chalk.dim(`[${entry.category}]`);
      const ts = chalk.gray(entry.timestamp.slice(0, 16).replace('T', ' '));
      console.log(`${chalk.green('✓')} Logged ${catBadge} ${ts}`);
      console.log(`  ${entry.content}`);
      if (tags && tags.length > 0) {
        console.log(`  ${chalk.cyan('tags:')} ${tags.join(', ')}`);
      }
    }

    closeDb();
  });

// Factory returns a fresh Command instance per call. Tests build a new program
// per test and need an unparented sync command; production calls it once at
// startup via the syncCommand singleton below.
export function makeSyncCommand(): Command {
  return new Command('sync')
    .description('Record a memory entry to the active cortex (or local think.db if no cortex is configured)')
    .argument('<message>', 'The message to log')
    .option('-s, --source <source>', 'Source of the entry', 'manual')
    .option('-t, --tags <tags>', 'Comma-separated tags')
    .option('-e, --episode <key>', 'Tag this memory with an episode identifier for narrative grouping')
    .option('--context <json>', 'Attach structured JSON metadata to this memory')
    .option('-d, --decision <text>', 'Record a decision (repeatable)', (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option('--silent', 'Suppress output')
    .option('--no-push', 'Skip the remote git push after writing (only applies when a daemon is running)')
    .addOption(new Option('--no-sync', 'Deprecated alias for --no-push (preserved for v2 compat)').hideHelp())
    .action(async function (this: Command, message: string, opts: { source: string; tags?: string; episode?: string; context?: string; decision?: string[]; silent?: boolean; push: boolean; sync: boolean }) {
      const globalOpts = this.optsWithGlobals() as { cortex?: string };
      const config = getConfig();

      if (config.paused) {
        // Silently skip — don't break CLAUDE.md auto-logging
        return;
      }

      const cortex = globalOpts.cortex ?? config.cortex?.active;

      // AGT-289: Hook point for daemon write routing. When the daemon write RPC
      // is wired (later phase), the live path will be inserted here with
      // probeDaemon(100) for degraded-mode detection; direct write below is
      // the fallback.

      if (cortex) {
        // Validate and sanitize content before storage
        const validated = validateEngramContent(message);
        message = validated.content;
        if (!opts.silent && validated.warnings.length > 0) {
          for (const w of validated.warnings) {
            console.log(chalk.yellow(`  ⚠ ${w}`));
          }
        }

        // Validate --context is valid JSON if provided
        if (opts.context) {
          try {
            JSON.parse(opts.context);
          } catch {
            console.error(chalk.red('Error: --context must be valid JSON'));
            process.exitCode = 1;
            return;
          }
        }

        // Primary path: route through daemon. Falls back to v2 direct-write on
        // DaemonUnavailableError. v2 compat fields (--episode/--context/--decision)
        // are not yet forwarded by the daemon RPC — bypass daemon when present.
        // See AGT-293 for the rationale and AGT-309 for skipPush handling.
        const hasV2Fields = !!(opts.episode || opts.context || (opts.decision && opts.decision.length > 0));

        // Fire on every cortex-path call including the v2-compat bypass —
        // the message is about flag identity, not execution path.
        if (!opts.sync && !opts.silent) {
          process.stderr.write(chalk.yellow('  warning: --no-sync is deprecated; use --no-push\n'));
        }

        let daemonSucceeded = false;
        let daemonErr: unknown;

        if (!hasV2Fields) {
          try {
            const client = await connectDaemon();
            const skipPush = !opts.push || !opts.sync; // either negated flag
            // Close is best-effort: a throwing close() after a successful daemon
            // commit would otherwise be re-raised, set daemonErr, and trigger the
            // v2 fallback — duplicating the entry. The inner try/finally still
            // guarantees close runs on the call-rejection path.
            let result: DaemonSyncResult;
            try {
              result = await client.call('sync', {
                cortex,
                content: message,
                kind: 'memory',
                skipPush,
              }) as DaemonSyncResult;
            } finally {
              try { client.close(); } catch { /* best-effort */ }
            }

            daemonSucceeded = true;

            if (!opts.silent) {
              const badge = chalk.cyan(`[${cortex}]`);
              // pending L2 flush uses ⏳ instead of ✓ to signal non-durable.
              const safeEntryId = stripControls(result.entry_id);
              if (result.status === 'queued') {
                console.log(`${chalk.yellow('⏳')} ${badge} queued memory ${safeEntryId} (indexing in background)`);
              } else {
                const ts = chalk.gray(new Date().toISOString().slice(0, 16).replace('T', ' '));
                console.log(`${chalk.green('✓')} ${badge} ${ts} stored memory ${safeEntryId}`);
              }
              console.log(`  ${message}`);
              // Surface advisory warnings from the daemon (e.g. pending L2 schema).
              // Array.isArray() guards against a non-array warnings field (the daemon
              // wire type is checked compile-time only via `as DaemonSyncResult`).
              if (Array.isArray(result.warnings) && result.warnings.length > 0) {
                for (const w of result.warnings) {
                  console.log(chalk.dim(`  note: ${stripControls(w)}`));
                }
              }
            }
            // No closeCortexDb() here: the daemon path never opens a cortex
            // SQLite handle (the daemon owns L1/L2 writes via its RPC). The
            // v2 fallback below opens via insertEngram and closes there.
          } catch (err: unknown) {
            daemonErr = err;
          }
        }

        if (!daemonSucceeded) {
          // --- v2 direct-write path (insertEngram) ---
          // Entered when:
          //  (a) v2 compat fields are present (hasV2Fields) — intentional bypass to
          //      ensure those fields are always stored, or
          //  (b) daemon is unavailable (DaemonUnavailableError) — silent degrade, or
          //  (c) unexpected daemon fault — surface on stderr before degrading.
          if (daemonErr && !(daemonErr instanceof DaemonUnavailableError) && !opts.silent) {
            const msg = daemonErr instanceof Error ? daemonErr.message : String(daemonErr);
            // Strip controls on the daemon-sourced error message — Error.message
            // is also an IPC-trust boundary surface. Append an ellipsis when
            // the cleaned message exceeds the 200-char display cap so the user
            // can tell the diagnostic was truncated.
            const cleaned = stripControls(msg);
            const display = cleaned.length > 200 ? cleaned.slice(0, 200) + '…' : cleaned;
            process.stderr.write(chalk.yellow(`  daemon error: ${display}; falling back to local write\n`));
          }

          // Note: --no-push is a no-op on this path. insertEngram is a local
          // SQLite write only; the daemon's git push-debounce loop (AGT-309)
          // owns remote pushes and is bypassed entirely here. The --no-push
          // help text documents this caveat.
          const decisions = opts.decision?.length ? opts.decision : undefined;
          const { engram } = insertEngram(cortex, { content: message, episodeKey: opts.episode, context: opts.context, decisions });

          if (!opts.silent) {
            const badge = chalk.cyan(`[${cortex}]`);
            const ts = chalk.gray(engram.created_at.slice(0, 16).replace('T', ' '));
            const episodeLabel = opts.episode ? chalk.dim(` (episode: ${opts.episode})`) : '';
            console.log(`${chalk.green('✓')} ${badge} ${ts} stored memory ${engram.id}${episodeLabel}`);
            console.log(`  ${engram.content}`);
            // Diagnostic — goes to stderr so callers capturing stdout (e.g.
            // `OUTPUT=$(think sync …)`) don't embed it in their parsed value.
            // Daemon-unavailable path only; the v2-compat bypass is a normal
            // write and doesn't surface a note.
            if (daemonErr instanceof DaemonUnavailableError) {
              process.stderr.write(chalk.dim('  note: daemon unavailable — wrote via local path\n'));
            }
          }

          // Auto-curate if threshold is set and reached (v2 compat)
          const curateEveryN = config.cortex?.curateEveryN;
          if (curateEveryN && curateEveryN > 0) {
            const pending = getPendingEngrams(cortex);
            if (pending.length >= curateEveryN) {
              if (!opts.silent) {
                console.log(chalk.dim(`  ${pending.length} pending memories — triggering curation...`));
              }
              // Close DB before spawning — the child process will open its own connection
              // WAL mode ensures the child can read what we just wrote
              closeCortexDb(cortex);
              // Use process.execPath + process.argv[1] so it works regardless of how think was invoked
              spawn(process.execPath, [process.argv[1], 'curate'], { detached: true, stdio: 'ignore' }).unref();
              return;
            }
          }

          closeCortexDb(cortex);
        }
      } else {
        // No cortex configured — original local think.db path
        const tags = opts.tags ? opts.tags.split(',').map(t => t.trim()) : undefined;
        const entry = insertEntry({
          content: message,
          source: opts.source,
          category: 'sync',
          tags,
        });

        if (!opts.silent) {
          const catBadge = chalk.dim('[sync]');
          const ts = chalk.gray(entry.timestamp.slice(0, 16).replace('T', ' '));
          console.log(`${chalk.green('✓')} Logged ${catBadge} ${ts}`);
          console.log(`  ${entry.content}`);
          if (tags && tags.length > 0) {
            console.log(`  ${chalk.cyan('tags:')} ${tags.join(', ')}`);
          }
        }

        closeDb();
      }

      // Non-blocking update check (cached, runs at most once per 24h)
      if (!opts.silent) {
        const updateMsg = checkForUpdate();
        if (updateMsg) {
          console.log(chalk.yellow(`  ℹ ${updateMsg}`));
        }
      }
    });
}

export const syncCommand = makeSyncCommand();
