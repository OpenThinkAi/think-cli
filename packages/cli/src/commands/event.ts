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
import { validateEngramContent } from '../lib/sanitize.js';
import { connectDaemon, DaemonUnavailableError } from '../lib/daemon-client.js';

/**
 * Interface for the daemon `sync` RPC result when used for event entries.
 * Matches SyncResult in packages/cli/src/daemon/sync-handler.ts (AGT-286).
 */
interface DaemonSyncResult {
  entry_id: string;
  status: 'stored' | 'queued';
  warnings?: string[];
}

/**
 * Strip ANSI/control characters from a daemon-sourced string before printing.
 * The daemon socket is an IPC boundary -- a rogue responder could otherwise
 * inject OSC/CSI sequences into the terminal.
 */
function stripControls(s: unknown): string {
  return String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

// Factory returns a fresh Command instance per call. Tests build a new program
// per test and need an unparented event command; production calls it once at
// startup via the eventCommand singleton below.
export function makeEventCommand(): Command {
  return new Command('event')
    .description('Record a notable event to the active cortex (milestone, deploy, decision, incident)')
    .argument('<message>', 'The event to record')
    .option('--topic <topic>', 'Tag this event with a topic (repeatable)', (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option('--cortex <name>', 'Override the active cortex for this write')
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

      // Local --cortex flag takes precedence over global -C flag.
      const cortex = opts.cortex ?? globalOpts.cortex ?? config.cortex?.active;

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
              topics: opts.topic.length > 0 ? opts.topic : undefined,
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
          if (daemonErr && !(daemonErr instanceof DaemonUnavailableError) && !opts.silent) {
            const msg = daemonErr instanceof Error ? daemonErr.message : String(daemonErr);
            const cleaned = stripControls(msg);
            const display = cleaned.length > 200 ? cleaned.slice(0, 200) + '...' : cleaned;
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
