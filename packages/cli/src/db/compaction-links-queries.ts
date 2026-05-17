import { getCortexDb } from './engrams.js';

/**
 * Returns all compacted_ids that were compacted from the given raw entry.
 * Returns an empty array if no compactions exist for this raw_id.
 *
 * Used by `think expand <id>` to find what compacted entries folded a raw entry.
 */
export function getCompactionsForRaw(cortexName: string, rawId: string): string[] {
  const db = getCortexDb(cortexName);
  const rows = db.prepare(
    'SELECT compacted_id FROM compaction_links WHERE raw_id = ?'
  ).all(rawId) as { compacted_id: string }[];
  return rows.map(r => r.compacted_id);
}

/**
 * Returns all raw_ids that were folded into the given compacted entry.
 * Returns an empty array if the compacted_id has no recorded links.
 *
 * Inverse of `getCompactionsForRaw`.
 */
export function getRawForCompaction(cortexName: string, compactedId: string): string[] {
  const db = getCortexDb(cortexName);
  const rows = db.prepare(
    'SELECT raw_id FROM compaction_links WHERE compacted_id = ?'
  ).all(compactedId) as { raw_id: string }[];
  return rows.map(r => r.raw_id);
}
