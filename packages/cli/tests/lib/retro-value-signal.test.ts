import { describe, it, expect } from 'vitest';
import {
  computeRetroValueSignal,
  resolveRetroValueWeights,
  DEFAULT_RETRO_VALUE_OCCURRENCE_WEIGHT,
  DEFAULT_RETRO_VALUE_BRIEF_WEIGHT,
  DEFAULT_RETRO_VALUE_SESSION_START_WEIGHT,
  DEFAULT_RETRO_VALUE_MID_SESSION_WEIGHT,
  DEFAULT_RETRO_VALUE_PROMOTE_THRESHOLD,
  DEFAULT_RETRO_VALUE_RECENCY_WEIGHT,
} from '../../src/lib/retro-value-signal.js';

const NOW = new Date('2026-06-01T00:00:00.000Z');

describe('resolveRetroValueWeights', () => {
  it('falls back to defaults when config is undefined', () => {
    const w = resolveRetroValueWeights(undefined);
    expect(w.occurrenceWeight).toBe(DEFAULT_RETRO_VALUE_OCCURRENCE_WEIGHT);
    expect(w.briefWeight).toBe(DEFAULT_RETRO_VALUE_BRIEF_WEIGHT);
    expect(w.promoteThreshold).toBe(DEFAULT_RETRO_VALUE_PROMOTE_THRESHOLD);
  });

  it('overrides only the fields present in config', () => {
    const w = resolveRetroValueWeights({ occurrenceWeight: 10, promoteThreshold: 99 });
    expect(w.occurrenceWeight).toBe(10);
    expect(w.promoteThreshold).toBe(99);
    // Untouched field still defaults.
    expect(w.briefWeight).toBe(DEFAULT_RETRO_VALUE_BRIEF_WEIGHT);
  });

  it('rejects non-finite / negative config values and uses the default', () => {
    const w = resolveRetroValueWeights({
      occurrenceWeight: Number.NaN,
      briefWeight: -5,
    });
    expect(w.occurrenceWeight).toBe(DEFAULT_RETRO_VALUE_OCCURRENCE_WEIGHT);
    expect(w.briefWeight).toBe(DEFAULT_RETRO_VALUE_BRIEF_WEIGHT);
  });
});

describe('computeRetroValueSignal', () => {
  const W = resolveRetroValueWeights(undefined);

  it('reduces to occurrenceWeight * occurrences with no telemetry', () => {
    const signal = computeRetroValueSignal(
      { occurrences: 2, briefCount: 0, sessionStartCount: 0, midSessionCount: 0, lastHighSimilarityAt: null },
      W,
      NOW,
    );
    expect(signal).toBe(2 * DEFAULT_RETRO_VALUE_OCCURRENCE_WEIGHT);
  });

  it('preserves the legacy gate: occurrences=2 clears the default threshold, occurrences=1 does not', () => {
    const one = computeRetroValueSignal(
      { occurrences: 1, briefCount: 0, sessionStartCount: 0, midSessionCount: 0, lastHighSimilarityAt: null },
      W,
      NOW,
    );
    const two = computeRetroValueSignal(
      { occurrences: 2, briefCount: 0, sessionStartCount: 0, midSessionCount: 0, lastHighSimilarityAt: null },
      W,
      NOW,
    );
    expect(one).toBeLessThan(W.promoteThreshold);
    expect(two).toBeGreaterThanOrEqual(W.promoteThreshold);
  });

  it('weights brief + session-start surfacings above mid-session noise', () => {
    const base = { occurrences: 1, lastHighSimilarityAt: null };
    const brief = computeRetroValueSignal(
      { ...base, briefCount: 1, sessionStartCount: 0, midSessionCount: 0 },
      W,
      NOW,
    );
    const session = computeRetroValueSignal(
      { ...base, briefCount: 0, sessionStartCount: 1, midSessionCount: 0 },
      W,
      NOW,
    );
    const mid = computeRetroValueSignal(
      { ...base, briefCount: 0, sessionStartCount: 0, midSessionCount: 1 },
      W,
      NOW,
    );
    expect(brief).toBeGreaterThan(mid);
    expect(session).toBeGreaterThan(mid);
    // A single brief surfacing pushes a one-occurrence retro over the threshold;
    // a single mid-session surfacing does not.
    expect(brief).toBeGreaterThanOrEqual(W.promoteThreshold);
    expect(mid).toBeLessThan(W.promoteThreshold);
  });

  it('a single-occurrence retro with modest mid-session noise stays below the promote threshold', () => {
    // 4 mid-session surfacings on a single-occurrence retro: 3.0 + 4*0.25 = 4.0 < 5.0.
    // Modest noise stays below the threshold (not a boundary probe — enough
    // mid-session hits would eventually clear it; that's not what this checks).
    const signal = computeRetroValueSignal(
      { occurrences: 1, briefCount: 0, sessionStartCount: 0, midSessionCount: 4, lastHighSimilarityAt: null },
      W,
      NOW,
    );
    // 3.0 + 4*0.25 = 4.0 < 5.0
    expect(signal).toBe(
      DEFAULT_RETRO_VALUE_OCCURRENCE_WEIGHT + 4 * DEFAULT_RETRO_VALUE_MID_SESSION_WEIGHT,
    );
    expect(signal).toBeLessThan(W.promoteThreshold);
  });

  it('adds a recency bonus that decays with the age of the last high-similarity surfacing', () => {
    const fresh = computeRetroValueSignal(
      { occurrences: 1, briefCount: 0, sessionStartCount: 0, midSessionCount: 0, lastHighSimilarityAt: NOW.toISOString() },
      W,
      NOW,
    );
    const old = computeRetroValueSignal(
      {
        occurrences: 1,
        briefCount: 0,
        sessionStartCount: 0,
        midSessionCount: 0,
        lastHighSimilarityAt: new Date(NOW.getTime() - 90 * 86_400_000).toISOString(),
      },
      W,
      NOW,
    );
    const none = computeRetroValueSignal(
      { occurrences: 1, briefCount: 0, sessionStartCount: 0, midSessionCount: 0, lastHighSimilarityAt: null },
      W,
      NOW,
    );
    // Fresh high-sim surfacing adds nearly the full recency weight.
    expect(fresh - none).toBeCloseTo(DEFAULT_RETRO_VALUE_RECENCY_WEIGHT, 5);
    // A 90-day-old one is heavily decayed but still > 0.
    expect(old).toBeGreaterThan(none);
    expect(old).toBeLessThan(fresh);
  });

  it('treats negative inputs as zero (defensive)', () => {
    const signal = computeRetroValueSignal(
      { occurrences: -3, briefCount: -2, sessionStartCount: -1, midSessionCount: -5, lastHighSimilarityAt: null },
      W,
      NOW,
    );
    expect(signal).toBe(0);
  });
});
