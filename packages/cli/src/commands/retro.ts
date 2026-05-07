import { existsSync } from 'node:fs';
import { Command } from 'commander';
import chalk from 'chalk';
import { getCortexDb, closeCortexDb } from '../db/engrams.js';
import { insertRetro, VALID_KINDS, type RetroKind } from '../db/retro-queries.js';
import { validateEngramContent } from '../lib/sanitize.js';
import { getEngramDbPath } from '../lib/paths.js';

export const retroCommand = new Command('retro')
  .description('Emit a retro — a structured codebase or tool observation stored permanently in a named cortex')
  .argument('<message>', 'The observation to record')
  .option('--kind <kind>', `Observation kind: ${VALID_KINDS.join(' | ')}`)
  .addHelpText('after', `
Storage contract:
  Retros have no TTL and are never purged by the curator. Every emission
  is preserved permanently. The curator may relegate a retro (hide it
  from default recall) but the row stays in storage. Tombstoning is
  explicit user action only.

  --cortex is required (pass it directly or via the global -C flag).
  No fallback to active cortex — retros scope to a specific codebase
  or tool, not the user's current working context.

  A new cortex is auto-created on first emission; no 'think cortex
  create' step is needed.

  This release: write-only producer surface. Reader commands are added
  in a follow-up release. Retros are local-only for now; cross-machine
  sync is not yet wired.

Examples:
  think -C fx-tracker retro "strategy engine type contracts are not documented"
  think retro "always run migrations in a transaction" --cortex my-repo --kind convention
  think retro "AGT-169: mirrored memories table pattern" --cortex think-cli --kind prior_decision
`)
  .action(function (this: Command, message: string, opts: { kind?: string }) {
    const globalOpts = this.optsWithGlobals() as { cortex?: string };
    const cortex = globalOpts.cortex;

    if (!cortex) {
      console.error(chalk.red('think retro: --cortex is required (no fallback to active cortex — retros are scoped to a specific codebase or tool).'));
      console.error(chalk.red('Pass it as: think retro "..." --cortex <name>  or  think -C <name> retro "..."'));
      process.exitCode = 1;
      return;
    }

    let kind: RetroKind | null = null;
    if (opts.kind !== undefined) {
      if (!(VALID_KINDS as readonly string[]).includes(opts.kind)) {
        console.error(chalk.red(`Invalid --kind value: "${opts.kind}"`));
        console.error(chalk.red(`Accepted values: ${VALID_KINDS.join(', ')}`));
        process.exitCode = 1;
        return;
      }
      kind = opts.kind as RetroKind;
    }

    const validated = validateEngramContent(message);
    if (validated.warnings.length > 0) {
      for (const w of validated.warnings) {
        console.log(chalk.yellow(`  ⚠ ${w}`));
      }
    }

    // Surface new-cortex creation so the user can catch typos immediately.
    const isNewCortex = !existsSync(getEngramDbPath(cortex));

    // getCortexDb mkdirs and runs migrations idempotently — auto-creates the
    // cortex DB on first retro emission, no explicit 'cortex create' needed.
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
  });
