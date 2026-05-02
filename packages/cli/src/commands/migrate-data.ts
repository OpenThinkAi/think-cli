import { Command } from 'commander';
import fs from 'node:fs';
import chalk from 'chalk';
import { getConfig } from '../lib/config.js';
import { ensureRepoCloned, fetchBranch, readFileFromBranch } from '../lib/git.js';
import { parseMemoriesJsonl } from '../lib/curator.js';
import { insertMemoryIfNotExists, setLongtermSummary, getMemoryCount } from '../db/memory-queries.js';
import { closeCortexDb } from '../db/engrams.js';
import { getLongtermPath } from '../lib/paths.js';
import { deterministicId } from '../lib/deterministic-id.js';

export const migrateDataCommand = new Command('migrate-data')
  .description('Import existing memories from git into local SQLite (one-time migration)')
  .action(async () => {
    const config = getConfig();
    const cortex = config.cortex?.active;

    if (!cortex) {
      console.error(chalk.red('No active cortex. Run: think cortex switch <name>'));
      process.exit(1);
    }

    if (!config.cortex?.repo) {
      console.error(chalk.red('No cortex repo configured. Run: think cortex setup'));
      process.exit(1);
    }

    const beforeCount = getMemoryCount(cortex);

    // 1. Read memories from git
    console.log(chalk.cyan('Fetching memories from git...'));
    ensureRepoCloned();
    fetchBranch(cortex);

    const memoriesRaw = readFileFromBranch(cortex, 'memories.jsonl') ?? '';
    const memories = parseMemoriesJsonl(memoriesRaw);

    if (memories.length === 0) {
      console.log(chalk.dim('No memories found on git branch.'));
      closeCortexDb(cortex);
      return;
    }

    // 2. Insert memories with deterministic IDs
    console.log(chalk.cyan(`Importing ${memories.length} memories...`));
    let inserted = 0;

    for (const m of memories) {
      const id = deterministicId(m.ts, m.author, m.content);
      // origin_peer_id falls through to the local-peer default. This is a
      // legacy file→sqlite import on the same machine — the local peer is
      // the original author of these rows in every realistic case.
      const wasInserted = insertMemoryIfNotExists(cortex, {
        id,
        ts: m.ts,
        author: m.author,
        content: m.content,
        source_ids: m.source_ids,
      });
      if (wasInserted) inserted++;
    }

    // 3. Migrate longterm summary
    const ltPath = getLongtermPath(cortex);
    if (fs.existsSync(ltPath)) {
      const ltContent = fs.readFileSync(ltPath, 'utf-8').trim();
      if (ltContent) {
        setLongtermSummary(cortex, ltContent);
        console.log(chalk.green('  ✓') + ' Long-term summary migrated');
      }
    }

    const afterCount = getMemoryCount(cortex);
    console.log();
    console.log(chalk.green('✓') + ` Migration complete`);
    console.log(`  ${memories.length} memories on git, ${inserted} newly imported, ${afterCount} total in SQLite`);
    if (beforeCount > 0) {
      console.log(chalk.dim(`  (${beforeCount} already existed from prior migration)`));
    }

    closeCortexDb(cortex);
  });
