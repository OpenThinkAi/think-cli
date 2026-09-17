import { Command, Option } from 'commander';
import chalk from 'chalk';
import { insertEntry } from '../db/queries.js';
import { closeDb } from '../db/client.js';
import { getConfig } from '../lib/config.js';
import { checkForUpdate } from '../lib/update-check.js';
import { validateEngramContent, stripControls } from '../lib/sanitize.js';
import { connectDaemon, DaemonUnavailableError } from '../lib/daemon-client.js';
import type { SyncResult as DaemonSyncResult } from '../daemon/sync-handler.js';
import { addWriteOptions, extractWriteOpts } from '../lib/write-options.js';
import { writeDaemonDownEntry } from '../lib/l1-fallback.js';

// Factory returns a fresh Command instance per call. Tests build a new program
// per test and need an unparented sync command; production calls it once at
// startup via the syncCommand singleton below.
export function makeSyncCommand(): Command {
  return addWriteOptions(new Command('sync')
    .description('Record a memory entry to the active cortex (or local think.db if no cortex is configured)')
    .argument('<message>', 'The message to log')
    .option('-s, --source <source>', 'Source of the entry', 'manual')
    .option('-t, --tags <tags>', 'Comma-separated tags')
    .option('--silent', 'Suppress output (the daemon-unreachable note still goes to stderr)')
    .option('--no-push', 'Skip the remote git push after writing (only applies when a daemon is running)'))
    .addOption(new Option('--no-sync', 'Deprecated alias for --no-push (preserved for v2 compat)').hideHelp())
    // think-3 (AGT-1297): -e/--episode, --context and -d/--decision are
    // hard-removed engram-tier fields. Kept registered-but-hidden (rather than
    // dropped outright) so passing one gets our own one-line pointer instead
    // of commander's generic "unknown option" — see the rejection block at
    // the top of the action below. No warn-and-accept window: this always
    // exits non-zero, even under --silent.
    .addOption(new Option('-e, --episode <key>', 'Removed — use `think event`').hideHelp())
    .addOption(new Option('--context <json>', 'Removed — use `think event`').hideHelp())
    .addOption(new Option('-d, --decision <text>', 'Removed — use `think event`').hideHelp())
    .addHelpText('after', `
Examples:
  think sync "fixed the auth race condition"
  think sync "merged the JWT refresh PR" --topic auth --topic jwt
  think -C my-repo sync "landed the v2 migration"
`)
    .action(async function (this: Command, message: string, opts: { topic: string[]; cortex?: string; source: string; tags?: string; episode?: string; context?: string; decision?: string; silent?: boolean; push: boolean; sync: boolean }) {
      // AGT-1297: hard-remove the pre-daemon engram fields. Checked first and
      // unconditionally (before --silent is even read) so nothing downstream
      // — including the config.paused early-return — can turn this into a
      // silent no-op that still looks like a write happened.
      if (opts.decision !== undefined) {
        process.stderr.write('error: --decision has been removed; use `think event "Decided ..."` instead\n');
        process.exitCode = 1;
        return;
      }
      if (opts.context !== undefined) {
        process.stderr.write('error: --context has been removed; use `think event` instead\n');
        process.exitCode = 1;
        return;
      }
      if (opts.episode !== undefined) {
        process.stderr.write('error: -e/--episode has been removed; use `think event` instead\n');
        process.exitCode = 1;
        return;
      }

      const globalOpts = this.optsWithGlobals() as { cortex?: string };
      const config = getConfig();

      if (config.paused) {
        // Silently skip — don't break CLAUDE.md auto-logging
        return;
      }

      const { topics, cortex: localCortex } = extractWriteOpts(opts);
      const cortex = localCortex ?? globalOpts.cortex ?? config.cortex?.active;

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

        // Primary path: route through daemon, falling back to the v2
        // direct-write below on DaemonUnavailableError (AGT-1298 replaces
        // this fallback with an L1 write; see AGT-293 for the original
        // rationale and AGT-309 for skipPush handling).
        if (!opts.sync && !opts.silent) {
          process.stderr.write(chalk.yellow('  warning: --no-sync is deprecated; use --no-push\n'));
        }

        let daemonSucceeded = false;
        let daemonErr: unknown;

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
              ...(topics ? { topics } : {}),
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
          // SQLite handle (the daemon owns L1/L2 writes via its RPC).
        } catch (err: unknown) {
          daemonErr = err;
        }

        if (!daemonSucceeded) {
          // --- daemon-unreachable path: write to L1 (AGT-1298) ---
          // Entered when the daemon is unavailable (DaemonUnavailableError —
          // silent degrade) or faulted unexpectedly (surfaced on stderr first).
          // The entry goes to the cortex's l1_outbox, which the daemon drains
          // into L1 and indexes into L2 on its next start — never to the
          // engrams table, which nothing drains and nothing recalls.
          if (daemonErr && !(daemonErr instanceof DaemonUnavailableError) && !opts.silent) {
            const msg = daemonErr instanceof Error ? daemonErr.message : String(daemonErr);
            // Strip controls on the daemon-sourced error message — Error.message
            // is also an IPC-trust boundary surface. Append an ellipsis when
            // the cleaned message exceeds the display cap so the user can tell
            // the diagnostic was truncated. Cap is generous (1000) so git's
            // remediation hint (e.g. "Please commit your changes or stash
            // them…") survives rather than being cut mid-sentence (#69).
            const cleaned = stripControls(msg);
            const display = cleaned.length > 1000 ? cleaned.slice(0, 1000) + '…' : cleaned;
            process.stderr.write(chalk.yellow(`  daemon error: ${display}; falling back to local write\n`));
          }

          // Note: --no-push is a no-op on this path. The daemon's git
          // push-debounce loop (AGT-309) owns remote pushes and is bypassed
          // entirely here. The --no-push help text documents this caveat.
          let written: { id: string; ts: string };
          try {
            written = writeDaemonDownEntry({ cortex, content: message, kind: 'memory', topics });
          } catch (writeErr: unknown) {
            // Nowhere durable to put the entry — say so and fail loudly rather
            // than reporting a write that did not happen (AGT-1298 AC4).
            const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
            process.stderr.write(chalk.red(`  error: daemon unavailable and the L1 write failed: ${stripControls(msg)}\n`));
            process.exitCode = 1;
            return;
          }

          if (!opts.silent) {
            const badge = chalk.cyan(`[${cortex}]`);
            const ts = chalk.gray(written.ts.slice(0, 16).replace('T', ' '));
            console.log(`${chalk.green('✓')} ${badge} ${ts} stored memory ${written.id}`);
            console.log(`  ${message}`);
          }
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
