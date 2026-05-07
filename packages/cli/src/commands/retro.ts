import { existsSync } from 'node:fs';
import { Command } from 'commander';
import chalk from 'chalk';
import { getCortexDb, closeCortexDb } from '../db/engrams.js';
import {
  insertRetro,
  searchRetros,
  bumpRecallStats,
  VALID_KINDS,
  type RetroKind,
} from '../db/retro-queries.js';
import { validateEngramContent } from '../lib/sanitize.js';
import { getEngramDbPath } from '../lib/paths.js';

// Returns RetroKind|null on success, false on validation error (caller must check).
function parseKindOpt(kindStr: string | undefined): RetroKind | null | false {
  if (kindStr === undefined) return null;
  if (!(VALID_KINDS as readonly string[]).includes(kindStr)) {
    console.error(chalk.red(`Invalid --kind value: "${kindStr}"`));
    console.error(chalk.red(`Accepted values: ${VALID_KINDS.join(', ')}`));
    process.exitCode = 1;
    return false;
  }
  return kindStr as RetroKind;
}

function emitRetro(cortex: string, message: string, kind: RetroKind | null): void {
  const validated = validateEngramContent(message);
  if (validated.warnings.length > 0) {
    for (const w of validated.warnings) {
      console.log(chalk.yellow(`  ⚠ ${w}`));
    }
  }

  const isNewCortex = !existsSync(getEngramDbPath(cortex));
  getCortexDb(cortex);

  if (isNewCortex) {
    console.log(`${chalk.green('✓')} created cortex ${chalk.cyan(`[${cortex}]`)}`);
  }

  const row = insertRetro(cortex, { content: validated.content, kind });

  const badge = chalk.cyan(`[${cortex}]`);
  const ts = chalk.gray(row.created_at.slice(0, 16).replace('T', ' '));
  const kindLabel = row.kind ? chalk.dim(` (${row.kind})`) : '';
  console.log(`${chalk.green('✓')} ${badge} retro added ${ts}${kindLabel}`);
  console.log(`  ${row.content}`);

  closeCortexDb(cortex);
}

// Explicit emit subcommand: think retro add "<message>"
const addSubcommand = new Command('add')
  .description('Emit a retro (explicit form; equivalent to: think retro "<message>")')
  .argument('<message>', 'The observation to record')
  .option('--kind <kind>', `Observation kind: ${VALID_KINDS.join(' | ')}`)
  .action(function (this: Command, message: string, opts: { kind?: string }) {
    const globalOpts = this.optsWithGlobals() as { cortex?: string };
    const cortex = globalOpts.cortex;

    if (!cortex) {
      console.error(chalk.red('think retro add: --cortex is required (no fallback to active cortex — retros are scoped to a specific codebase or tool).'));
      console.error(chalk.red('Pass it as: think retro add "..." --cortex <name>  or  think -C <name> retro add "..."'));
      process.exitCode = 1;
      return;
    }

    const kind = parseKindOpt(opts.kind);
    if (kind === false) return;
    emitRetro(cortex, message, kind);
  });

// Read subcommand: think retro recall [<query>] --cortex <name>
const recallSubcommand = new Command('recall')
  .description('Recall stored retros for a cortex (--cortex required)')
  .argument('[query]', 'Search query (FTS5); omit to list all promoted retros')
  .option('--cortex <name>', 'Target cortex to read retros from (required)')
  .option('--all', 'Return all non-tombstoned retros (default: promoted=1 only)')
  .option('--include-relegated', 'Alias for --all')
  .option('--limit <n>', 'Max results to return', '20')
  .addHelpText('after', `
Scope:
  Searches the named cortex's retros table. --cortex is required.
  By default returns only promoted=1 retros (high-signal, seen >= 2 times).
  Pass --all (or --include-relegated) to also return relegated retros.
  Tombstoned rows (including dedupe-merged) are never returned.

Recall tracking:
  Surfacing a retro updates last_recalled_at and increments recalled_count —
  the signal the retro curator uses to keep active retros promoted.

Examples:
  think retro recall --cortex fx-tracker
  think retro recall "migrations" --cortex my-repo
  think -C fx-tracker retro recall "type contracts" --all
`)
  .action(function (this: Command, query: string | undefined, opts: {
    cortex?: string;
    all?: boolean;
    includeRelegated?: boolean;
    limit: string;
  }) {
    const globalOpts = this.optsWithGlobals() as { cortex?: string };
    const cortex = opts.cortex ?? globalOpts.cortex;

    if (!cortex) {
      console.error(chalk.red('think retro recall: --cortex is required.'));
      console.error(chalk.red('Pass it as: think retro recall --cortex <name>  or  think -C <name> retro recall'));
      process.exitCode = 1;
      return;
    }

    if (!existsSync(getEngramDbPath(cortex))) {
      console.error(chalk.red(`think retro recall: no cortex named "${cortex}" exists. Cortexes are created on first retro emission.`));
      process.exitCode = 1;
      return;
    }

    const limit = parseInt(opts.limit, 10);
    const all = opts.all || opts.includeRelegated;
    const retros = searchRetros(cortex, { query: query?.trim(), all, limit });

    if (retros.length === 0) {
      console.log(chalk.dim(`no retros found for ${cortex}`));
      closeCortexDb(cortex);
      return;
    }

    console.log(chalk.cyan(`Retros for [${cortex}]:`));
    console.log();
    for (const r of retros) {
      const ts = chalk.gray(r.created_at.slice(0, 10));
      const kindLabel = r.kind ? chalk.dim(` [${r.kind}]`) : '';
      const occLabel = r.occurrences > 1 ? chalk.dim(` (×${r.occurrences})`) : '';
      console.log(`  ${ts}${kindLabel}${occLabel} ${r.content}`);
    }
    console.log();

    bumpRecallStats(cortex, retros.map(r => r.id));
    closeCortexDb(cortex);
  });

export const retroCommand = new Command('retro')
  .description('Emit or recall permanent codebase observations')
  .argument('[message]', 'Observation to record (legacy form — use "think retro add" for explicit emit)')
  .option('--kind <kind>', `Observation kind: ${VALID_KINDS.join(' | ')}`)
  .addHelpText('after', `
Storage contract:
  Retros have no TTL and are never purged by the curator. Every emission
  is preserved permanently. The curator may relegate a retro (hide it
  from default recall) but the row stays in storage. Tombstoning is
  explicit user action only.

  --cortex is required for emit (pass it directly or via the global -C flag).
  No fallback to active cortex — retros scope to a specific codebase
  or tool, not the user's current working context.

  A new cortex is auto-created on first emission; no 'think cortex
  create' step is needed.

Subcommands:
  think retro add "<message>"      Explicit emit form
  think retro recall [<query>]     Read stored retros (--cortex required)
  think retro recall --help        Recall flag reference

  Caution: a one-word retro whose text is literally "add" or "recall" will
  dispatch to the subcommand instead of the legacy emit form. Use
  "think retro add ..." for those messages.

Examples:
  think -C fx-tracker retro "strategy engine type contracts are not documented"
  think retro "always run migrations in a transaction" --cortex my-repo --kind convention
  think retro add "AGT-169: mirrored memories table pattern" --cortex think-cli --kind prior_decision
  think retro recall --cortex fx-tracker
  think retro recall "migrations" --cortex my-repo
`)
  .addCommand(addSubcommand)
  .addCommand(recallSubcommand)
  .action(function (this: Command, message: string | undefined, opts: { kind?: string }) {
    // Legacy emit form: fires when first positional doesn't match "add" or "recall".
    if (!message) {
      this.outputHelp();
      return;
    }

    const globalOpts = this.optsWithGlobals() as { cortex?: string };
    const cortex = globalOpts.cortex;

    if (!cortex) {
      console.error(chalk.red('think retro: --cortex is required (no fallback to active cortex — retros are scoped to a specific codebase or tool).'));
      console.error(chalk.red('Pass it as: think retro "..." --cortex <name>  or  think -C <name> retro "..."'));
      process.exitCode = 1;
      return;
    }

    const kind = parseKindOpt(opts.kind);
    if (kind === false) return;
    emitRetro(cortex, message, kind);
  });
