/**
 * Compaction queue + worker loop — AGT-299
 *
 * In-memory FIFO queue that drains compaction jobs asynchronously after the
 * sync endpoint writes a new `kind=memory` entry to L1+L2. One or more worker
 * coroutines drain the queue, calling the compaction pipeline (AGT-298) with
 * exponential backoff on failure.
 *
 * Queue state is NOT persisted across daemon restarts. On daemon startup,
 * `scanAndEnqueueUncompacted` scans L1 for raw `kind=memory` entries that have
 * no corresponding row in `compaction_links` and re-enqueues them (cap: 100
 * per cortex).
 *
 * Downstream slots (AGT-300 triage gate, AGT-301 apply) are not yet wired in.
 * The pipeline is currently a DRY_RUN stub (no real LLM calls, no writes) so
 * the queue plumbing is exercisable without burning API tokens or altering L1/L2.
 * AGT-301 will set DRY_RUN=false once the apply step ships.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getCortexDb } from '../../db/engrams.js';
import { getRepoPath, sanitizeName } from '../../lib/paths.js';
import { getConfig } from '../../lib/config.js';
import { searchVectors } from '../../lib/search-vectors.js';
import type { NewEntry } from './call.js';

/**
 * When true (default until AGT-301 ships), the worker reads entry content from
 * L2 and logs what would be compacted, but does NOT call the LLM. Set to false
 * by AGT-301 once the apply write step is implemented.
 */
const DRY_RUN = true;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Initial backoff delay in milliseconds. Doubles on each retry. */
const BACKOFF_BASE_MS = 1000;
/** Maximum number of retry attempts per job (4 retries → delays: 1s, 4s, 16s, 64s). */
const MAX_RETRIES = 4;
/** Maximum number of entries re-enqueued per cortex on daemon startup. */
const BACKFILL_CAP = 100;
/** Top-K candidates to retrieve for the triage gate similarity check. */
const TRIAGE_TOP_K = 10;
/** Default cosine similarity threshold below which LLM call is skipped. */
const TRIAGE_THRESHOLD_DEFAULT = 0.6;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** @internal Exported for test-only use via `_setPipelineForTest`. */
export interface CompactionJob {
  entry_id: string;
  cortex: string;
}

// ---------------------------------------------------------------------------
// CompactionQueue
// ---------------------------------------------------------------------------

export class CompactionQueue {
  /** FIFO queue of pending compaction jobs. */
  private readonly queue: CompactionJob[] = [];

  /**
   * Per-cortex depth counter tracking queued + in-flight jobs. Decremented
   * in the worker `finally` block after each job finishes (whether success,
   * permanent failure, or skip). O(1) reads for the status endpoint.
   *
   * Semantic: depth=0 means no jobs are queued OR currently being processed
   * for that cortex. It does NOT mean all compaction writes have been applied
   * (that is AGT-301's responsibility).
   */
  private readonly depthByCortex = new Map<string, number>();

  /** Whether the worker loop(s) have been started. */
  private started = false;

  /**
   * Stored resolve callback for the event-driven worker wakeup signal.
   * `enqueue()` resolves it to wake the sleeping worker instead of busy-polling.
   * One slot is sufficient for a single-worker queue; see `start()` note on
   * multi-worker wakeup if parallelism is added in the future.
   */
  private wakeWorker?: () => void;

  /**
   * Number of compaction jobs that were skipped by the triage gate because
   * max cosine similarity was below the threshold. Resets on process restart.
   * Exposed via `getStats()` for the daemon log and status endpoint.
   */
  private _compactionsSkippedTriage = 0;

  /**
   * Number of compaction jobs that passed the triage gate (i.e., similarity
   * was above threshold). In DRY_RUN mode (until AGT-301 ships) no actual LLM
   * call is made, but the gate was passed — hence "passed_triage" rather than
   * "ran". Resets on process restart.
   */
  private _compactionsPassedTriage = 0;

  /**
   * Optional pipeline override for testing. When set, `runCompactionPipeline`
   * delegates to this function instead of the real implementation. Allows tests
   * to exercise the retry-with-backoff control flow without subclassing or
   * touching production modules.
   *
   * @internal Not part of the public API. Set via `_setPipelineForTest` only.
   */
  private _pipelineOverride?: (job: CompactionJob) => Promise<void>;

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Push a new compaction job onto the FIFO queue and wake any sleeping worker.
   * Safe to call multiple times for the same entry_id — deduplication is NOT
   * performed here; callers are responsible for avoiding double-enqueue.
   */
  enqueue(entry_id: string, cortex: string): void {
    this.queue.push({ entry_id, cortex });
    this.depthByCortex.set(cortex, (this.depthByCortex.get(cortex) ?? 0) + 1);

    // Wake the idle worker (if any) immediately rather than waiting for the next
    // poll cycle. With a single stored resolve, multiple rapid enqueues coalesce
    // into one wakeup — the worker drains the entire queue in one pass.
    if (this.wakeWorker !== undefined) {
      this.wakeWorker();
      this.wakeWorker = undefined;
    }
  }

  /**
   * Spawn a single worker coroutine that serially drains the queue.
   *
   * Parallelism (workerCount > 1) is intentionally not exposed: the current
   * wakeup mechanism uses a single stored `resolve` callback that would
   * silently stall additional workers. A multi-worker design (broadcast set
   * or EventEmitter) can be added when the use case demands it. AGT-301
   * should not add a `workerCount` parameter without first fixing wakeup.
   *
   * Calling `start()` more than once is a no-op — idempotent.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.runWorker();
  }

  /**
   * Returns the current number of pending jobs for the given cortex.
   * Used by the status endpoint (AGT-287) to surface queue depth per cortex.
   */
  getDepth(cortex: string): number {
    return this.depthByCortex.get(cortex) ?? 0;
  }

  /**
   * Returns process-lifetime metrics counters for the compaction triage gate.
   * Values reset on daemon restart.
   *
   * - `compactions_skipped_triage`: jobs where max cosine < threshold → LLM skipped.
   * - `compactions_passed_triage`: jobs where max cosine ≥ threshold → gate passed.
   *   In DRY_RUN mode (until AGT-301 ships), no actual LLM call is made even when
   *   the gate passes; the counter reflects "passed the gate", not "called the LLM".
   */
  getStats(): { compactions_skipped_triage: number; compactions_passed_triage: number } {
    return {
      compactions_skipped_triage: this._compactionsSkippedTriage,
      compactions_passed_triage: this._compactionsPassedTriage,
    };
  }

  /**
   * @internal Test-only. Inject a custom pipeline function that replaces the
   * real `runCompactionPipeline` implementation. Used to exercise the
   * `processJobWithRetry` backoff loop without touching production modules.
   *
   * Call with `undefined` to restore the real implementation.
   */
  _setPipelineForTest(fn: ((job: CompactionJob) => Promise<void>) | undefined): void {
    this._pipelineOverride = fn;
  }

  // ---------------------------------------------------------------------------
  // Worker loop
  // ---------------------------------------------------------------------------

  /**
   * Single worker coroutine. Loops until the process exits:
   *   1. Pull the next job from the queue.
   *   2. If empty: wait for an event-driven wakeup from `enqueue()`.
   *   3. Process the job with retry-with-backoff.
   *   4. Decrement the per-cortex depth counter (queued + in-flight).
   */
  private async runWorker(): Promise<void> {
    while (true) {
      const job = this.queue.shift();

      if (job === undefined) {
        // Queue is empty — wait for enqueue() to signal a new job.
        // This is event-driven: no busy-poll, no CPU overhead during idle periods.
        await new Promise<void>(resolve => {
          this.wakeWorker = resolve;
        });
        continue;
      }

      try {
        await this.processJobWithRetry(job);
      } finally {
        // Decrement depth after job completes (success or permanent failure).
        const prev = this.depthByCortex.get(job.cortex) ?? 0;
        if (prev <= 1) {
          this.depthByCortex.delete(job.cortex);
        } else {
          this.depthByCortex.set(job.cortex, prev - 1);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Job processing with exponential backoff
  // ---------------------------------------------------------------------------

  /**
   * Attempt to run the compaction pipeline for one job. On network/transient
   * errors, retries up to MAX_RETRIES times with exponential backoff
   * (1s → 4s → 16s → 64s). On permanent failure (exhausted retries or
   * response_invalid), logs and drops the job.
   *
   * NOTE: AGT-300 (triage gate) and AGT-301 (apply writes) are NOT yet wired
   * in. While DRY_RUN=true (the default), no real LLM call is made — the
   * pipeline logs what would be compacted and returns immediately.
   */
  private async processJobWithRetry(job: CompactionJob): Promise<void> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.runCompactionPipeline(job);
        return; // success — stop retrying
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);

        if (attempt === MAX_RETRIES) {
          log(`compaction failed permanently after ${MAX_RETRIES} retries (entry=${job.entry_id}, cortex=${job.cortex}): ${msg}`);
          return;
        }

        // Exponential backoff: attempt 0→1s, 1→4s, 2→16s, 3→64s
        const delayMs = BACKOFF_BASE_MS * Math.pow(4, attempt);
        log(`compaction attempt ${attempt + 1} failed (entry=${job.entry_id}, cortex=${job.cortex}): ${msg} — retrying in ${delayMs}ms`);
        await sleep(delayMs);
      }
    }
  }

  /**
   * Run the compaction pipeline for one job.
   *
   * AGT-300 triage gate:
   *   1. Read entry content + embedding from L2.
   *   2. If the embedding is present, vector-search L2 for the top-K most
   *      similar entries in the same cortex (excluding the entry itself).
   *   3. If max(candidate.cosine) < triageThreshold, skip the LLM call and
   *      return { status: "no_compaction_needed" } — the raw entry IS the
   *      current entry (no compacted entry is written).
   *   4. If above threshold (or no embedding yet), fall through to the LLM
   *      path (DRY_RUN while AGT-301 is pending).
   *
   * AGT-301 will clear DRY_RUN and add the L1+L2 write for the compacted entry.
   *
   * Throws on any error so the retry loop can back off.
   *
   * Delegates to `_pipelineOverride` when set (test-only injection).
   */
  private async runCompactionPipeline(job: CompactionJob): Promise<void> {
    if (this._pipelineOverride !== undefined) {
      return this._pipelineOverride(job);
    }

    // Read the entry content + embedding from L2 (inserted by the sync handler).
    const entryWithEmbedding = readEntryWithEmbeddingFromL2(job.entry_id, job.cortex);
    if (entryWithEmbedding === null) {
      // Entry not found in L2 — skip (may have been deleted or L2 insert
      // failed; backfill on next startup handles the reconciliation case).
      log(`compaction skipped: entry ${job.entry_id} not found in L2 (cortex=${job.cortex})`);
      return;
    }

    const { newEntry, embedding } = entryWithEmbedding;

    // ── Triage gate (AGT-300) ─────────────────────────────────────────────────
    //
    // If the embedding is available, check whether any existing entry in the
    // same cortex is similar enough to warrant compaction. If not, the new
    // entry is net-new on its topic and the LLM call is unnecessary.
    if (embedding !== null) {
      const threshold = getConfig().compaction?.triageThreshold ?? TRIAGE_THRESHOLD_DEFAULT;
      const candidates = searchVectors(job.cortex, embedding, TRIAGE_TOP_K + 1);

      // Exclude the entry itself from the candidate list (it may appear in the
      // results if its embedding was indexed before the triage check ran).
      const others = candidates.filter(c => c.id !== job.entry_id);

      const maxSimilarity = others.length > 0
        ? Math.max(...others.map(c => c.similarity))
        : -1;

      if (maxSimilarity < threshold) {
        this._compactionsSkippedTriage++;
        log(
          `compaction triage: skipped LLM (entry=${job.entry_id}, cortex=${job.cortex}, ` +
          `max_cosine=${maxSimilarity.toFixed(4)}, threshold=${threshold}) — no_compaction_needed`,
        );
        return;
      }
    }
    // ── End triage gate ───────────────────────────────────────────────────────

    this._compactionsPassedTriage++;

    if (DRY_RUN) {
      // Dry-run: log intent without calling the LLM or writing any output.
      // AGT-301 will replace this branch with the real apply path.
      log(
        `[dry-run] would compact entry=${job.entry_id} cortex=${job.cortex} ` +
        `content="${newEntry.content.slice(0, 60)}${newEntry.content.length > 60 ? '…' : ''}"`,
      );
      return;
    }

    // --- live path (wired by AGT-301) ---
    // The import of runCompaction is intentionally inside this branch so the
    // SDK is not loaded (and consent is not checked) until AGT-301 activates
    // the live path by setting DRY_RUN=false.
    const { runCompaction } = await import('./call.js');
    const result = await runCompaction(newEntry, []);

    if (result.status === 'response_invalid') {
      log(`compaction response_invalid after retry (entry=${job.entry_id}, cortex=${job.cortex}) — skipping`);
      return;
    }

    // AGT-301 will write the compacted entry to L1+L2 here.
    log(
      `compaction ok (entry=${job.entry_id}, cortex=${job.cortex}): ` +
      `supersedes=[${result.supersedes.join(', ')}] topics=[${result.topics.join(', ')}] ` +
      `text="${result.compacted_text.slice(0, 80)}${result.compacted_text.length > 80 ? '…' : ''}"`,
    );
  }
}

// ---------------------------------------------------------------------------
// Startup backfill
// ---------------------------------------------------------------------------

/**
 * On daemon startup, scan each cortex for raw `kind=memory` L1 entries that
 * have no corresponding row in `compaction_links` (i.e., have not been
 * compacted yet), and enqueue them. Capped at BACKFILL_CAP (100) per cortex
 * — full backfill is `think reindex`.
 *
 * Reads L1 JSONL files directly (same directory layout as sync-handler.ts).
 * Skips entries whose `compacted_from` is non-null (they are compactions, not
 * raw entries). Skips entries already present in `compaction_links.raw_id`.
 *
 * @param queue     The CompactionQueue to enqueue jobs into.
 * @param cortexes  List of cortex names to scan (from config.cortex.active or
 *                  an explicit list for multi-cortex support).
 */
export function scanAndEnqueueUncompacted(
  queue: CompactionQueue,
  cortexes: string[],
): void {
  const repoPath = getRepoPath();

  for (const cortex of cortexes) {
    let safeCortex: string;
    try {
      safeCortex = sanitizeName(cortex);
    } catch {
      // Invalid cortex name — skip silently
      continue;
    }

    const cortexDir = path.join(repoPath, safeCortex);
    if (!fs.existsSync(cortexDir)) continue;

    // Per-id existence checker for compaction_links — O(1) per candidate.
    const isAlreadyCompacted = makeCompactionExistsChecker(safeCortex);

    // Read all L1 JSONL pages for this cortex (sorted ascending = oldest first).
    let pages: string[] = [];
    try {
      pages = fs.readdirSync(cortexDir)
        .filter(f => /^\d{6}\.jsonl$/.test(f))
        .sort();
    } catch {
      continue;
    }

    // Collect candidate entry_ids (kind=memory, compacted_from=null, not in compaction_links).
    // We scan newest-first so the backfill cap favours the most recent entries.
    const candidates: string[] = [];

    outer:
    for (let p = pages.length - 1; p >= 0; p--) {
      const pagePath = path.join(cortexDir, pages[p]);
      let raw: string;
      try {
        raw = fs.readFileSync(pagePath, 'utf-8');
      } catch {
        continue;
      }

      // Read lines in reverse order within each page (newest entries last → reverse).
      const lines = raw.split('\n').filter(l => l.length > 0).reverse();

      for (const line of lines) {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }

        const id = typeof parsed.id === 'string' ? parsed.id : null;
        if (id === null) continue;

        const kind = typeof parsed.kind === 'string' ? parsed.kind : 'memory';
        if (kind !== 'memory') continue;

        // Skip compaction entries (compacted_from is non-null array with ≥1 element).
        if (Array.isArray(parsed.compacted_from) && parsed.compacted_from.length > 0) continue;

        // Skip if already compacted (O(1) per-id existence check).
        if (isAlreadyCompacted !== null && isAlreadyCompacted(id)) continue;

        // Skip tombstoned entries.
        if (parsed.deleted_at !== null && parsed.deleted_at !== undefined) continue;

        candidates.push(id);
        if (candidates.length >= BACKFILL_CAP) break outer;
      }
    }

    // Enqueue in chronological order (reverse the newest-first list).
    for (let i = candidates.length - 1; i >= 0; i--) {
      queue.enqueue(candidates[i], safeCortex);
    }

    if (candidates.length > 0) {
      const capMsg = candidates.length === BACKFILL_CAP
        ? ` (cap reached — run 'think reindex' for full backfill)`
        : '';
      log(`backfill: enqueued ${candidates.length} uncompacted entries for cortex '${safeCortex}'${capMsg}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a prepared-statement checker for the `compaction_links` table.
 * Used by `scanAndEnqueueUncompacted` to test per-id existence without loading
 * the entire table (avoids O(N) bulk load for large cortexes).
 *
 * Returns `null` when the DB is unavailable — callers should treat this as
 * "no compactions exist" and enqueue all candidates.
 */
function makeCompactionExistsChecker(cortexName: string): ((id: string) => boolean) | null {
  try {
    const db = getCortexDb(cortexName);
    const stmt = db.prepare('SELECT 1 FROM compaction_links WHERE raw_id = ? LIMIT 1');
    return (id: string): boolean => stmt.get(id) !== undefined;
  } catch {
    return null;
  }
}

/**
 * Read an entry's content, timestamp, and embedding from the L2 memories
 * table. Returns null when the entry is not found.
 *
 * The embedding column was added in AGT-278 and is nullable — rows without
 * an embedding return `embedding: null`, which causes the triage gate to
 * skip the similarity check and proceed directly to the LLM path.
 */
function readEntryWithEmbeddingFromL2(
  entryId: string,
  cortexName: string,
): { newEntry: NewEntry; embedding: Float32Array | null } | null {
  try {
    const db = getCortexDb(cortexName);
    const row = db.prepare(
      'SELECT ts, content, embedding FROM memories WHERE id = ? AND deleted_at IS NULL',
    ).get(entryId) as { ts: string; content: string; embedding: Uint8Array | null } | undefined;

    if (row === undefined) return null;

    let embedding: Float32Array | null = null;
    if (row.embedding !== null && row.embedding.byteLength > 0) {
      embedding = new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4,
      );
    }

    return { newEntry: { ts: row.ts, content: row.content }, embedding };
  } catch {
    return null;
  }
}

/** Millisecond sleep — used by the worker poll loop and backoff delays. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Write a timestamped line to stderr (daemon log). */
function log(msg: string): void {
  process.stderr.write(`[${new Date().toISOString()}] [compaction-queue] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

/**
 * Process-global compaction queue instance. Imported by the sync handler
 * (to enqueue after L1+L2 write) and the status handler (to read queue depth).
 *
 * The singleton is created at module load time. The daemon calls
 * `compactionQueue.start()` during startup (after socket bind).
 */
export const compactionQueue = new CompactionQueue();
