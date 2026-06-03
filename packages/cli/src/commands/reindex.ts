/**
 * `think reindex [cortex]` — rebuild L2 from L1.
 *
 * Walks the L1 JSONL pages for one or all cortexes, embeds each entry's
 * content, and writes (INSERT OR REPLACE) every row into L2 with the
 * embedding, embedding_model, and all base fields. After the embedding
 * pass, recomputeActivitySeq is called to stamp stable integer positions.
 *
 * AC (AGT-276):
 *  1. Reindexes named cortex or all configured cortexes serially.
 *  2. Per cortex: parse all L1 JSONL pages, embed content, INSERT OR REPLACE.
 *  3. Progress: "Reindexing personal: 1234 entries... done in 4.2s (293 entries/s)".
 *  4. Entry-level errors (malformed JSON / embed failure) are logged; final
 *     summary shows failure count.
 *  5. Deterministic — running twice on same L1 + model produces identical L2.
 *  6. --force: drop all rows and rebuild from scratch. Warns when rows were
 *     deleted but no L1 entries were found (empty-L1 footgun guard).
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig } from '../lib/config.js';
import {
  listBranchFiles,
  readFileFromBranch,
  readCortexFile,
  ensureRepoCloned,
  fetchBranch,
} from '../lib/git.js';
import { parseMemoriesJsonl } from '../lib/curator.js';
import { resolveMemoryId } from '../lib/deterministic-id.js';
import { getCortexDb, closeCortexDb } from '../db/engrams.js';
import { recomputeActivitySeq } from '../db/activity-seq.js';
import embed, { EMBEDDING_MODEL_NAME } from '../lib/embed.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Read all L1 JSONL pages for a cortex from the git backend.
 * Returns an array of raw JSONL content strings (one per bucket file).
 * On any read failure the page is skipped and the error is pushed into
 * the `errors` array — the caller continues with the pages it did receive.
 */
export function readAllL1Pages(
  cortexName: string,
  errors: string[],
): string[] {
  // `listBranchFiles` returns basenames of the canonical `<cortex>/` subdir;
  // the numbered-page filter is unchanged.
  const files = listBranchFiles(cortexName, '.jsonl')
    .filter(f => /^\d{6}\.jsonl$/.test(f))
    .sort();

  if (files.length === 0) {
    // Pre-v2 legacy fallback: a single top-level `memories.jsonl`. Use the
    // top-level read here on purpose — this file never lived in the cortex
    // subdir.
    const raw = readFileFromBranch(cortexName, 'memories.jsonl');
    return raw ? [raw] : [];
  }

  const pages: string[] = [];
  for (const file of files) {
    const raw = readCortexFile(cortexName, file);
    if (raw === null) {
      errors.push(`Could not read ${file} from branch ${cortexName} — skipping page`);
      continue;
    }
    pages.push(raw);
  }
  return pages;
}

// ─── core reindex logic ───────────────────────────────────────────────────────

export interface ReindexOneResult {
  total: number;
  failures: number;
  durationMs: number;
  /** Only set when --force was used and the DELETE removed rows but L1 was empty. */
  forcedEmptyWipe?: number;
}

/**
 * Reindex a single cortex from L1 → L2.
 *
 * Exported for direct unit testing; the CLI command calls this and formats
 * the result. Callers must close the cortex DB themselves after use.
 */
export async function reindexOneCortex(
  cortexName: string,
  force: boolean,
): Promise<ReindexOneResult> {
  const start = performance.now();
  let total = 0;
  let failures = 0;
  let forcedEmptyWipe: number | undefined;
  const errors: string[] = [];

  // Ensure git repo is available and branch is current
  try {
    ensureRepoCloned();
    fetchBranch(cortexName);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`think reindex: could not fetch branch "${cortexName}": ${msg}`);
  }

  // --force: count then drop all rows.
  // The count is captured *before* the DELETE so we can warn when force
  // wiped rows but L1 was empty (user would otherwise see a silent green
  // checkmark for a now-empty L2).
  let deletedCount = 0;
  if (force) {
    const db = getCortexDb(cortexName);
    const row = db.prepare('SELECT COUNT(*) as n FROM memories').get() as { n: number };
    deletedCount = row.n;
    db.exec('DELETE FROM memories');
  }

  // Collect all L1 pages
  const pages = readAllL1Pages(cortexName, errors);
  if (errors.length > 0) {
    for (const e of errors) process.stderr.write(`${chalk.yellow('⚠')} ${e}\n`);
  }

  // Prepare the upsert statement once per cortex (not per entry).
  // getCortexDb is cached so the db handle is stable for the entire pass.
  const db = getCortexDb(cortexName);
  const now = new Date().toISOString();
  const upsertStmt = db.prepare(`
    INSERT OR REPLACE INTO memories
      (id, ts, author, content, source_ids, created_at,
       deleted_at, sync_version, embedding, embedding_model,
       kind, topics_json)
    VALUES (
      ?, ?, ?, ?, ?,
      COALESCE((SELECT created_at FROM memories WHERE id = ?), ?),
      ?,
      COALESCE((SELECT sync_version FROM memories WHERE id = ?), 1),
      ?, ?, ?, ?
    )
  `);

  // Parse all entries across pages
  for (const page of pages) {
    const entries = parseMemoriesJsonl(page);

    for (const entry of entries) {
      // L2 key: explicit id when present, deterministic fallback for legacy
      // lines (see resolveMemoryId). Keeps reindex idempotent against the
      // daemon pull-loop rather than duplicating rows under a second key.
      const id = resolveMemoryId(entry);
      total++;

      // Embed — errors are non-fatal; log and continue
      let embeddingVec: Float32Array;
      try {
        embeddingVec = await embed(entry.content);
      } catch (err) {
        const snippet = entry.content.slice(0, 60).replace(/\n/g, ' ');
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `${chalk.red('✗')} reindex [${cortexName}] id=${id}: embed failed — ${msg}\n` +
          `  content: "${snippet}${entry.content.length > 60 ? '…' : ''}"\n`,
        );
        failures++;
        continue;
      }

      // Convert Float32Array → Uint8Array for SQLite BLOB storage
      const embeddingBytes = new Uint8Array(embeddingVec.buffer);

      try {
        upsertStmt.run(
          id, entry.ts, entry.author, entry.content, JSON.stringify(entry.source_ids),
          /* created_at subquery param */ id, now,
          entry.deleted_at ?? null,
          /* sync_version subquery param */ id,
          embeddingBytes, EMBEDDING_MODEL_NAME,
          entry.kind,
          JSON.stringify(entry.topics ?? []),
        );
      } catch (err) {
        const snippet = entry.content.slice(0, 60).replace(/\n/g, ' ');
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `${chalk.red('✗')} reindex [${cortexName}] id=${id}: db write failed — ${msg}\n` +
          `  content: "${snippet}${entry.content.length > 60 ? '…' : ''}"\n`,
        );
        failures++;
      }
    }
  }

  // Detect --force with empty L1: we deleted rows but found nothing to rebuild.
  if (force && deletedCount > 0 && total === 0) {
    forcedEmptyWipe = deletedCount;
  }

  // After embedding pass: stamp activity_seq for all live rows
  recomputeActivitySeq(cortexName);

  const durationMs = performance.now() - start;
  return { total, failures, durationMs, forcedEmptyWipe };
}

// ─── command ──────────────────────────────────────────────────────────────────

export const reindexCommand = new Command('reindex')
  .description('Rebuild the search index (L2) for one or all cortexes from the raw log (L1 JSONL)')
  .argument('[cortex]', 'Cortex name to reindex (omit for all configured cortexes)')
  .option('--force', 'Drop all L2 rows first and rebuild from scratch (non-atomic; L1 is the source of truth)', false)
  .action(async (cortexArg: string | undefined, opts: { force: boolean }) => {
    const config = getConfig();
    const globalOpts = (reindexCommand.parent?.opts() ?? {}) as { cortex?: string };

    // Resolve which cortexes to process
    const targetCortex = cortexArg ?? globalOpts.cortex;

    let cortexNames: string[];
    if (targetCortex) {
      cortexNames = [targetCortex];
    } else {
      // All configured cortexes: currently only a single active cortex is
      // supported in the config. When multi-cortex lands this list widens.
      const active = config.cortex?.active;
      if (!active) {
        console.error(chalk.red('think reindex: no cortex specified and no active cortex configured.'));
        console.error(chalk.red('  Run: think cortex switch <name>  or  think reindex <name>'));
        process.exit(1);
      }
      cortexNames = [active];
    }

    let totalEntries = 0;
    let totalFailures = 0;

    for (const cortex of cortexNames) {
      process.stdout.write(`Reindexing ${chalk.cyan(cortex)}: `);

      let result: ReindexOneResult;
      try {
        result = await reindexOneCortex(cortex, opts.force);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`\n${chalk.red('✗')} ${msg}`);
        process.exit(1);
      } finally {
        closeCortexDb(cortex);
      }

      const { total, failures, durationMs, forcedEmptyWipe } = result;
      const successCount = total - failures;
      const secs = (durationMs / 1000).toFixed(1);
      const rate = durationMs > 0 ? Math.round((successCount / durationMs) * 1000) : 0;

      if (failures === 0) {
        console.log(
          `${chalk.green('✓')} ${total} entries — done in ${secs}s (${rate} entries/s)`,
        );
      } else {
        console.log(
          `${chalk.yellow('⚠')} ${total} entries, ${chalk.red(String(failures))} failed — done in ${secs}s (${rate} entries/s)`,
        );
      }

      // Warn when --force wiped rows but L1 was empty (data-loss footgun)
      if (forcedEmptyWipe !== undefined) {
        process.stderr.write(
          `${chalk.yellow('⚠')} --force deleted ${forcedEmptyWipe} row${forcedEmptyWipe === 1 ? '' : 's'} but no L1 entries were found — L2 is now empty.\n` +
          `  To recover, run: think reindex ${cortex}\n`,
        );
      }

      totalEntries += total;
      totalFailures += failures;
    }

    if (cortexNames.length > 1) {
      console.log(chalk.dim(`─────────────────────────────────────────`));
      console.log(
        `Total: ${totalEntries} entries, ${totalFailures} failures across ${cortexNames.length} cortexes`,
      );
    }

    if (totalFailures > 0) {
      process.exit(1);
    }
  });
