/**
 * Composite retro value signal (AGT-460 / design doc §5 M5).
 *
 * Raw surface-count is a weak value proxy: junk that happens to be
 * vector-similar to many queries surfaces a lot, while genuinely useful but
 * niche lessons surface rarely or never. This module folds the available
 * signals into a single composite score that promotion logic and the
 * `think retro-usage` ranking both consume:
 *
 *   - `occurrences` — independent re-reports of the same lesson. The strongest
 *     evidence a lesson recurs in reality, weighted highest.
 *   - `brief` / session-start surfacings — deliberate task-start loads
 *     (`source='brief'`, `session_seq=1`), weighted above mid-session noise.
 *   - mid-session surfacings (`session_seq>1`) — vector matches pulled in
 *     during a session; the weakest signal, weighted well below the above.
 *   - recency of the last *high-similarity* surfacing — a fresh strong match
 *     adds a bonus that decays exponentially with age.
 *
 * The formula is a weighted sum so it degrades gracefully: with no telemetry
 * at all, the composite reduces to `occurrenceWeight * occurrences`, which the
 * default `promoteThreshold` is tuned against so the legacy `occurrences >= 2`
 * promotion behaviour is preserved.
 *
 * Every weight/threshold is config-tunable via `cortex.retroValueSignal`; the
 * `DEFAULT_*` constants below are the sensible defaults.
 */

import type { RetroValueSignalConfig } from './config.js';

export const DEFAULT_RETRO_VALUE_OCCURRENCE_WEIGHT = 3.0;
export const DEFAULT_RETRO_VALUE_BRIEF_WEIGHT = 2.0;
export const DEFAULT_RETRO_VALUE_SESSION_START_WEIGHT = 2.0;
export const DEFAULT_RETRO_VALUE_MID_SESSION_WEIGHT = 0.25;
export const DEFAULT_RETRO_VALUE_RECENCY_WEIGHT = 1.0;
export const DEFAULT_RETRO_VALUE_RECENCY_DECAY_PER_DAY = 0.1;
export const DEFAULT_RETRO_VALUE_HIGH_SIMILARITY_THRESHOLD = 0.6;
/**
 * Tuned so two independent occurrences (2 × 3.0 = 6.0) promote with zero
 * telemetry, while a single occurrence (3.0) does not — preserving the legacy
 * `occurrences >= 2` gate. Deliberate brief/session-start surfacings can also
 * push a single-occurrence retro over (e.g. occurrences=1 + 1 brief = 5.0).
 */
export const DEFAULT_RETRO_VALUE_PROMOTE_THRESHOLD = 5.0;

/** Fully-resolved weights — every field defaulted from config or constants. */
export interface ResolvedRetroValueWeights {
  occurrenceWeight: number;
  briefWeight: number;
  sessionStartWeight: number;
  midSessionWeight: number;
  recencyWeight: number;
  recencyDecayPerDay: number;
  highSimilarityThreshold: number;
  promoteThreshold: number;
}

/** A finite, non-negative number from config, or the fallback. */
function num(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** Resolve config (possibly undefined) into a complete weight set. */
export function resolveRetroValueWeights(
  cfg: RetroValueSignalConfig | undefined,
): ResolvedRetroValueWeights {
  return {
    occurrenceWeight: num(cfg?.occurrenceWeight, DEFAULT_RETRO_VALUE_OCCURRENCE_WEIGHT),
    briefWeight: num(cfg?.briefWeight, DEFAULT_RETRO_VALUE_BRIEF_WEIGHT),
    sessionStartWeight: num(cfg?.sessionStartWeight, DEFAULT_RETRO_VALUE_SESSION_START_WEIGHT),
    midSessionWeight: num(cfg?.midSessionWeight, DEFAULT_RETRO_VALUE_MID_SESSION_WEIGHT),
    recencyWeight: num(cfg?.recencyWeight, DEFAULT_RETRO_VALUE_RECENCY_WEIGHT),
    recencyDecayPerDay: num(cfg?.recencyDecayPerDay, DEFAULT_RETRO_VALUE_RECENCY_DECAY_PER_DAY),
    highSimilarityThreshold: num(
      cfg?.highSimilarityThreshold,
      DEFAULT_RETRO_VALUE_HIGH_SIMILARITY_THRESHOLD,
    ),
    promoteThreshold: num(cfg?.promoteThreshold, DEFAULT_RETRO_VALUE_PROMOTE_THRESHOLD),
  };
}

/** The telemetry + occurrence inputs the composite is computed from. */
export interface RetroValueInputs {
  /** Independent re-reports (`retros.occurrences`). Defaults to 0 if unknown. */
  occurrences: number;
  /** `source='brief'` surfacing count. */
  briefCount: number;
  /** Session-start surfacing count (`session_seq=1`). */
  sessionStartCount: number;
  /** Mid-session surfacing count (`session_seq>1`). */
  midSessionCount: number;
  /**
   * ISO timestamp of the most recent *high-similarity* surfacing (score ≥
   * threshold), or null if none. Drives the recency bonus.
   */
  lastHighSimilarityAt: string | null;
}

/**
 * Compute the composite value signal. Deterministic given `now` (the recency
 * bonus is the only time-dependent term — pass it explicitly so callers and
 * tests stay reproducible).
 */
export function computeRetroValueSignal(
  inputs: RetroValueInputs,
  weights: ResolvedRetroValueWeights,
  now: Date = new Date(),
): number {
  const base =
    weights.occurrenceWeight * Math.max(0, inputs.occurrences) +
    weights.briefWeight * Math.max(0, inputs.briefCount) +
    weights.sessionStartWeight * Math.max(0, inputs.sessionStartCount) +
    weights.midSessionWeight * Math.max(0, inputs.midSessionCount);

  let recencyBonus = 0;
  if (inputs.lastHighSimilarityAt && weights.recencyWeight > 0) {
    const last = Date.parse(inputs.lastHighSimilarityAt);
    if (Number.isFinite(last)) {
      const ageDays = Math.max(0, (now.getTime() - last) / 86_400_000);
      recencyBonus = weights.recencyWeight * Math.exp(-weights.recencyDecayPerDay * ageDays);
    }
  }

  return base + recencyBonus;
}
