import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig } from '../lib/config.js';
import { getMemories, insertMemory } from '../db/memory-queries.js';
import { closeCortexDb } from '../db/engrams.js';
import { getSyncAdapter } from '../sync/registry.js';
import { validateEngramContent } from '../lib/sanitize.js';

const addCommand = new Command('add')
  .description('Add a memory directly, bypassing curation')
  .argument('<message>', 'The memory content')
  .option('--no-push', 'Skip pushing to remote after adding')
  .option('--silent', 'Suppress output')
  .action(async function (this: Command, message: string, opts: { push: boolean; silent?: boolean }) {
    const globalOpts = this.optsWithGlobals() as { cortex?: string };
    const config = getConfig();
    const cortex = globalOpts.cortex ?? config.cortex?.active;

    if (!cortex) {
      console.error(chalk.red('No active cortex. Run: think cortex switch <name>'));
      process.exit(1);
    }

    const author = config.cortex?.author ?? 'unknown';

    // Validate and sanitize content
    const validated = validateEngramContent(message);
    message = validated.content;
    if (!opts.silent && validated.warnings.length > 0) {
      for (const w of validated.warnings) {
        console.log(chalk.yellow(`  ⚠ ${w}`));
      }
    }

    const row = insertMemory(cortex, {
      ts: new Date().toISOString(),
      author,
      content: message,
      source_ids: [],
    });

    if (!opts.silent) {
      const badge = chalk.cyan(`[${cortex}]`);
      const ts = chalk.gray(row.ts.slice(0, 16).replace('T', ' '));
      console.log(`${chalk.green('✓')} ${badge} memory added ${ts}`);
      console.log(`  ${row.content}`);
    }

    // Auto-push unless --no-push
    if (opts.push) {
      const adapter = getSyncAdapter();
      if (adapter?.isAvailable()) {
        try {
          const result = await adapter.push(cortex);
          if (!opts.silent && result.pushed > 0) {
            console.log(chalk.dim(`  Pushed ${result.pushed} memories to ${adapter.name}`));
          }
        } catch {
          if (!opts.silent) {
            console.log(chalk.dim('  Push skipped (remote unavailable) — will push on next sync'));
          }
        }
      }
    }

    closeCortexDb(cortex);
  });

async function showMemories(opts: { history?: boolean }): Promise<void> {
  const config = getConfig();
  const cortex = config.cortex?.active;

  if (!cortex) {
    console.error(chalk.red('No active cortex. Run: think cortex switch <name>'));
    process.exit(1);
  }

  const memories = getMemories(cortex, { limit: opts.history ? 50 : undefined });

  if (memories.length === 0) {
    console.log(chalk.dim('No memories yet. Run: think curate'));
    closeCortexDb(cortex);
    return;
  }

  if (opts.history) {
    for (const m of memories.reverse()) {
      const ts = m.ts.slice(0, 16).replace('T', ' ');
      const preview = m.content.length > 80 ? m.content.slice(0, 80) + '...' : m.content;
      console.log(`${chalk.gray(ts)}  ${chalk.dim(m.author + ':')} ${preview}`);
    }
  } else {
    for (const m of memories) {
      const ts = m.ts.slice(0, 16).replace('T', ' ');
      console.log(`${chalk.gray(ts)}  ${chalk.dim(m.author + ':')} ${m.content}`);
    }
  }

  console.log(chalk.dim(`\n${memories.length} memories`));
  closeCortexDb(cortex);
}

export const memoryCommand = new Command('memory')
  .description('Show current memories from local store')
  .option('--history', 'Show recent memory timeline')
  .action(async (opts: { history?: boolean }) => {
    await showMemories(opts);
  });

memoryCommand.addCommand(addCommand);
