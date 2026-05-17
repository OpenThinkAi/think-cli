/**
 * Supersession worker — AGT-304
 *
 * Async fire-and-forget function invoked by sync-handler after a retro is
 * written to L1/L2. Performs the vector search + LLM call + apply step.
 *
 * Shape mirrors the compaction worker but is simpler: no queue, no retry
 * loop, just a single async function. AGT-299's compaction queue did not
 * land yet; this worker uses the same pattern (setImmediate fire-and-forget
 * from sync-handler.ts) to stay consistent with what will exist when the
 * queue arrives.
 *
 * Similarity threshold: 0.6 — entries below this are unlikely to conflict;
 * skipping the LLM call for low-similarity candidates avoids burning tokens
 * on clearly-unrelated retros (same triage gate as the compaction worker in
 * the README design).
 */

import embed from '../../lib/embed.js';
import { searchVectors } from '../../lib/search-vectors.js';
import { getCortexDb } from '../../db/engrams.js';
import { runSupersession } from './call.js';
import { applySupersession } from './apply.js';
import type { RetroEntry, RetroCandidate } from './call.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Top-K candidates fetched from vector search before the triage threshold. */
const CANDIDATE_K = 10;

/** Minimum cosine similarity to qualify as a supersession candidate. */
const SIMILARITY_THRESHOLD = 0.6;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the full supersession pipeline for a newly-stored retro entry.
 *
 * 1. Embed the content (reuses the singleton pipeline already warm from sync).
 * 2. Vector-search L2 for top-K same-kind retro candidates.
 * 3. Triage gate: if no candidates above threshold, skip the LLM call.
 * 4. LLM supersession call (runSupersession).
 * 5. Apply result (applySupersession).
 *
 * Errors bubble up to the caller (sync-handler wraps in .catch with a warn log).
 */
export async function runSupersessionWorker(
  newEntryId: string,
  newEntryTs: string,
  content: string,
  cortex: string,
): Promise<void> {
  // Step 1: embed the new entry's content
  const queryVec = await embed(content);

  // Step 2: vector search for top-K candidates
  const searchResults = searchVectors(cortex, queryVec, CANDIDATE_K);

  // Step 3: triage — filter to same-kind retro candidates above threshold,
  // excluding the new entry itself
  const db = getCortexDb(cortex);
  const aboveThreshold = searchResults.filter(
    (r) => r.id !== newEntryId && r.similarity >= SIMILARITY_THRESHOLD,
  );

  if (aboveThreshold.length === 0) {
    // No candidates above threshold — skip LLM call entirely.
    // Still apply empty-topics result so the topics_json column is consistent.
    applySupersession(newEntryId, { supersedes: [], topics: [], isDuplicate: false }, cortex);
    return;
  }

  // Fetch full content + ts for each candidate from L2
  const candidates: RetroCandidate[] = [];
  for (const { id } of aboveThreshold) {
    const row = db.prepare(
      `SELECT id, ts, content FROM memories WHERE id = ? AND deleted_at IS NULL`,
    ).get(id) as { id: string; ts: string; content: string } | undefined;
    if (row) {
      candidates.push({ id: row.id, date: row.ts, content: row.content });
    }
  }

  if (candidates.length === 0) {
    applySupersession(newEntryId, { supersedes: [], topics: [], isDuplicate: false }, cortex);
    return;
  }

  // Step 4: LLM call
  const newRetro: RetroEntry = {
    cortex,
    date: newEntryTs,
    content,
  };

  const result = await runSupersession(newRetro, candidates);

  // Step 5: apply
  applySupersession(newEntryId, result, cortex);
}
