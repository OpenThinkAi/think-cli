import { Command } from 'commander';
import fs from 'node:fs';
import chalk from 'chalk';
import { getDb } from '../db/client.js';
import { closeDb } from '../db/client.js';
import type { Entry } from '../db/queries.js';
import { logAudit } from '../lib/audit.js';
import { validateEngramContent } from '../lib/sanitize.js';

const MAX_IMPORT_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_IMPORT_ENTRIES = 50_000;

export const importCommand = new Command('import')
  .description('Import a sync bundle from another device')
  .argument('<file>', 'Path to the sync bundle JSON file')
  .action((file: string) => {
    if (!fs.existsSync(file)) {
      console.error(chalk.red(`File not found: ${file}`));
      closeDb();
      process.exit(1);
    }

    const stat = fs.statSync(file);
    if (stat.size > MAX_IMPORT_FILE_SIZE) {
      console.error(chalk.red(`File too large (${Math.round(stat.size / 1024 / 1024)}MB). Maximum import size is ${MAX_IMPORT_FILE_SIZE / 1024 / 1024}MB.`));
      closeDb();
      process.exit(1);
    }

    let bundle: {
      format?: string;
      version?: number;
      peerId?: string;
      exportedAt?: string;
      entryCount?: number;
      entries?: Entry[];
    };

    try {
      const raw = fs.readFileSync(file, 'utf-8');
      bundle = JSON.parse(raw);
    } catch {
      console.error(chalk.red('Failed to parse sync bundle — is this a valid JSON file?'));
      closeDb();
      process.exit(1);
    }

    if (bundle.format !== 'think-sync-bundle' || !Array.isArray(bundle.entries)) {
      console.error(chalk.red('Not a valid think sync bundle.'));
      closeDb();
      process.exit(1);
    }

    if (bundle.entries.length === 0) {
      console.log(chalk.dim('Bundle is empty — nothing to import.'));
      closeDb();
      return;
    }

    if (bundle.entries.length > MAX_IMPORT_ENTRIES) {
      console.error(chalk.red(`Bundle contains ${bundle.entries.length} entries. Maximum is ${MAX_IMPORT_ENTRIES}.`));
      closeDb();
      process.exit(1);
    }

    const db = getDb();

    const insert = db.prepare(
      `INSERT OR IGNORE INTO entries (id, timestamp, source, category, content, tags, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    let imported = 0;
    let skipped = 0;
    let warnings = 0;

    try {
      db.exec('BEGIN');
      for (const entry of bundle.entries) {
        if (typeof entry.id !== 'string' || typeof entry.content !== 'string') {
          skipped++;
          continue;
        }

        const validated = validateEngramContent(entry.content);
        if (validated.warnings.length > 0) warnings++;

        const result = insert.run(
          entry.id,
          typeof entry.timestamp === 'string' ? entry.timestamp : new Date().toISOString(),
          typeof entry.source === 'string' ? entry.source : 'import',
          typeof entry.category === 'string' ? entry.category : '',
          validated.content,
          typeof entry.tags === 'string' ? entry.tags : '',
          (entry as Entry & { deleted_at?: string }).deleted_at ?? null,
        );
        if (result.changes > 0) {
          imported++;
        } else {
          skipped++;
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Import failed: ${message}`));
      closeDb();
      process.exit(1);
    }

    logAudit({
      timestamp: new Date().toISOString(),
      type: 'import',
      peer: bundle.peerId ?? 'unknown',
      file,
      entryIds: bundle.entries.map((e) => e.id),
      count: bundle.entries.length,
    });

    if (imported > 0) {
      console.log(chalk.green('✓') + ` Imported ${imported} entries` + (skipped > 0 ? ` (${skipped} skipped)` : ''));
    } else {
      console.log(chalk.green('✓') + ` All ${skipped} entries already present — nothing new.`);
    }

    if (warnings > 0) {
      console.log(chalk.yellow('⚠') + ` ${warnings} entries contained suspicious content patterns`);
    }

    if (bundle.peerId) {
      console.log(chalk.dim(`  from peer: ${bundle.peerId.slice(0, 8)}`));
    }
    if (bundle.exportedAt) {
      console.log(chalk.dim(`  exported:  ${bundle.exportedAt.slice(0, 16).replace('T', ' ')}`));
    }

    closeDb();
  });
