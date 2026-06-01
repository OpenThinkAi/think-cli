/**
 * Write-time retro quality gate — AGT-455 (iterative-learning-v2 §5 M1).
 *
 * Junk retros ("trigger A", "rapid 1".."rapid 4", "repro stamp-cli",
 * "capture full err") historically entered the corpus freely — only a 64 KB
 * size cap existed. They then polluted recall (telemetry: "repro attempt
 * cortex think-cli" surfaced 13×). This module gates `kind="retro"` writes at
 * intake, before they reach L1/L2.
 *
 * Three checks, applied to retros only (memory/event writes are untouched):
 *   1. Minimum signal — reject content below a configurable length floor
 *      (default 40 chars), unless an explicit `force` flag is set.
 *   2. Test/junk shape — reject content matching an obvious test-detritus
 *      pattern (`^(repro|rapid|trigger|test)\b`) or a single bare token.
 *      Also bypassable via `force`.
 *   3. Near-duplicate fold (handled in sync-handler, not here) — see
 *      `RETRO_NEAR_DUP_THRESHOLD`.
 *
 * Length is measured in trimmed characters (not bytes): the floor is about
 * human-meaningful signal, and a sub-40-char retro is low-signal regardless
 * of multibyte encoding. The 64 KB byte cap in sync-handler still guards the
 * upper bound independently.
 */

import { getConfig } from '../lib/config.js';

/** Default minimum trimmed-character length for a retro. Config-tunable. */
export const DEFAULT_RETRO_MIN_LENGTH = 40;

/**
 * Default cosine-similarity threshold above which a new retro is folded into
 * an existing one (occurrences++) instead of inserted. Config-tunable.
 *
 * 0.95 is deliberately high — well above the 0.6 supersession-candidate
 * triage gate. At 0.95 the two retros are near-textually-identical
 * re-reports, not merely related lessons, so folding is safe and cheap dedup
 * before the LLM supersession worker even runs.
 */
export const DEFAULT_RETRO_NEAR_DUP_THRESHOLD = 0.95;

/**
 * Test/junk-shape pattern. Matches content that opens with an obvious
 * test-detritus token. Case-insensitive, anchored at the start so a
 * legitimate lesson that merely mentions "test" or "trigger" mid-sentence is
 * not caught — only content that *begins* as test scaffolding.
 */
const JUNK_SHAPE_RE = /^(repro|rapid|trigger|test)\b/i;

/** Matches a single bare token (one whitespace-delimited word, no internal spaces). */
const SINGLE_TOKEN_RE = /^\S+$/;

/**
 * Resolve the configured minimum retro length, falling back to the default.
 * Read at call time so `think config set cortex.retroMinLength <n>` takes
 * effect without a daemon restart (getConfig re-reads the file each call).
 */
export function getRetroMinLength(): number {
  const v = getConfig().cortex?.retroMinLength;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : DEFAULT_RETRO_MIN_LENGTH;
}

/** Resolve the configured near-duplicate cosine threshold, falling back to the default. */
export function getRetroNearDupThreshold(): number {
  const v = getConfig().cortex?.retroNearDupThreshold;
  return typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_RETRO_NEAR_DUP_THRESHOLD;
}

/**
 * Validate retro content against the length floor and junk-shape heuristics.
 *
 * Throws `Error` with an actionable, user-readable message naming the reason
 * and how to override (matching sync-handler's existing throw-on-invalid
 * contract; the 1.11.1 un-truncated error path surfaces it to the user).
 * Returns silently when the content passes.
 *
 * @param content  Raw retro content (already confirmed non-empty by the
 *                 caller's base validation).
 * @param force    When true, both checks are skipped — the user is explicitly
 *                 attesting the retro is intentional.
 */
export function validateRetroContent(content: string, force: boolean): void {
  if (force) return;

  const trimmed = content.trim();
  const minLength = getRetroMinLength();

  // Check 1: minimum signal length.
  if (trimmed.length < minLength) {
    throw new Error(
      `retro rejected: content is too short (${trimmed.length} chars; minimum ${minLength}). ` +
      `Retros are durable lessons — write a full observation, or pass --force to override. ` +
      `Tune the floor with: think config set cortex.retroMinLength <n>`,
    );
  }

  // Check 2: test/junk shape.
  if (JUNK_SHAPE_RE.test(trimmed)) {
    throw new Error(
      `retro rejected: content looks like test/scaffolding detritus ` +
      `(starts with repro/rapid/trigger/test). ` +
      `If this is a genuine lesson, reword it or pass --force to override.`,
    );
  }
  if (SINGLE_TOKEN_RE.test(trimmed)) {
    throw new Error(
      `retro rejected: content is a single bare token ('${trimmed}') — not a lesson. ` +
      `Write a full observation, or pass --force to override.`,
    );
  }
}
