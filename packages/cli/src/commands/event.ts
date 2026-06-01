/**
 * `think event` command -- AGT-295
 *
 * Records a notable event (milestone, deploy, decision, incident) to the
 * active cortex as kind="event". Events are stored as-written and never
 * auto-superseded -- they accumulate as history.
 *
 * Contrast with `think sync` (kind="memory"), which is the ongoing work
 * stream and is subject to write-time compaction. Use `sync` for the work
 * stream; use `event` for one-off notable things worth marking as history.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { insertEntry } from '../db/queries.js';
import { closeDb } from '../db/client.js';
import { getConfig } from '../lib/config.js';
import { insertEngram } from '../db/engram-queries.js';
import { closeCortexDb } from '../db/engrams.js';
import { validateEngramContent, stripControls } from '../lib/sanitize.js';
import { connectDaemon, DaemonUnavailableError } from '../lib/daemon-client.js';
import type { SyncResult as DaemonSyncResult } from '../daemon/sync-handler.js';
import { addWriteOptions, extractWriteOpts } from '../lib/write-options.js';

// Factory returns a fresh Command instance per call. Tests build a new program
// per test and need an unparented event command; production calls it once at
// startup via the eventCommand singleton below.
export function makeEventCommand(): Command {
  return addWriteOptions(new Command('event')
    .description('Record a notable event to the active cortex (milestone, deploy, decision, incident)')
    .argument('<message>', 'The event to record'))
    .option('--silent', 'Suppress output')
    .option('--no-push', 'Skip the remote git push after writing (only applies when a daemon is running)')
    .addHelpText('after', `
Use 'sync' for the ongoing work stream; use 'event' for one-off notable things
worth marking as history (deploys, milestones, decisions, incidents).

Unlike memories, events are stored as-written and never auto-superseded --
they accumulate as a permanent record.

Examples:
  think event "deployed v1.2.0 to production"
  think event "decided to migrate from SQLite to Postgres" --topic architecture
  think event "incident: auth service down 14:00-14:45 UTC" --topic reliability
  think -C my-repo event "cut 2.0.0 release"
`)
    .action(async function (this: Command, message: string, opts: {
      topic: string[];
      cortex?: string;
      silent?: boolean;
      push: boolean;
    }) {
      const globalOpts = this.optsWithGlobals() as { cortex?: string };
      const config = getConfig();

      if (config.paused) {
        // Silently skip -- don't break CLAUDE.md auto-logging
        return;
      }

      const { topics, cortex: localCortex } = extractWriteOpts(opts);

      // Local --cortex flag takes precedence over global -C flag.
      const cortex = localCortex ?? globalOpts.cortex ?? config.cortex?.active;

      if (cortex) {
        // Validate and sanitize content before storage.
        const validated = validateEngramContent(message);
        message = validated.content;
        if (!opts.silent && validated.warnings.length > 0) {
          for (const w of validated.warnings) {
            console.log(chalk.yellow(`  ⚠ ${w}`));
          }
        }

        let daemonSucceeded = false;
        let daemonErr: unknown;

        try {
          const client = await connectDaemon();
          const skipPush = !opts.push;
          let result: DaemonSyncResult;
          try {
            result = await client.call('sync', {
              cortex,
              content: message,
              kind: 'event',
              topics,
              skipPush,
            }) as DaemonSyncResult;
          } finally {
            try { client.close(); } catch { /* best-effort */ }
          }

          daemonSucceeded = true;

          if (!opts.silent) {
            const badge = chalk.cyan(`[${cortex}]`);
            const safeEntryId = stripControls(result.entry_id);
            if (result.status === 'queued') {
              console.log(`${chalk.yellow('⏳')} ${badge} queued event ${safeEntryId} (indexing in background)`);
            } else {
              console.log(`${chalk.green('✓')} ${badge} stored event ${safeEntryId}`);
            }
            console.log(`  ${message}`);
            if (Array.isArray(result.warnings) && result.warnings.length > 0) {
              for (const w of result.warnings) {
                console.log(chalk.dim(`  note: ${stripControls(w)}`));
              }
            }
          }
        } catch (err: unknown) {
          daemonErr = err;
        }

        if (!daemonSucceeded) {
          // --- v2 direct-write path (insertEngram) ---
          // Entered when:
          //  (a) daemon is unavailable (DaemonUnavailableError) -- silent degrade, or
          //  (b) unexpected daemon fault -- surface on stderr before degrading.
          //
          // NOTE: The v2 `engrams` table has no `kind` column, so kind="event" is
          // NOT preserved on this path. The entry is stored as a plain engram.
          // This is an acknowledged limitation of the degraded fallback: the v2
          // schema predates the v3 kind system. The daemon is the canonical write
          // path; the fallback exists only to prevent data loss when the daemon is
          // unavailable. A future schema migration (out of scope here) will align
          // the v2 table with the v3 entry model.
          if (daemonErr && !(daemonErr instanceof DaemonUnavailableError) && !opts.silent) {
            const msg = daemonErr instanceof Error ? daemonErr.message : String(daemonErr);
            const cleaned = stripControls(msg);
            // Generous cap (#69) so git remediation hints survive untruncated.
            const display = cleaned.length > 1000 ? cleaned.slice(0, 1000) + '...' : cleaned;
            process.stderr.write(chalk.yellow(`  daemon error: ${display}; falling back to local write\n`));
          }

          const { engram } = insertEngram(cortex, { content: message });

          if (!opts.silent) {
            const badge = chalk.cyan(`[${cortex}]`);
            console.log(`${chalk.green('✓')} ${badge} stored event ${engram.id}`);
            console.log(`  ${engram.content}`);
            if (daemonErr instanceof DaemonUnavailableError) {
              process.stderr.write(chalk.dim('  note: daemon unavailable -- wrote via local path\n'));
            }
          }

          closeCortexDb(cortex);
        }
      } else {
        // No cortex configured -- fall back to local think.db.
        const validated = validateEngramContent(message);
        message = validated.content;

        const entry = insertEntry({
          content: message,
          source: 'manual',
          category: 'event',
        });

        if (!opts.silent) {
          const catBadge = chalk.dim('[event]');
          const ts = chalk.gray(entry.timestamp.slice(0, 16).replace('T', ' '));
          console.log(`${chalk.green('✓')} Logged ${catBadge} ${ts}`);
          console.log(`  ${entry.content}`);
        }

        closeDb();
      }
    });
}

export const eventCommand = makeEventCommand();
