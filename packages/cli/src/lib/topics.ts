/**
 * Topic merge helpers for curation passes (issue #86).
 *
 * User-supplied `--topic` values and the auto-applied `repo:<context>` tag are
 * intentional signal. Curation (supersession post-write enrichment, compaction)
 * may ADD derived topics but must never replace or drop what was already on
 * the entry — in particular `repo:*`, which `think brief` filters on
 * structurally to build the repo-lessons section.
 */

/**
 * Maximum topics per entry after a merge. Matches the sync-handler ingestion
 * cap (MAX_TOPICS in daemon/sync-handler.ts) so curation can never push an
 * entry past what sync would have accepted.
 */
export const MAX_MERGED_TOPICS = 20;

/**
 * A structural topic encodes a machine-readable scope rather than a
 * description — currently the `repo:<context>` tags that `think retro`
 * auto-applies and `think brief` filters on.
 */
export function isStructuralTopic(topic: string): boolean {
  return topic.toLowerCase().startsWith('repo:');
}

/**
 * Merge derived (curation-produced) topics into an entry's existing topics.
 *
 * - Existing topics are preserved verbatim, in their original order.
 * - Derived topics are appended when not already present (case-insensitive).
 * - The result is capped at MAX_MERGED_TOPICS; existing topics always win the
 *   cap over derived ones.
 */
export function mergeTopics(existing: string[], derived: string[]): string[] {
  const seen = new Set(existing.map((t) => t.toLowerCase()));
  const merged = [...existing];
  for (const topic of derived) {
    if (merged.length >= MAX_MERGED_TOPICS) break;
    const key = topic.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(topic);
  }
  return merged.slice(0, MAX_MERGED_TOPICS);
}

/**
 * Parse a topics_json column value into a string array. Returns [] for null,
 * malformed JSON, or non-array values; non-string elements are dropped.
 */
export function parseTopicsJson(topicsJson: string | null | undefined): string[] {
  if (!topicsJson) return [];
  try {
    const parsed: unknown = JSON.parse(topicsJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is string => typeof t === 'string');
  } catch {
    return [];
  }
}
