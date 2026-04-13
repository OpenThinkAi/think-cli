import { Command } from 'commander';
import fs from 'node:fs';
import chalk from 'chalk';
import { getEntries, type Entry } from '../db/queries.js';
import { getConfig } from '../lib/config.js';
import { closeDb } from '../db/client.js';

export const exportCommand = new Command('export')
  .description('Export entries as a sync bundle (file-based sync)')
  .option('-o, --output <file>', 'Write to file instead of stdout')
  .option('--since <date>', 'Export entries since date (ISO or YYYY-MM-DD)')
  .option('-n, --limit <n>', 'Max entries to export (default: all)')
  .action((opts: { output?: string; since?: string; limit?: string }) => {
    const config = getConfig();
    const entries = getEntries({
      since: opts.since ? new Date(opts.since) : undefined,
      limit: opts.limit ? parseInt(opts.limit, 10) : 10000,
    });

    if (entries.length === 0) {
      console.error(chalk.dim('No entries to export.'));
      closeDb();
      return;
    }

    // Sort oldest-first for natural timeline order
    entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const bundle = {
      format: 'think-sync-bundle',
      version: 2,
      peerId: config.peerId,
      exportedAt: new Date().toISOString(),
      entryCount: entries.length,
      entries,
    };

    const json = JSON.stringify(bundle, null, 2);

    if (opts.output) {
      fs.writeFileSync(opts.output, json, 'utf-8');
      console.log(chalk.green('✓') + ` Exported ${entries.length} entries to ${opts.output}`);
      if (opts.since) {
        console.log(chalk.dim(`  since: ${opts.since}`));
      }
    } else {
      process.stdout.write(json + '\n');
    }

    closeDb();
  });
