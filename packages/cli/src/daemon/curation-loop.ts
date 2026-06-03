/**
 * Curation loop — AGT-462 (iterative-learning-v2 §5 M6)
 *
 * Daemon-scheduled retro curation. `think curate-retros` is otherwise
 * manual-only, so the retro corpus never self-maintains: dedupe (merge),
 * promote, and relegate only run when a human invokes the command. This loop
 * runs those same passes on a configurable cadence for each local repo cortex
 * so the corpus self-maintains.
 *
 * Scope:
 *   - Curation is retro-scoped. The loop curates every LOCAL git branch /
 *     cortex EXCEPT the personal work-log cortex (`config.cortex.active`),
 *     which holds memories, not retros. This mirrors the manual command, which
 *     refuses to default to the active cortex.
 *   - Each cortex is curated under the same `acquireCurateLock` the manual
 *     command uses, so a hand-run `curate-retros` and the scheduled pass never
 *     clobber each other — whichever holds the lock wins; the other skips.
 *
 * Cadence / disable:
 *   - `config.cortex.curationIntervalHours` sets the interval. Default
 *     {@link DEFAULT_CURATION_INTERVAL_HOURS} (6h). A value of `0` (or ≤ 0)
 *     disables the loop entirely — `start()` becomes a no-op.
 *
 * Test seam (mirrors PullLoop / CompactionQueue):
 *   - `_intervalMsOverride` injects a short interval so tests don't sleep for
 *     real, and `_curateOverride` replaces the real curation call so tests can
 *     assert the scheduled path triggers curation without an LLM or DB.
 *   - The loop does NOT fire a cycle on `start()` (unlike the pull loop):
 *     curation is heavy (LLM dedupe) and the daemon has just booted, so the
 *     first pass waits one interval. Tests inject a short interval to exercise
 *     the scheduled fire.
 */

import { getConfig } from '../lib/config.js';
import { listLocalBranches } from '../lib/git.js';
import { sanitizeForLog } from '../lib/sanitize.js';
import { acquireCurateLock } from '../lib/curate-lock.js';
import { closeCortexDb } from '../db/engrams.js';
import { closeUsageDb } from '../db/usage-db.js';
import { LlmConsentError } from '../lib/llm-consent.js';
import { resolveRetroValueWeights } from '../lib/retro-value-signal.js';
import {
  runCurationPasses,
  DEFAULT_RELEGATE_AFTER_RUNS,
  type CurationLogger,
} from '../commands/curate-retros.js';
import { daemonLog } from './log.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default scheduled-curation cadence in hours when config is unset. */
export const DEFAULT_CURATION_INTERVAL_HOURS = 6;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CurationLoopHandle {
  /** Stop the loop. No-op after the first call. */
  stop(): void;
}

/**
 * Signature of the function the loop calls to curate one cortex. Matches
 * `runCurationPasses` minus the logger (the loop supplies its own daemon-log
 * logger). Exposed as a type so tests can inject a stub via `_curateOverride`.
 */
export type CurateOneFn = (cortex: string) => Promise<void>;

// ---------------------------------------------------------------------------
// CurationLoop
// ---------------------------------------------------------------------------

export class CurationLoop {
  private stopped = false;
  private currentTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Optional interval override for tests (ms). When set, it takes precedence
   * over the configured `curationIntervalHours` entirely — `resolveIntervalMs()`
   * short-circuits on this value before reading config, so the config-0 disable
   * semantic is NOT consulted while the override is in effect. A test that wants
   * to exercise the disable path must leave this unset and configure
   * `curationIntervalHours = 0`.
   * @internal Test-only. Production callers must not set this.
   */
  // eslint-disable-next-line @typescript-eslint/naming-convention
  private _intervalMsOverride?: number;

  /**
   * Optional curation runner override for tests. When set, used in place of
   * the real `curateOneCortex` so tests don't touch the LLM / DB.
   * @internal Test-only. Production callers must not set this.
   */
  // eslint-disable-next-line @typescript-eslint/naming-convention
  private _curateOverride?: CurateOneFn;

  constructor() {
    // No per-instance config snapshot needed — the cycle reads config fresh.
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Start the scheduled loop. Returns a handle with `stop()`. If the configured
   * cadence is `0`/disabled, logs once and returns a no-op handle (the loop
   * never schedules a cycle).
   *
   * Unlike the pull loop, the first cycle is NOT fired immediately — it waits
   * one interval so a fresh daemon boot doesn't trigger an LLM-heavy pass on
   * startup.
   */
  start(): CurationLoopHandle {
    const intervalMs = this.resolveIntervalMs();
    if (intervalMs <= 0) {
      this.log('scheduled curation disabled (cortex.curationIntervalHours = 0)');
      return { stop: () => {} };
    }

    this.scheduleNext(intervalMs);
    this.log(`scheduled curation enabled (interval=${formatInterval(intervalMs)})`);
    return { stop: () => this.stop() };
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private resolveIntervalMs(): number {
    if (this._intervalMsOverride !== undefined) return this._intervalMsOverride;
    const hours = getConfig().cortex?.curationIntervalHours ?? DEFAULT_CURATION_INTERVAL_HOURS;
    if (!Number.isFinite(hours) || hours <= 0) return 0;
    return hours * 60 * 60 * 1000;
  }

  private scheduleNext(intervalMs: number): void {
    if (this.stopped) return;
    this.currentTimer = setTimeout(() => {
      this.currentTimer = null;
      void this.cycle().finally(() => {
        if (!this.stopped) this.scheduleNext(intervalMs);
      });
    }, intervalMs);
  }

  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.currentTimer !== null) {
      clearTimeout(this.currentTimer);
      this.currentTimer = null;
    }
    this.log('curation loop stopped');
  }

  /**
   * Run one curation pass across every local cortex, INCLUDING the home/active
   * cortex. Pre-v3 the active cortex was excluded as a pure work-log with no
   * retros; under iterative-learning v3 retros live on the home cortex (tagged
   * repo:<context>), so it must be curated too. Curation is retro-scoped — it
   * only touches `kind=retro` rows + the `retros` curator table — so curating
   * the home cortex never disturbs its memory/event entries.
   *
   * (Known follow-up: the merge pass is not yet context-aware, so it could in
   * principle merge two near-identical retros from different repo:<context>
   * tags. In practice distinct contexts carry textually distinct lessons and
   * the near-dup threshold is high (0.95); scoping merges per context is a
   * future refinement.)
   *
   * Each cortex is curated independently; a failure on one is logged and does
   * not abort the others, and any throw is swallowed so an error can never
   * crash the daemon or stop the loop.
   */
  private async cycle(): Promise<void> {
    if (this.stopped) return;

    let branches: string[];
    try {
      branches = listLocalBranches();
    } catch (err: unknown) {
      this.log(`WARN: could not enumerate cortexes: ${msg(err)} — retrying next cycle`);
      return;
    }

    const cortexes = branches;
    if (cortexes.length === 0) return;

    const curate = this._curateOverride ?? curateOneCortex;

    for (const cortex of cortexes) {
      if (this.stopped) break;
      try {
        await curate(cortex);
      } catch (err: unknown) {
        // Per-cortex failure: log and move on. The next cadence retries.
        this.log(`WARN: curation failed for cortex '${sanitizeForLog(cortex)}': ${msg(err)}`);
      }
    }
  }

  private log(message: string): void {
    daemonLog('curation-loop', message);
  }
}

// ---------------------------------------------------------------------------
// Real per-cortex curation
// ---------------------------------------------------------------------------

/** Routes the curation progress lines to daemon.log. */
const daemonCurationLogger: CurationLogger = {
  info: (m) => daemonLog('curation-loop', m.trim()),
  merged: (m) => daemonLog('curation-loop', `merged:${m}`),
  promoted: (m) => daemonLog('curation-loop', `promoted:${m}`),
  relegated: (m) => daemonLog('curation-loop', `relegated:${m}`),
  detail: (m) => daemonLog('curation-loop', m.trim()),
};

/**
 * Curate one cortex with the same merge → promote → relegate passes the manual
 * command runs, under the shared curate lock. Skips (does not throw) if the
 * lock is already held by a concurrent run. LLM-consent failures are logged and
 * swallowed — without consent the dedupe pass can't run, but that is a
 * user-config condition, not a daemon error.
 */
async function curateOneCortex(cortex: string): Promise<void> {
  const config = getConfig();
  const relegateAfterRuns = config.cortex?.retroRelegateAfterRuns ?? DEFAULT_RELEGATE_AFTER_RUNS;
  const valueWeights = resolveRetroValueWeights(config.cortex?.retroValueSignal);

  const lock = acquireCurateLock(`retros-${cortex}`);
  if (!lock.acquired) {
    daemonLog('curation-loop', `skipped cortex '${sanitizeForLog(cortex)}': curation already running (pid ${lock.heldByPid ?? '?'})`);
    return;
  }

  try {
    const result = await runCurationPasses(
      cortex,
      /* dryRun */ false,
      relegateAfterRuns,
      valueWeights,
      daemonCurationLogger,
    );
    if (result.merged > 0 || result.promoted > 0 || result.relegated > 0) {
      daemonLog(
        'curation-loop',
        `cortex '${sanitizeForLog(cortex)}': ${result.merged} merged, ${result.promoted} promoted, ${result.relegated} relegated`,
      );
    }
  } catch (err: unknown) {
    if (err instanceof LlmConsentError) {
      daemonLog('curation-loop', `cortex '${sanitizeForLog(cortex)}': dedupe skipped — LLM consent not granted`);
      return;
    }
    throw err;
  } finally {
    lock.release();
    closeCortexDb(cortex);
    closeUsageDb();
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function msg(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/[\r\n]/g, ' ');
}

/**
 * Render a scheduling interval in the human-readable unit the user configures
 * (`curationIntervalHours`), keeping the raw ms alongside for debugging — e.g.
 * `6h (21600000ms)`. Falls back to minutes / seconds for sub-hour values (the
 * test interval override can be arbitrarily small).
 */
function formatInterval(intervalMs: number): string {
  let human: string;
  if (intervalMs % 3_600_000 === 0) human = `${intervalMs / 3_600_000}h`;
  else if (intervalMs % 60_000 === 0) human = `${intervalMs / 60_000}m`;
  else if (intervalMs % 1_000 === 0) human = `${intervalMs / 1_000}s`;
  else human = `${intervalMs}ms`;
  return human === `${intervalMs}ms` ? human : `${human} (${intervalMs}ms)`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Construct and start the scheduled curation loop. Wire into daemon startup
 * alongside the pull loop and compaction queue. Returns a handle whose `stop()`
 * is called in the daemon's graceful-shutdown sequence.
 */
export function startCurationLoop(): CurationLoopHandle {
  return new CurationLoop().start();
}
