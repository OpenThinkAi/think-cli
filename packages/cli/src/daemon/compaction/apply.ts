/**
 * Apply compaction result — AGT-301
 *
 * Takes the LLM result from `runCompaction` (AGT-298) and applies it atomically:
 *
 *   1. Insert new compacted entry into L1 (active JSONL page) + L2 with
 *      embedding + activity_seq.
 *   2. Insert (raw_id, compacted_id) rows into `compaction_links` (AGT-271).
 *   3. For each id in `llmResult.supersedes`: mark the corresponding L2 row
 *      with `superseded_at` + `superseded_by` (idempotent — only updates rows
 *      where `superseded_at IS NULL`). Mirrors `applySupersession` from AGT-304.
 *
 * All three mutations execute inside a single SQLite transaction so a crash
 * between any two steps cannot leave L2 in a partially-applied state.
 *
 * L1 is written before the transaction opens (L1 is append-only and not
 * transactional). On crash between L1 write and L2 transaction commit, the
 * daemon restart scan (`scanAndEnqueueUncompacted`) will re-queue the raw
 * entry. The compacted L1 line will be re-read on the next reindex.
 *
 * Security note: `safeCortex` is received pre-sanitized from the caller
 * (post-AGT-304 pattern). This module trusts the value; passing an
 * unsanitized cortex name is a programmer error.
 */

import path from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { getCortexDb } from '../../db/engrams.js';
import { assignNextSeq } from '../../db/activity-seq.js';
import { getRepoPath } from '../../lib/paths.js';
import { getConfig, getPeerId } from '../../lib/config.js';
import embed, { EMBEDDING_MODEL_NAME } from '../../lib/embed.js';
import { appendToL1Page } from '../../lib/l1-page.js';
import { ensureBranchCheckedOut } from '../../lib/git.js';
import type { CompactionSuccess, NewEntry } from './call.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply a compaction result produced by `runCompaction`:
 *
 * 1. Build and write the new compacted L1 entry.
 * 2. Embed its content and insert into L2 with activity_seq.
 * 3. In a single SQLite transaction:
 *    a. Insert L2 row for the compacted entry.
 *    b. Insert `compaction_links` rows for each (rawEntry.id, compactedId).
 *    c. Mark each id in `llmResult.supersedes` with superseded_at / superseded_by
 *       (idempotent — only rows where superseded_at IS NULL are updated).
 *
 * @param rawEntry  The original raw entry that was compacted. Must include `id`.
 * @param llmResult The successful compaction result from `runCompaction`.
 * @param safeCortex Cortex name. Must already be sanitized by the caller.
 */
export async function applyCompaction(
  rawEntry: NewEntry & { id: string },
  llmResult: CompactionSuccess,
  safeCortex: string,
): Promise<void> {
  const compactedId = uuidv7();
  const ts = new Date().toISOString();
  const config = getConfig();
  const author = config.cortex?.author ?? 'unknown';
  const origin_peer_id = getPeerId();

  // ── Step 1: write new compacted entry to L1 ──────────────────────────────
  const l1Entry: Record<string, unknown> = {
    id: compactedId,
    ts,
    author,
    origin_peer_id,
    kind: 'memory',
    content: llmResult.compacted_text,
    topics: llmResult.topics,
    supersedes: llmResult.supersedes,
    compacted_from: [rawEntry.id],
    decisions: [],
    source_ids: [],
    deleted_at: null,
  };

  const cortexDir = path.join(getRepoPath(), safeCortex);
  // Switch the working tree to the cortex's branch before appending so the
  // compacted line lands in the right tree even when another cortex's
  // write switched the branch out earlier in the daemon's lifetime. See
  // `ensureBranchCheckedOut`.
  ensureBranchCheckedOut(safeCortex);
  appendToL1Page(cortexDir, l1Entry);

  // ── Step 2: embed the compacted content ──────────────────────────────────
  const embeddingVec = await embed(llmResult.compacted_text);
  const embeddingBytes = Buffer.from(
    embeddingVec.buffer,
    embeddingVec.byteOffset,
    embeddingVec.byteLength,
  );

  // ── Step 3: atomic L2 writes ──────────────────────────────────────────────
  const activitySeq = assignNextSeq(safeCortex);
  const db = getCortexDb(safeCortex);

  db.exec('BEGIN');
  try {
    // 3a. Insert compacted entry into L2
    db.prepare(`
      INSERT OR IGNORE INTO memories
        (id, ts, author, content, source_ids, created_at, deleted_at,
         sync_version, origin_peer_id, embedding, embedding_model, activity_seq,
         kind, topics_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
    `).run(
      compactedId,
      ts,
      author,
      llmResult.compacted_text,
      JSON.stringify([]),
      ts,
      null,
      origin_peer_id,
      embeddingBytes,
      EMBEDDING_MODEL_NAME,
      activitySeq,
      'memory',
      JSON.stringify(llmResult.topics),
    );

    // 3b. Insert compaction_links row for (rawEntry.id, compactedId)
    db.prepare(
      'INSERT OR IGNORE INTO compaction_links (raw_id, compacted_id) VALUES (?, ?)',
    ).run(rawEntry.id, compactedId);

    // 3c. Mark superseded entries (prompt-injection guard: only IDs that are
    // in the `supersedes` list returned by the LLM; caller already filtered
    // these against the actual candidate set before passing llmResult in).
    if (llmResult.supersedes.length > 0) {
      const supersededStmt = db.prepare(
        `UPDATE memories
         SET superseded_at = ?, superseded_by = ?
         WHERE id = ? AND superseded_at IS NULL`,
      );
      for (const id of llmResult.supersedes) {
        supersededStmt.run(ts, compactedId, id);
      }
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  log(
    `compaction applied (raw=${rawEntry.id}, compacted=${compactedId}, cortex=${safeCortex}): ` +
    `supersedes=[${llmResult.supersedes.join(', ')}] topics=[${llmResult.topics.join(', ')}]`,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a timestamped line to stderr (daemon log). */
function log(msg: string): void {
  process.stderr.write(`[${new Date().toISOString()}] [compaction-apply] ${msg}\n`);
}
