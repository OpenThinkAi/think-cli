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
import { sanitizeName } from '../../lib/paths.js';
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
 * 2. Vector-search L2 for top-K candidates.
 * 3. Triage gate: filter to same-kind retro candidates above threshold;
 *    skip the LLM call entirely if none qualify.
 * 4. LLM supersession call (runSupersession).
 * 5. Filter LLM-returned supersedes IDs against the actual candidate set
 *    (prevents prompt-injection from marking unrelated entries as superseded).
 * 6. Apply result (applySupersession).
 *
 * Errors bubble up to the caller (sync-handler wraps in .catch with a warn log).
 *
 * @param cortex Must be the sanitized cortex name (safeCortex from sync-handler).
 */
export async function runSupersessionWorker(
  newEntryId: string,
  newEntryTs: string,
  content: string,
  cortex: string,
): Promise<void> {
  // Re-sanitize defensively — callers pass safeCortex but an explicit guard
  // prevents future call sites from accidentally passing unsanitized values.
  const safeCortex = sanitizeName(cortex);

  // Step 1: embed the new entry's content
  const queryVec = await embed(content);

  // Step 2: vector search for top-K candidates (all kinds; filtered in step 3)
  const searchResults = searchVectors(safeCortex, queryVec, CANDIDATE_K);

  // Step 3: triage — filter by similarity threshold, excluding the new entry.
  // Kind filtering (retro only) happens in the SQL query below. Entries written
  // before migration 14 have kind = NULL; the SQL treats them as retro candidates
  // conservatively so legacy data participates in supersession.
  const aboveThreshold = searchResults.filter(
    (r) => r.id !== newEntryId && r.similarity >= SIMILARITY_THRESHOLD,
  );

  if (aboveThreshold.length === 0) {
    // No candidates above threshold — skip LLM call entirely.
    return;
  }

  // Fetch full content + ts + kind for each candidate from L2; filter to
  // retro-kind (kind = 'retro' OR kind IS NULL for pre-migration rows).
  const db = getCortexDb(safeCortex);
  const candidateStmt = db.prepare(
    `SELECT id, ts, content, kind FROM memories
     WHERE id = ? AND deleted_at IS NULL AND (kind = 'retro' OR kind IS NULL)`,
  );
  const candidates: RetroCandidate[] = [];
  for (const { id } of aboveThreshold) {
    const row = candidateStmt.get(id) as
      { id: string; ts: string; content: string; kind: string | null } | undefined;
    if (row) {
      candidates.push({ id: row.id, date: row.ts, content: row.content });
    }
  }

  if (candidates.length === 0) {
    // All above-threshold entries are non-retro kinds — skip LLM call.
    return;
  }

  // Step 4: LLM call
  const newRetro: RetroEntry = {
    cortex: safeCortex,
    date: newEntryTs,
    content,
  };

  const result = await runSupersession(newRetro, candidates);

  // Step 5: filter LLM-returned supersedes IDs against the actual candidate
  // set. This prevents prompt-injection in retro content from causing the LLM
  // to return IDs that were never presented as candidates, which would
  // incorrectly mark unrelated entries as superseded.
  const candidateIds = new Set(candidates.map((c) => c.id));
  const safeResult = {
    ...result,
    supersedes: result.supersedes.filter((id) => candidateIds.has(id)),
  };

  // Step 6: apply
  applySupersession(newEntryId, safeResult, safeCortex);
}
