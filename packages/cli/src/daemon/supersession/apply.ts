/**
 * Apply supersession decisions — AGT-304
 *
 * Takes the LLM result from `runSupersession` (AGT-303) and applies it to L2:
 *
 *   - result.supersedes non-empty → mark those memory rows as superseded
 *     (superseded_at, superseded_by = newEntryId).
 *   - result.isDuplicate true → tombstone the new entry (deleted_at = now) in L2
 *     and append a tombstone JSONL line to L1 so the canonical record reflects
 *     the skip. Logs a note: line.
 *   - result.topics → write topic tags to the new entry's topics_json column in L2
 *     (L2-only post-write enrichment; L1 is append-only and keeps the original
 *     empty topics from the sync write).
 *
 * AC4 decision: topics are stored in L2 only for retros where they were
 * extracted post-write. L1 stays append-only; the original sync entry's topics
 * field remains []. If the L2 index is ever dropped and rebuilt (think reindex),
 * the topics would be re-extracted via a future reindex hook — for now they live
 * in L2 only and that is the accepted tradeoff (see ticket Note for spike).
 */

import { getCortexDb } from '../../db/engrams.js';
import { enqueueL1Outbox } from '../../lib/l1-page.js';
import { pushDebouncer } from '../push-debouncer.js';
import type { SupersessionResult } from './call.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply the supersession result to L2 (and L1 for tombstones).
 *
 * @param newEntryId  The id of the newly-stored retro entry.
 * @param result      The parsed LLM supersession result (from runSupersession).
 * @param safeCortex  Cortex name. Caller must have already sanitized via
 *                    `sanitizeName()`; this module trusts the value and performs
 *                    no further sanitization. Passing an unsanitized cortex name
 *                    is a programmer error.
 */
export function applySupersession(
  newEntryId: string,
  result: SupersessionResult,
  safeCortex: string,
): void {
  const db = getCortexDb(safeCortex);
  const now = new Date().toISOString();

  // --- AC2: mark superseded entries ---
  if (result.supersedes.length > 0) {
    const stmt = db.prepare(
      `UPDATE memories
       SET superseded_at = ?, superseded_by = ?
       WHERE id = ? AND superseded_at IS NULL`,
    );
    for (const id of result.supersedes) {
      stmt.run(now, newEntryId, id);
    }
  }

  // --- AC3: tombstone the new entry when it's a duplicate ---
  if (result.isDuplicate) {
    // L2: set deleted_at
    db.prepare(
      `UPDATE memories SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`,
    ).run(now, newEntryId);

    // L1: enqueue a tombstone line for the push-debouncer's plumbing drain
    // (no worktree switch — #70 Option B / AGT-458). We reconstruct the
    // tombstone from the durable L2 `memories` row rather than scanning the
    // worktree's L1 pages: the original retro line may still be sitting in
    // `l1_outbox` (un-drained) or live only on the cortex branch ref (not the
    // checked-out worktree), so a worktree scan is unreliable in the plumbing
    // world. L2 always carries the row by the time the supersession worker
    // runs.
    const original = db.prepare(
      `SELECT id, ts, author, content, origin_peer_id, kind, topics_json, source_ids
         FROM memories WHERE id = ?`,
    ).get(newEntryId) as
      | {
          id: string;
          ts: string;
          author: string;
          content: string;
          origin_peer_id: string | null;
          kind: string | null;
          topics_json: string | null;
          source_ids: string | null;
        }
      | undefined;

    if (original) {
      let topics: unknown[] = [];
      try {
        topics = original.topics_json ? (JSON.parse(original.topics_json) as unknown[]) : [];
      } catch {
        topics = [];
      }
      let sourceIds: unknown[] = [];
      try {
        sourceIds = original.source_ids ? (JSON.parse(original.source_ids) as unknown[]) : [];
      } catch {
        sourceIds = [];
      }
      const tombstone: Record<string, unknown> = {
        id: original.id,
        ts: original.ts,
        author: original.author,
        origin_peer_id: original.origin_peer_id,
        kind: original.kind ?? 'retro',
        content: original.content,
        topics,
        supersedes: [],
        compacted_from: null,
        source_ids: sourceIds,
        deleted_at: now,
        tombstone_reason: 'duplicate_detected_by_supersession',
      };
      enqueueL1Outbox(db, newEntryId, JSON.stringify(tombstone), now);
      pushDebouncer.notify(safeCortex);
      // Data deletion — log at warn so it's visible. The daemon log is the
      // only out-of-band signal for tombstone events; info-level would be
      // filtered out by warn+ consumers.
      console.warn(
        `[supersession] retro ${newEntryId} detected as duplicate; tombstoned`,
      );
    } else {
      // L2 tombstone is set above but the row vanished from L2 (should be
      // unreachable — the retro is written to L2 before this worker runs).
      // Log loudly so it appears in the daemon log and can be investigated.
      console.warn(
        `[supersession] warn: retro ${newEntryId} detected as duplicate and tombstoned in L2,` +
        ` but could not find its L2 row to reconstruct the L1 tombstone; L1 not updated`,
      );
    }

    // When tombstoned we still apply topics below (to the now-deleted row).
    // This is intentional — the row exists in L2 for lineage; topics help
    // future queries understand why it was tombstoned.
  }

  // --- AC4: update topics on the new entry in L2 (post-write enrichment) ---
  // L1 is append-only; the original sync entry keeps its empty topics array.
  // Topics live in L2 only for retros where they were extracted post-write.
  if (result.topics.length > 0) {
    db.prepare(
      `UPDATE memories SET topics_json = ? WHERE id = ?`,
    ).run(JSON.stringify(result.topics), newEntryId);
  }
}
