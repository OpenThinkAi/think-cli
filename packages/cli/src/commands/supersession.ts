/**
 * `think supersession` — inspect and revert supersession links (issue #87).
 *
 * Supersession hides an entry from active recall. When the link is wrong
 * (curation superseded an entry with an unrelated one), the record silently
 * vanishes with no CLI-level way to discover or undo it. These subcommands
 * close that gap:
 *
 *   think supersession show <id>    — why is this entry hidden? what did it
 *                                     supersede? what superseded it?
 *   think supersession revert <id>  — clear the supersession, restoring the
 *                                     entry to active recall.
 *
 * Supersession state (`superseded_at`/`superseded_by`) is per-peer LOCAL
 * index state — it is not synced through L1 and is derived independently by
 * each peer's curation. A revert therefore fully restores the entry on this
 * machine; other peers whose curation made the same link revert theirs
 * independently.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig } from '../lib/config.js';
import { getCortexDb, closeCortexDb } from '../db/engrams.js';
import { sanitizeName } from '../lib/paths.js';

interface EntryRow {
  id: string;
  ts: string;
  kind: string | null;
  content: string;
  deleted_at: string | null;
  superseded_by: string | null;
  superseded_at: string | null;
}

function snippet(content: string, max = 100): string {
  const oneLine = content.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function resolveCortex(cmd: Command): string | null {
  const globalOpts = cmd.optsWithGlobals() as { cortex?: string };
  return globalOpts.cortex ?? getConfig().cortex?.active ?? null;
}

const showSubcommand = new Command('show')
  .description('Show the supersession state of an entry: what hid it, and what it hid')
  .argument('<id>', 'Entry id')
  .action(function (this: Command, id: string) {
    const cortex = resolveCortex(this);
    if (!cortex) {
      console.error(chalk.red('No active cortex configured (and no -C given).'));
      process.exitCode = 1;
      return;
    }
    const safeCortex = sanitizeName(cortex);
    const db = getCortexDb(safeCortex);
    try {
      const row = db.prepare(
        `SELECT id, ts, kind, content, deleted_at, superseded_by, superseded_at
         FROM memories WHERE id = ?`,
      ).get(id) as EntryRow | undefined;

      if (!row) {
        console.log(chalk.yellow(`[${safeCortex}] no entry with id ${id}`));
        process.exitCode = 1;
        return;
      }

      const state = row.deleted_at
        ? chalk.red(`deleted ${row.deleted_at}`)
        : row.superseded_at
          ? chalk.yellow(`superseded ${row.superseded_at}`)
          : chalk.green('active');
      console.log(`${chalk.cyan(`[${safeCortex}]`)} ${row.id}  ${chalk.gray(row.ts.slice(0, 10))}  [${row.kind ?? 'memory'}]  ${state}`);
      console.log(`  ${snippet(row.content)}`);

      if (row.superseded_by) {
        const by = db.prepare('SELECT id, ts, content FROM memories WHERE id = ?')
          .get(row.superseded_by) as { id: string; ts: string; content: string } | undefined;
        console.log(chalk.yellow('  superseded by:'));
        if (by) {
          console.log(`    ${by.id}  ${chalk.gray(by.ts.slice(0, 10))}`);
          console.log(`    ${snippet(by.content)}`);
        } else {
          console.log(`    ${row.superseded_by} ${chalk.dim('(entry not found in this index)')}`);
        }
        console.log(chalk.dim(`  restore with: think supersession revert ${row.id}`));
      }

      const supersedes = db.prepare(
        'SELECT id, ts, content FROM memories WHERE superseded_by = ? ORDER BY ts ASC',
      ).all(row.id) as { id: string; ts: string; content: string }[];
      if (supersedes.length > 0) {
        console.log(chalk.dim(`  supersedes ${supersedes.length} entr${supersedes.length === 1 ? 'y' : 'ies'}:`));
        for (const s of supersedes) {
          console.log(`    ${s.id}  ${chalk.gray(s.ts.slice(0, 10))}  ${chalk.dim(snippet(s.content, 70))}`);
        }
      }
    } finally {
      closeCortexDb(safeCortex);
    }
  });

const revertSubcommand = new Command('revert')
  .description('Clear a supersession link, restoring the entry to active recall on this machine')
  .argument('<id>', 'Entry id to restore')
  .action(function (this: Command, id: string) {
    const cortex = resolveCortex(this);
    if (!cortex) {
      console.error(chalk.red('No active cortex configured (and no -C given).'));
      process.exitCode = 1;
      return;
    }
    const safeCortex = sanitizeName(cortex);
    const db = getCortexDb(safeCortex);
    try {
      const row = db.prepare(
        'SELECT id, superseded_by, superseded_at FROM memories WHERE id = ?',
      ).get(id) as Pick<EntryRow, 'id' | 'superseded_by' | 'superseded_at'> | undefined;

      if (!row) {
        console.log(chalk.yellow(`[${safeCortex}] no entry with id ${id}`));
        process.exitCode = 1;
        return;
      }
      if (!row.superseded_at) {
        console.log(chalk.yellow(`[${safeCortex}] entry ${id} is not superseded — nothing to revert`));
        process.exitCode = 1;
        return;
      }

      db.prepare(
        'UPDATE memories SET superseded_at = NULL, superseded_by = NULL WHERE id = ?',
      ).run(id);
      console.log(
        `${chalk.green('✓')} ${chalk.cyan(`[${safeCortex}]`)} reverted supersession of ${id} ` +
        `(was superseded by ${row.superseded_by ?? 'unknown'}) — entry is active again on this machine`,
      );
    } finally {
      closeCortexDb(safeCortex);
    }
  });

export const supersessionCommand = new Command('supersession')
  .description('Inspect and revert supersession links (superseded entries are hidden from active recall)')
  .addCommand(showSubcommand)
  .addCommand(revertSubcommand);
