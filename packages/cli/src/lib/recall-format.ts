/**
 * Pure formatting for `think recall` default output — AGT-318.
 *
 * Input:  RecallEntry[] + FormatOptions
 * Output: string (ready to print to stdout)
 *
 * Conventions (product-reviewer prose style):
 *   - Lowercase `note:` prefix for informational lines.
 *   - Section separators use `─` (U+2500).
 *   - No novel glyphs beyond the established set.
 *   - Content is truncated at 200 Unicode scalar values (not bytes) with `…`
 *     appended when truncated.
 *   - Groups are sorted in fixed order: retro → event → memory.
 *   - Per-entry cortex tag omitted when all results come from a single cortex.
 */

import type { RecallEntry } from '../daemon/recall.js';

// Fixed group order per AC2: durable wisdom (retros) first, then events,
// then memories.
const KIND_ORDER: string[] = ['retro', 'event', 'memory'];

// Default maximum entries returned by recall (AC1).
export const DEFAULT_RECALL_LIMIT = 8;

// Default truncation length in Unicode scalar values (AC3).
const CONTENT_TRUNCATE_CHARS = 200;

export interface FormatOptions {
  /**
   * When true, do not truncate content. This lifts the 200-char truncation
   * imposed in default mode (--full CLI flag, AC5).
   */
  full?: boolean;
}

/**
 * Truncate text to at most maxChars Unicode scalar values.
 * Uses the Unicode-aware spread to correctly handle multi-byte glyphs
 * (emoji, CJK, etc.) so the limit is applied in characters, not bytes.
 * Returns the original string if it is already short enough.
 */
export function truncateUnicode(text: string, maxChars: number): string {
  // Fast path: code-unit count is always >= scalar count, so a short code-unit
  // count proves the scalar count is also short — safe to return early.
  if (text.length <= maxChars) return text;
  // Spread splits by Unicode code point, not UTF-16 code unit.
  const chars = [...text];
  if (chars.length <= maxChars) return text;
  return chars.slice(0, maxChars).join('') + '…';
}

/**
 * Format an ISO timestamp to a short date string: YYYY-MM-DD.
 */
function formatDate(ts: string): string {
  return ts.slice(0, 10);
}

/**
 * Normalize null kind (pre-v3 rows with no kind tag) to 'memory'.
 * These are the legacy v2 rows and render as memories.
 */
function normalizeKind(kind: string | null): string {
  return kind ?? 'memory';
}

/**
 * Pluralize a kind label for section headers.
 * Uses explicit rules for known kinds; falls back to adding s for unknowns.
 */
function pluralKind(kind: string): string {
  if (kind === 'memory') return 'memories';
  return kind + 's';
}

/**
 * Format a think recall result set as a human-and-agent-readable string.
 *
 * @param entries  Results from the recall RPC, already ranked and limited.
 *                 The formatter does NOT apply the 8-entry default cap —
 *                 callers must pass the already-truncated list.
 * @param cortexes Set of cortex names present in entries. Pre-computed by
 *                 the caller to avoid iterating twice for the single-cortex
 *                 check.
 * @param opts     Formatting options.
 * @returns        Formatted string for stdout.
 */
export function formatRecallOutput(
  entries: RecallEntry[],
  cortexes: ReadonlySet<string>,
  opts: FormatOptions = {},
): string {
  if (entries.length === 0) {
    const cortexList = [...cortexes].sort().join(', ');
    return `note: no entries matched in ${cortexList}`;
  }

  const multiCortex = cortexes.size > 1;
  const lines: string[] = [];

  // Group entries by kind, preserving rank order within each group.
  const groups = new Map<string, RecallEntry[]>();
  for (const entry of entries) {
    const k = normalizeKind(entry.kind);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(entry);
  }

  // Emit groups in fixed order; emit any unknown kinds after the known ones.
  const knownKinds = KIND_ORDER.filter(k => groups.has(k));
  const unknownKinds = [...groups.keys()].filter(k => !KIND_ORDER.includes(k)).sort();
  const orderedKinds = [...knownKinds, ...unknownKinds];

  for (let gi = 0; gi < orderedKinds.length; gi++) {
    const kind = orderedKinds[gi];
    const groupEntries = groups.get(kind)!;
    const count = groupEntries.length;

    lines.push(`── ${pluralKind(kind)} (${count}) ──`);

    for (const entry of groupEntries) {
      const date = formatDate(entry.ts);
      const content = opts.full
        ? entry.content
        : truncateUnicode(entry.content, CONTENT_TRUNCATE_CHARS);

      if (multiCortex) {
        lines.push(`${date}  [${entry.cortex}/${kind}]  ${content}`);
      } else {
        lines.push(`${date}  [${kind}]  ${content}`);
      }
    }

    if (gi < orderedKinds.length - 1) {
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Build the cortex set from a list of recall entries.
 * Exported so the CLI action can compute it once and pass it to formatRecallOutput.
 */
export function cortexSet(entries: RecallEntry[]): Set<string> {
  return new Set(entries.map(e => e.cortex).filter(Boolean));
}
