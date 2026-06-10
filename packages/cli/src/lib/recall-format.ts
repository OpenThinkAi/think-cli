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

      // Each entry occupies exactly ONE line (content is single-line after truncation
      // — no embedded newlines). wrapForAgent depends on this invariant to find and
      // wrap content via a forward-scanning cursor; don't change this without
      // updating wrapForAgent accordingly.
      //
      // AGT-465: provenance bracket added as a third tag segment ONLY when it
      // carries useful information:
      //   - In single-cortex mode, "[self]" is suppressed (every result is self —
      //     noise). Non-self values (peer:*, proxy:*, unknown) are always shown.
      //   - In multi-cortex mode, the bracket is always shown because the result
      //     set can mix self / peer / proxy from different cortexes.
      // This is a product-reviewer decision to avoid breaking the output format
      // for the common single-user, single-cortex case.
      const prov = entry.provenance ?? 'unknown';
      const showProv = multiCortex || prov !== 'self';

      // AGT-466: trust tier bracket rendered ONLY when the tier is `quarantined`
      // (the most salient case — content that was explicitly excluded by config
      // and is now being surfaced via --include-quarantined). `untrusted` is NOT
      // rendered by default: showing `[trust:untrusted]` on every peer/proxy entry
      // would break all existing user output (v1 conservative choice per the
      // approved plan "skip rendering entirely in v1" option). `trusted` is always
      // silent. The `trust="..."` attribute IS always emitted on the <recall-result>
      // envelope in --for-agent mode (additive, backward-compatible wire format).
      const tier = entry.trustTier ?? 'untrusted';
      const showTier = tier === 'quarantined'; // only quarantined surfaces visibly

      if (multiCortex) {
        if (showProv && showTier) {
          lines.push(`${date}  [${entry.cortex}/${kind}]  [${prov}]  [trust:${tier}]  ${content}`);
        } else if (showProv) {
          lines.push(`${date}  [${entry.cortex}/${kind}]  [${prov}]  ${content}`);
        } else if (showTier) {
          lines.push(`${date}  [${entry.cortex}/${kind}]  [trust:${tier}]  ${content}`);
        } else {
          lines.push(`${date}  [${entry.cortex}/${kind}]  ${content}`);
        }
      } else {
        if (showProv && showTier) {
          lines.push(`${date}  [${kind}]  [${prov}]  [trust:${tier}]  ${content}`);
        } else if (showProv) {
          lines.push(`${date}  [${kind}]  [${prov}]  ${content}`);
        } else if (showTier) {
          lines.push(`${date}  [${kind}]  [trust:${tier}]  ${content}`);
        } else {
          lines.push(`${date}  [${kind}]  ${content}`);
        }
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

// ---------------------------------------------------------------------------
// Agent-consumption wrapping — AGT-464
// ---------------------------------------------------------------------------

/**
 * Escape literal `<recall-result` / `</recall-result` substrings in content
 * so peer-authored text cannot break out of the `<recall-result>` envelope.
 *
 * Uses case-insensitive matching, mirroring wrapData()'s `<\/?data` regex
 * in src/lib/sanitize.ts. The opening half of the tag is sufficient: escaping
 * `<recall-result` covers both the open tag (`<recall-result ...>`) and the
 * close tag (`</recall-result>`) because the close tag starts with `</recall-result`.
 */
export function escapeRecallDelimiters(content: string): string {
  // Capture the `<` and everything after it so we can replace just the `<`
  // with `&lt;`, preserving the original casing of the tag name and slash.
  return content.replace(/<(\/?)recall-result/gi, (match) => `&lt;${match.slice(1)}`);
}

/**
 * HTML-escape a string for use in an XML attribute value (double-quoted).
 * Escapes `"` → `&quot;` and `<` → `&lt;`.
 */
function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * Wrap each entry's content in `<recall-result>` delimiters for agent consumers.
 *
 * Preserves the human-readable group headers (e.g. `── retros (3) ──`) and
 * the per-entry date/kind prefix line OUTSIDE the wrap so the format degrades
 * gracefully when a consuming agent ignores the tags.
 *
 * Each entry in `formatted` is matched by scanning `entries` in order (same
 * order the formatter produces them). The wrap is applied only to the content
 * fragment — the `YYYY-MM-DD  [kind]  ` prefix remains outside the tag so the
 * existing human-readable structure is preserved.
 *
 * Attribute values are HTML-escaped (`&quot;` for `"`, `&lt;` for `<`) so a
 * peer-authored cortex name or entry ID cannot break out of the attribute
 * context.
 *
 * @param formatted  Output of formatRecallOutput() — the full formatted string.
 * @param entries    The same RecallEntry[] that was passed to formatRecallOutput().
 * @returns          The formatted string with each entry's content body wrapped.
 */
export function wrapForAgent(formatted: string, entries: RecallEntry[]): string {
  if (entries.length === 0) return formatted;

  // The formatter always emits one line per entry in the shape:
  //   `${date}  [${kind}]  ${content}` (single-cortex)
  //   `${date}  [${cortex}/${kind}]  ${content}` (multi-cortex)
  // Entries are emitted in the same order as they appear in the `entries` array.
  //
  // Correctness invariant: two entries MAY share the same (date, kind, cortex)
  // — e.g. two memories captured on the same day from the same cortex. To avoid
  // the first occurrence being matched twice (and the second entry's line never
  // wrapped), we track a forward-only `searchFrom` cursor that advances past each
  // match. This ensures the Nth entry finds the Nth occurrence of its prefix, even
  // when multiple entries share the same prefix string.
  //
  // NOTE: wrapping replaces only the content portion of a line (from after the
  // prefix to the next `\n` or end-of-string). This relies on content being
  // single-line, which is guaranteed today by the formatter's 200-char truncation
  // and its `lines.push(...)` shape — no newlines are ever emitted inside a content
  // value. If the formatter ever allows multi-line content, update this approach.

  let result = formatted;
  // `searchFrom` is a cursor that advances past each processed entry line so
  // duplicate prefixes find the correct (next) occurrence rather than the first.
  let searchFrom = 0;

  for (const entry of entries) {
    const date = entry.ts.slice(0, 10);
    const kind = entry.kind ?? 'memory';
    // The cortex field is always set for entries returned by the daemon/FTS paths.
    const cortexRaw = entry.cortex ?? '';
    // AGT-465: provenance defaults to 'unknown' for entries without the field
    // (e.g., wire entries from an older daemon version).
    const provRaw = entry.provenance ?? 'unknown';

    // AGT-465: provenance bracket visibility mirrors formatRecallOutput exactly.
    // formatRecallOutput rule: showProv = multiCortex || prov !== 'self'
    // wrapForAgent doesn't know which mode the formatter used, but it doesn't
    // need to: it tries both prefix forms and takes whichever one matches.
    // So each prefix is built to match its respective formatter variant:
    //   - prefixSingle: shown when prov != 'self' (single-cortex suppress rule)
    //   - prefixMulti:  always shown (multi-cortex always shows provenance)
    const showProvSingle = provRaw !== 'self';

    // AGT-466: trust tier bracket visibility mirrors formatRecallOutput exactly.
    // Only `quarantined` emits a [trust:<tier>] bracket in human output (v1 conservative).
    const tierRaw = entry.trustTier ?? 'untrusted';
    const showTier = tierRaw === 'quarantined';

    // Build both candidate prefixes; the formatter uses single-cortex form when
    // all entries share one cortex, multi-cortex form otherwise.
    const prefixSingle = showProvSingle
      ? (showTier ? `${date}  [${kind}]  [${provRaw}]  [trust:${tierRaw}]  ` : `${date}  [${kind}]  [${provRaw}]  `)
      : (showTier ? `${date}  [${kind}]  [trust:${tierRaw}]  ` : `${date}  [${kind}]  `);
    // Multi-cortex: check prov + tier combinations — mirrors the 4-way branch in formatRecallOutput.
    // Multi-cortex always shows provenance (showProv = true when multiCortex).
    const prefixMulti = showTier
      ? `${date}  [${cortexRaw}/${kind}]  [${provRaw}]  [trust:${tierRaw}]  `
      : `${date}  [${cortexRaw}/${kind}]  [${provRaw}]  `;

    // Find the next occurrence of this entry's prefix starting at searchFrom.
    // Try single-cortex first; if not found at or after searchFrom, try multi.
    let idx = result.indexOf(prefixSingle, searchFrom);
    let prefix = prefixSingle;
    if (idx === -1) {
      idx = result.indexOf(prefixMulti, searchFrom);
      prefix = prefixMulti;
    }
    if (idx === -1) continue; // entry line not found — skip silently

    const contentStart = idx + prefix.length;
    const lineEnd = result.indexOf('\n', contentStart);
    const rawContent = lineEnd === -1
      ? result.slice(contentStart)
      : result.slice(contentStart, lineEnd);

    const escaped    = escapeRecallDelimiters(rawContent);
    const cortexAttr = escapeAttr(cortexRaw);
    const kindAttr   = escapeAttr(kind);
    const idAttr     = escapeAttr(entry.id);
    // AGT-465: add provenance attribute to the envelope tag.
    const provAttr   = escapeAttr(provRaw);
    // AGT-466: add trust tier attribute to the envelope tag.
    const trustAttr  = escapeAttr(tierRaw);
    const wrapped    = `<recall-result cortex="${cortexAttr}" kind="${kindAttr}" id="${idAttr}" provenance="${provAttr}" trust="${trustAttr}">${escaped}</recall-result>`;

    result = result.slice(0, contentStart) + wrapped + (lineEnd === -1 ? '' : result.slice(lineEnd));

    // Advance the cursor past the end of the line we just processed (in the
    // updated `result`). The wrapped replacement is longer than `rawContent`
    // but we only need to advance past the current `idx` so later entries
    // with the same prefix find the *next* occurrence, not this one again.
    searchFrom = contentStart + wrapped.length;
  }

  return result;
}
