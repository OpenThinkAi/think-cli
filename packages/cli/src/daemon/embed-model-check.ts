/**
 * Daemon startup embedding-model version check — AGT-277
 *
 * On daemon startup, for each known cortex, this module:
 *   1. Queries one row's `embedding_model` from L2 to detect the model version
 *      that produced the stored embeddings.
 *   2. If the stored model differs from the current EMBEDDING_MODEL_NAME, marks
 *      the cortex as "reindexing" and triggers a full reindex via reindexOneCortex.
 *   3. If no rows have embeddings yet (null — first-time v3 startup against v2
 *      data), also triggers an initial reindex.
 *   4. While a cortex is reindexing, the recall endpoint must return a transient
 *      busy error for that cortex. Other cortexes continue serving normally.
 *      Per-cortex isolation is the design; there is no global lock.
 *
 * Race-condition semantics:
 *   - `reindexingCortexes` is checked synchronously in the recall handler before
 *     any DB query. A recall that arrives during a reindex gets a deterministic
 *     "reindexing" error rather than stale or partially-updated results.
 *   - Reindex runs sequentially per cortex (the loop in `runEmbedModelChecks`
 *     awaits each cortex in turn). This is safe because each cortex owns an
 *     independent SQLite file — no cross-cortex lock contention.
 *
 * Log injection guard:
 *   - The `embedding_model` column is written by the local process, but we treat
 *     it as untrusted (it could be set to an unexpected value by a future code
 *     path or direct DB edit). Both the old and new model names are sanitized
 *     before appearing in log lines to prevent log-injection via embedded newlines.
 */

import { EMBEDDING_MODEL_NAME } from '../lib/embed.js';
import { getCortexDb, closeCortexDb } from '../db/engrams.js';
import { reindexOneCortex } from '../commands/reindex.js';

// ---------------------------------------------------------------------------
// Per-cortex busy state
// ---------------------------------------------------------------------------

/**
 * Set of cortex names currently undergoing a model-mismatch reindex.
 *
 * Read by the recall endpoint to return a transient busy response rather than
 * querying stale vectors. Cleared for each cortex once its reindex completes.
 * Other cortexes are never in this set unless they independently triggered a
 * reindex, so cross-cortex recall is not affected.
 */
export const reindexingCortexes: Set<string> = new Set();

// ---------------------------------------------------------------------------
// Log-injection sanitizer
// ---------------------------------------------------------------------------

/**
 * Strip newlines from a value before embedding it in a log line.
 * Prevents a crafted `embedding_model` value from injecting spurious log
 * lines or ANSI escape sequences into the daemon log.
 */
function sanitizeForLog(value: string): string {
  return value.replace(/[\r\n]/g, ' ');
}

// ---------------------------------------------------------------------------
// Per-cortex check
// ---------------------------------------------------------------------------

/**
 * Sample one row's `embedding_model` from the cortex L2. Returns:
 *   - `null`  — no rows have an embedding yet (v2 data / first-time v3 start)
 *   - `string` — the model name recorded in the first embedded row found
 *
 * The query is fast (LIMIT 1) even on large tables because we only filter
 * for non-null values; no index is needed for a single sample.
 */
function sampleEmbeddingModel(cortexName: string): string | null {
  const db = getCortexDb(cortexName);
  const row = db.prepare(
    'SELECT DISTINCT embedding_model FROM memories WHERE embedding_model IS NOT NULL LIMIT 1'
  ).get() as { embedding_model: string } | undefined;
  return row?.embedding_model ?? null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the embedding model version check for each cortex in `cortexNames`.
 *
 * Called once from the daemon startup sequence after the socket is bound and
 * the PID file is written. Does not block the daemon's ability to serve other
 * requests — each cortex's reindex runs in the background via a fire-and-forget
 * async chain, but only after the check is complete for that cortex.
 *
 * Progress is logged at INFO level to the `writeLine` callback (which the
 * caller routes to the daemon log or stderr) so operators can see the reindex
 * is in progress and not assume the daemon is hung.
 *
 * @param cortexNames  Cortex names to check (e.g., from `config.cortex.active`).
 * @param writeLine    Daemon's log-write function (timestamp prefix is added by the daemon).
 */
export async function runEmbedModelChecks(
  cortexNames: string[],
  writeLine: (msg: string) => void,
): Promise<void> {
  for (const cortexName of cortexNames) {
    let storedModel: string | null;
    try {
      storedModel = sampleEmbeddingModel(cortexName);
    } catch (err) {
      // DB not accessible (e.g., brand-new cortex with no L2 file yet) — skip.
      const msg = err instanceof Error ? err.message : String(err);
      writeLine(`embed-model-check: could not sample embedding_model for cortex "${cortexName}": ${msg} — skipping`);
      continue;
    }

    const needsReindex =
      storedModel === null || storedModel !== EMBEDDING_MODEL_NAME;

    if (!needsReindex) {
      writeLine(`embed-model-check: cortex "${cortexName}" is up to date (model=${sanitizeForLog(EMBEDDING_MODEL_NAME)})`);
      continue;
    }

    if (storedModel === null) {
      writeLine(
        `embed-model-check: cortex "${cortexName}" has no embeddings yet (first-time v3 startup against v2 data), reindexing…`
      );
    } else {
      writeLine(
        `embed-model-check: Embedding model changed (old=${sanitizeForLog(storedModel)} new=${sanitizeForLog(EMBEDDING_MODEL_NAME)}), reindexing cortex "${cortexName}"…`
      );
    }

    // Mark cortex as busy before starting the reindex. The recall handler
    // checks this synchronously and returns a transient error for this cortex
    // while the reindex is in progress.
    reindexingCortexes.add(cortexName);

    // Run the reindex for this cortex. We await each one serially to avoid
    // concurrent SQLite writes to the same DB. Per-cortex isolation means
    // other cortexes continue serving recall while this one reindexes.
    try {
      const result = await reindexOneCortex(cortexName, /* force= */ true);
      const secs = (result.durationMs / 1000).toFixed(1);
      const rate = result.durationMs > 0
        ? Math.round(((result.total - result.failures) / result.durationMs) * 1000)
        : 0;
      if (result.failures === 0) {
        writeLine(
          `embed-model-check: reindex complete for cortex "${cortexName}": ${result.total} entries in ${secs}s (${rate} entries/s)`
        );
      } else {
        writeLine(
          `embed-model-check: reindex complete for cortex "${cortexName}": ${result.total} entries, ${result.failures} failures in ${secs}s (${rate} entries/s)`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeLine(`embed-model-check: reindex failed for cortex "${cortexName}": ${msg}`);
    } finally {
      // Always clear the busy flag, even on failure, so the cortex is queryable
      // again (even if its embeddings are stale). Better to serve stale vectors
      // than to permanently block recall.
      reindexingCortexes.delete(cortexName);
      closeCortexDb(cortexName);
    }
  }
}
