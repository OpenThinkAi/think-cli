/**
 * Embedding prune loop — automatic disk/RAM reclamation for cortex L2s.
 *
 * A cortex L2's `embedding` BLOBs (384-dim float32 ≈ 1.5 KB each) dominate both
 * its on-disk size and its per-query RAM cost: the brute-force search backend
 * loads every embedding into memory on each recall (`lib/search-vectors.ts`).
 * Over time, tombstoned and superseded rows accumulate embeddings that recall
 * no longer uses — pure dead weight. Nothing reclaims them automatically, so a
 * long-lived work cortex grows without bound.
 *
 * This loop runs {@link pruneStaleEmbeddings} (Tier 0: tombstoned rows; Tier 1:
 * rows superseded past a grace window) on a configurable cadence for every
 * local cortex, then VACUUMs to return the freed pages to the OS. Embeddings are
 * a local, rebuildable index (recomputed by `think reindex`), so pruning loses
 * no content, keyword recall, or L1 source-of-truth — only the vector for a row
 * recall already ignores. The whole thing is automatic: it starts on daemon
 * boot, so a `think update` (which restarts the daemon) is all the user does.
 *
 * Why VACUUM lives here, not in the query: clearing a BLOB returns its pages to
 * SQLite's free-list but does not shrink the file. VACUUM rewrites the whole DB
 * to actually reclaim disk — comparatively expensive and event-loop-blocking
 * under node:sqlite — so it is gated: run only when this pass cleared rows, or
 * when the free-list has already grown past {@link VACUUM_FREELIST_THRESHOLD_MB}
 * from prior churn (compaction/reindex also leave free pages behind). That
 * second condition means the loop also reclaims pre-existing churn bloat, not
 * just stale embeddings.
 *
 * Cadence / disable:
 *   - `config.cortex.pruneIntervalHours` sets the interval. Default
 *     {@link DEFAULT_PRUNE_INTERVAL_HOURS} (24h). A value ≤ 0 disables the loop
 *     entirely — `start()` becomes a no-op.
 *   - Grace window via `config.cortex.pruneSupersededGraceDays` (default
 *     {@link DEFAULT_PRUNE_SUPERSEDED_GRACE_DAYS}).
 *
 * Unlike the curation loop, the first pass fires shortly after boot (after a
 * short settle delay so it doesn't contend with the startup embed-model-check /
 * reindex) rather than waiting a full interval — the point is for pruning to
 * "just happen" right after an update. The prune is cheap SQL; only the gated
 * VACUUM is heavy, and it runs at most once per cortex per pass.
 *
 * Test seam (mirrors CurationLoop): `_intervalMsOverride` injects a short
 * interval, `_firstDelayMsOverride` shrinks the settle delay, and `_pruneOverride`
 * replaces the real per-cortex work so tests assert scheduling without touching
 * SQLite.
 */

import type { DatabaseSync } from 'node:sqlite';
import { getConfig } from '../lib/config.js';
import { sanitizeForLog } from '../lib/sanitize.js';
import { getCortexDb, listKnownCortexes } from '../db/engrams.js';
import { pruneStaleEmbeddings } from '../db/memory-queries.js';
import { reindexingCortexes } from './embed-model-check.js';
import { daemonLog } from './log.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default scheduled-prune cadence in hours when config is unset. */
export const DEFAULT_PRUNE_INTERVAL_HOURS = 24;

/** Default grace window (days) before a superseded row's embedding is eligible. */
export const DEFAULT_PRUNE_SUPERSEDED_GRACE_DAYS = 14;

/**
 * Settle delay before the first prune pass after daemon boot. Lets the startup
 * embed-model-check / reindex finish so the prune doesn't contend with a full
 * reindex on the same DB.
 */
const DEFAULT_FIRST_DELAY_MS = 60_000;

/**
 * VACUUM even when nothing was pruned this pass if the free-list has grown past
 * this many MB from prior churn. Reclaims pre-existing bloat without rewriting
 * the file on every cadence tick.
 */
const VACUUM_FREELIST_THRESHOLD_MB = 16;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PruneLoopHandle {
  /** Stop the loop. No-op after the first call. */
  stop(): void;
}

/**
 * Signature of the function the loop calls to prune one cortex. Exposed as a
 * type so tests can inject a stub via `_pruneOverride`. `graceDays` is the
 * resolved superseded grace window the loop passes through.
 */
export type PruneOneFn = (cortex: string, graceDays: number) => void;

// ---------------------------------------------------------------------------
// PruneLoop
// ---------------------------------------------------------------------------

export class PruneLoop {
  private stopped = false;
  private currentTimer: ReturnType<typeof setTimeout> | null = null;

  /** @internal Test-only interval override (ms). Takes precedence over config. */
  // eslint-disable-next-line @typescript-eslint/naming-convention
  private _intervalMsOverride?: number;

  /** @internal Test-only first-fire delay override (ms). */
  // eslint-disable-next-line @typescript-eslint/naming-convention
  private _firstDelayMsOverride?: number;

  /** @internal Test-only per-cortex runner override. */
  // eslint-disable-next-line @typescript-eslint/naming-convention
  private _pruneOverride?: PruneOneFn;

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Start the scheduled loop. Returns a handle with `stop()`. If the configured
   * cadence is ≤ 0 (disabled), logs once and returns a no-op handle. The first
   * cycle fires after a short settle delay rather than a full interval.
   */
  start(): PruneLoopHandle {
    const intervalMs = this.resolveIntervalMs();
    if (intervalMs <= 0) {
      this.log('scheduled embedding prune disabled (cortex.pruneIntervalHours = 0)');
      return { stop: () => {} };
    }

    const firstDelay = this._firstDelayMsOverride ?? DEFAULT_FIRST_DELAY_MS;
    this.scheduleNext(Math.min(firstDelay, intervalMs), intervalMs);
    this.log(
      `scheduled embedding prune enabled (interval=${formatInterval(intervalMs)}, ` +
      `firstPassIn=${formatInterval(Math.min(firstDelay, intervalMs))})`,
    );
    return { stop: () => this.stop() };
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private resolveIntervalMs(): number {
    if (this._intervalMsOverride !== undefined) return this._intervalMsOverride;
    const hours = getConfig().cortex?.pruneIntervalHours ?? DEFAULT_PRUNE_INTERVAL_HOURS;
    if (!Number.isFinite(hours) || hours <= 0) return 0;
    return hours * 60 * 60 * 1000;
  }

  private resolveGraceDays(): number {
    const days = getConfig().cortex?.pruneSupersededGraceDays ?? DEFAULT_PRUNE_SUPERSEDED_GRACE_DAYS;
    return Number.isFinite(days) && days >= 0 ? days : DEFAULT_PRUNE_SUPERSEDED_GRACE_DAYS;
  }

  private scheduleNext(delayMs: number, intervalMs: number): void {
    if (this.stopped) return;
    this.currentTimer = setTimeout(() => {
      this.currentTimer = null;
      this.cycle();
      if (!this.stopped) this.scheduleNext(intervalMs, intervalMs);
    }, delayMs);
    // Don't keep the event loop alive solely for the prune timer.
    this.currentTimer.unref?.();
  }

  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.currentTimer !== null) {
      clearTimeout(this.currentTimer);
      this.currentTimer = null;
    }
    this.log('embedding prune loop stopped');
  }

  /**
   * Run one prune pass across every known cortex. Each cortex is pruned
   * independently; a failure on one is logged and never aborts the others or
   * crashes the daemon. Cortexes currently undergoing a model-mismatch reindex
   * are skipped — the reindex wipes and rebuilds embeddings, so pruning mid-flight
   * would race it.
   */
  private cycle(): void {
    if (this.stopped) return;

    let cortexes: string[];
    try {
      cortexes = listKnownCortexes();
    } catch (err: unknown) {
      this.log(`WARN: could not enumerate cortexes: ${msg(err)} — retrying next cycle`);
      return;
    }
    if (cortexes.length === 0) return;

    const prune = this._pruneOverride ?? pruneOneCortex;

    for (const cortex of cortexes) {
      if (this.stopped) break;
      if (reindexingCortexes.has(cortex)) {
        this.log(`skipped cortex '${sanitizeForLog(cortex)}': reindex in progress`);
        continue;
      }
      try {
        prune(cortex, this.resolveGraceDays());
      } catch (err: unknown) {
        this.log(`WARN: prune failed for cortex '${sanitizeForLog(cortex)}': ${msg(err)}`);
      }
    }
  }

  private log(message: string): void {
    daemonLog('embedding-prune-loop', message);
  }
}

// ---------------------------------------------------------------------------
// Real per-cortex prune
// ---------------------------------------------------------------------------

/**
 * Prune one cortex's stale embeddings, then VACUUM if it freed rows or the
 * free-list already exceeds the churn threshold. Logs a one-line summary only
 * when something actually happened, to keep the daemon log quiet on no-op passes.
 *
 * The `prune` override in the loop is typed `(cortex) => void`; the real
 * function additionally takes `graceDays`, which the loop supplies positionally.
 */
function pruneOneCortex(cortex: string, graceDays: number): void {
  const result = pruneStaleEmbeddings(cortex, graceDays);

  if (result.skippedToProtectLastEmbeddings) {
    daemonLog(
      'embedding-prune-loop',
      `cortex '${sanitizeForLog(cortex)}': skipped — pruning would clear the cortex's last embeddings`,
    );
    return;
  }

  const db = getCortexDb(cortex);
  const reclaimableMb = freelistMb(db);
  const shouldVacuum = result.prunedRows > 0 || reclaimableMb >= VACUUM_FREELIST_THRESHOLD_MB;

  let vacuumed = false;
  if (shouldVacuum) {
    try {
      db.exec('VACUUM');
      vacuumed = true;
    } catch (err: unknown) {
      // Pages were still returned to the free-list and will be reused by future
      // writes; only the on-disk shrink is deferred. Don't fail the pass.
      daemonLog(
        'embedding-prune-loop',
        `cortex '${sanitizeForLog(cortex)}': VACUUM failed (${msg(err)}) — pages freed internally, file not shrunk`,
      );
    }
  }

  if (result.prunedRows > 0 || vacuumed) {
    daemonLog(
      'embedding-prune-loop',
      `cortex '${sanitizeForLog(cortex)}': pruned ${result.prunedRows} embedding(s) ` +
      `(~${(result.bytesFreed / 1024 / 1024).toFixed(2)}MB)` +
      `${vacuumed ? `, vacuumed (~${reclaimableMb.toFixed(2)}MB reclaimable)` : ''}`,
    );
  }
}

/** Free-list size in MB: how much a VACUUM would return to the OS right now. */
function freelistMb(db: DatabaseSync): number {
  const free = (db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count;
  const pageSize = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
  return (free * pageSize) / 1024 / 1024;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function msg(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/[\r\n]/g, ' ');
}

function formatInterval(intervalMs: number): string {
  if (intervalMs % 3_600_000 === 0) return `${intervalMs / 3_600_000}h`;
  if (intervalMs % 60_000 === 0) return `${intervalMs / 60_000}m`;
  if (intervalMs % 1_000 === 0) return `${intervalMs / 1_000}s`;
  return `${intervalMs}ms`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Construct and start the scheduled embedding-prune loop. Wire into daemon
 * startup alongside the curation loop. Returns a handle whose `stop()` is called
 * in the daemon's graceful-shutdown sequence.
 */
export function startEmbeddingPruneLoop(): PruneLoopHandle {
  return new PruneLoop().start();
}
