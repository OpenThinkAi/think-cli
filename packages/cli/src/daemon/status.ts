/**
 * Daemon `status` endpoint — AGT-287, AGT-302
 *
 * Returns structured health, uptime, and per-cortex state for the running daemon.
 *
 * Params: { cortex?: string }
 *   - If `cortex` is omitted: returns global fields + all known cortexes.
 *   - If `cortex` is specified: returns global fields + only that cortex.
 *
 * Response shape:
 *   {
 *     version:         string,
 *     pid:             number,
 *     uptime_seconds:  number,
 *     embedding_model: string,
 *     search_engine:   "brute-force" | "sqlite-vec",
 *     cortexes: {
 *       [name: string]: {
 *         entries:                        number,
 *         last_sync_pull:                 string | null,
 *         last_sync_push:                 string | null,
 *         compaction_queue_depth:         number,
 *         compaction_permanently_skipped: number,
 *         supersession_queue_depth:       number,
 *         warnings:                       string[],
 *       }
 *     }
 *   }
 *
 * `compaction_queue_depth` reflects the live in-memory compaction worker
 * (AGT-301). `compaction_permanently_skipped` counts L2 rows where the worker
 * exhausted retries or hit a content fault (AGT-302). `supersession_queue_depth`
 * is a forward-compatible placeholder for a future supersession worker — it
 * currently always returns 0.
 */

import { readPackageVersion } from '../lib/version.js';
import { getConfig } from '../lib/config.js';
import { EMBEDDING_MODEL_NAME } from '../lib/embed.js';
import { getMemoryCount, getSyncCursor } from '../db/memory-queries.js';
import { sanitizeName } from '../lib/paths.js';
import { sanitizeForLog } from '../lib/sanitize.js';
import { compactionQueue, getPermanentlySkippedCount } from './compaction/queue.js';

// ---------------------------------------------------------------------------
// Constants / defaults
// ---------------------------------------------------------------------------

/** Timestamp at which this module was first imported — used as daemon start time. */
const DAEMON_START_TIME = Date.now();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CortexStatusEntry {
  entries: number;
  last_sync_pull: string | null;
  last_sync_push: string | null;
  /**
   * Number of compaction jobs queued or in-flight for this cortex.
   * depth=0 means the queue is idle; depth>0 means jobs are pending or
   * being processed.
   */
  compaction_queue_depth: number;
  /**
   * Number of entries whose compaction has permanently failed (AGT-302).
   * These entries stay raw and are excluded from daemon-startup backfill on
   * restart. There is currently no automatic recovery path — operator action
   * is required to revisit them.
   */
  compaction_permanently_skipped: number;
  /**
   * Placeholder for a future supersession-worker queue depth. Currently
   * always 0; reserved so consumers can rely on the field's presence.
   */
  supersession_queue_depth: number;
  warnings: string[];
}

export interface DaemonStatusResult {
  version: string;
  pid: number;
  uptime_seconds: number;
  embedding_model: string;
  search_engine: 'brute-force' | 'sqlite-vec';
  cortexes: Record<string, CortexStatusEntry>;
}

// ---------------------------------------------------------------------------
// Per-cortex helper
// ---------------------------------------------------------------------------

function getCortexStatus(cortexName: string): CortexStatusEntry {
  const warnings: string[] = [];

  let entries = 0;
  try {
    entries = getMemoryCount(cortexName);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`could not read entry count: ${msg}`);
  }

  let last_sync_pull: string | null = null;
  let last_sync_push: string | null = null;
  try {
    last_sync_pull = getSyncCursor(cortexName, 'git', 'pull_file');
    last_sync_push = getSyncCursor(cortexName, 'git', 'push');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`could not read sync cursors: ${msg}`);
  }

  const compaction_permanently_skipped = getPermanentlySkippedCount(cortexName);
  if (compaction_permanently_skipped > 0) {
    const safeCortex = sanitizeForLog(cortexName);
    const noun = compaction_permanently_skipped === 1 ? 'entry' : 'entries';
    warnings.push(
      `${compaction_permanently_skipped} ${noun} permanently skipped for compaction in cortex ${safeCortex}` +
      ` — no automatic recovery path is currently available`,
    );
  }

  return {
    entries,
    last_sync_pull,
    last_sync_push,
    compaction_queue_depth: compactionQueue.getDepth(cortexName),
    compaction_permanently_skipped,
    // Supersession queue depth placeholder — wired to real worker in AGT-305.
    supersession_queue_depth: 0,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Implements the `status` daemon method.
 *
 * @param params  Incoming params from the protocol dispatcher.
 * @returns       {@link DaemonStatusResult}
 */
export function handleStatus(
  params: Record<string, unknown>,
): DaemonStatusResult {
  // ── optional cortex param ──────────────────────────────────────────────────

  const cortexParam = params['cortex'];
  if (cortexParam !== undefined && typeof cortexParam !== 'string') {
    throw new Error('status: "cortex" param must be a string when provided');
  }
  const requestedCortex =
    typeof cortexParam === 'string' && cortexParam.trim().length > 0
      ? cortexParam.trim()
      : undefined;

  // ── validate requested cortex name (length + path-traversal guard) ────────
  // Length cap is checked before sanitizeName to prevent arbitrarily large
  // strings from reaching the DB layer (sanitizeName only checks char set).
  // sanitizeName allows alphanumeric + hyphens + underscores; the error
  // message mirrors that constraint verbatim to stay in sync.

  if (requestedCortex !== undefined) {
    if (requestedCortex.length > 255) {
      throw new Error('status: "cortex" name too long (max 255 characters)');
    }
    try {
      sanitizeName(requestedCortex);
    } catch {
      throw new Error(
        `status: invalid cortex name "${requestedCortex}" — use only alphanumeric characters, hyphens, and underscores`,
      );
    }
  }

  // ── global fields ──────────────────────────────────────────────────────────

  let version: string;
  try {
    version = readPackageVersion();
  } catch {
    version = 'unknown';
  }

  const pid = process.pid;
  const uptime_seconds = Math.floor((Date.now() - DAEMON_START_TIME) / 1000);

  const config = getConfig();
  const search_engine: 'brute-force' | 'sqlite-vec' =
    config.search?.engine ?? 'brute-force';

  // ── cortex list ────────────────────────────────────────────────────────────

  let cortexNames: string[];
  if (requestedCortex !== undefined) {
    cortexNames = [requestedCortex];
  } else {
    // All known cortexes: currently a single active cortex per config.
    // This list widens when multi-cortex lands (same pattern as reindex).
    const active = config.cortex?.active;
    cortexNames = active ? [active] : [];
  }

  // ── assemble result ────────────────────────────────────────────────────────

  const cortexes: Record<string, CortexStatusEntry> = {};
  for (const name of cortexNames) {
    cortexes[name] = getCortexStatus(name);
  }

  return {
    version,
    pid,
    uptime_seconds,
    embedding_model: EMBEDDING_MODEL_NAME,
    search_engine,
    cortexes,
  };
}
