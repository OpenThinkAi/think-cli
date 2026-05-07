import { Command } from 'commander';
import chalk from 'chalk';
import { getCortexDb, closeCortexDb } from '../db/engrams.js';
import { insertRetro, VALID_KINDS, type RetroKind } from '../db/retro-queries.js';
import { validateEngramContent } from '../lib/sanitize.js';

export const retroCommand = new Command('retro')
  .description('Emit a retro — a structured codebase or tool observation stored permanently in a named cortex')
  .argument('<message>', 'The observation to record')
  .requiredOption('--cortex <name>', 'Cortex to write the retro into (required; auto-created on first use)')
  .option('--kind <kind>', `Observation kind: ${VALID_KINDS.join(' | ')}`)
  .addHelpText('after', `
Storage contract:
  Retros have no TTL and are never purged by the curator.
  Every emission is preserved permanently. The curator may relegate
  a retro (hide it from default recall) but never deletes the row.
  Tombstoning is explicit user action only.

Examples:
  think retro "fx-tracker strategy engine type contracts are not documented" --cortex fx-tracker
  think retro "always run migrations in a transaction" --cortex my-repo --kind convention
  think retro "AGT-169 approach: mirror memories table pattern" --cortex think-cli --kind prior_decision
`)
  .action(function (this: Command, message: string, opts: { cortex: string; kind?: string }) {
    let kind: RetroKind | null = null;
    if (opts.kind !== undefined) {
      if (!(VALID_KINDS as readonly string[]).includes(opts.kind)) {
        console.error(chalk.red(`Invalid --kind value: "${opts.kind}"`));
        console.error(chalk.red(`Accepted values: ${VALID_KINDS.join(', ')}`));
        process.exit(1);
      }
      kind = opts.kind as RetroKind;
    }

    const validated = validateEngramContent(message);
    if (validated.warnings.length > 0) {
      for (const w of validated.warnings) {
        console.log(chalk.yellow(`  ⚠ ${w}`));
      }
    }

    // Auto-create the cortex DB on first retro emission — getCortexDb mkdirs
    // and runs migrations idempotently, so no explicit "cortex create" needed.
    getCortexDb(opts.cortex);

    const row = insertRetro(opts.cortex, { content: validated.content, kind });

    const badge = chalk.cyan(`[${opts.cortex}]`);
    const ts = chalk.gray(row.created_at.slice(0, 16).replace('T', ' '));
    const kindLabel = row.kind ? chalk.dim(` (${row.kind})`) : '';
    console.log(`${chalk.green('✓')} ${badge} retro added ${ts}${kindLabel}`);
    console.log(`  ${row.content}`);

    closeCortexDb(opts.cortex);
  });
