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

import fs from 'node:fs';
import path from 'node:path';
import { getCortexDb } from '../../db/engrams.js';
import { getRepoPath } from '../../lib/paths.js';
import type { SupersessionResult } from './call.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read all non-blank JSONL lines from all page files in a cortex L1 dir,
 * returning parsed objects.
 */
function readL1Lines(cortexDir: string): Record<string, unknown>[] {
  if (!fs.existsSync(cortexDir)) return [];
  const lines: Record<string, unknown>[] = [];
  const files = fs.readdirSync(cortexDir)
    .filter(f => /^\d{6}\.jsonl$/.test(f))
    .sort();
  for (const file of files) {
    const raw = fs.readFileSync(path.join(cortexDir, file), 'utf-8');
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // Malformed line — skip
      }
    }
  }
  return lines;
}

/**
 * Append a single JSONL line to the active L1 page for the cortex.
 * Mirrors the page-file naming convention from sync-handler.ts.
 * Does NOT commit or push — that is the push-debounce worker's job.
 *
 * NOTE: If `cortexDir` exists but contains no JSONL files, this function
 * creates `000001.jsonl` containing only the appended line. A page that
 * opens with a tombstone (no original write) indicates a state divergence
 * (L2 was written but L1 was not, or files were removed from L1). The caller
 * (`applySupersession`) guards against this scenario by checking whether the
 * original entry was found in L1 before calling this function. This case
 * should be unreachable in normal operation.
 */
function appendToL1(cortexDir: string, obj: Record<string, unknown>): void {
  if (!fs.existsSync(cortexDir)) return; // cortex dir missing — no-op
  const files = fs.readdirSync(cortexDir)
    .filter(f => /^\d{6}\.jsonl$/.test(f))
    .sort();
  const activePage = files.length > 0
    ? path.join(cortexDir, files[files.length - 1])
    : path.join(cortexDir, '000001.jsonl');
  fs.appendFileSync(activePage, JSON.stringify(obj) + '\n', 'utf-8');
}

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

    // L1: append a tombstone line that downstream sync can propagate.
    // Find the original L1 entry so we can preserve its fields.
    const cortexDir = path.join(getRepoPath(), safeCortex);
    const original = readL1Lines(cortexDir).find(
      (l) => l['id'] === newEntryId,
    );
    if (original) {
      appendToL1(cortexDir, {
        ...original,
        deleted_at: now,
        tombstone_reason: 'duplicate_detected_by_supersession',
      });
      // Data deletion — log at warn so it's visible alongside the L1-divergence
      // warning below. The daemon log is the only out-of-band signal for
      // tombstone events; info-level would be filtered out by warn+ consumers.
      console.warn(
        `[supersession] retro ${newEntryId} detected as duplicate; tombstoned`,
      );
    } else {
      // L2 tombstone is set above; L1 entry was not found (possible if the
      // L1 write is still in-flight or the page file is not yet flushed).
      // L2 and L1 are now inconsistent — log loudly so it appears in the
      // daemon log and can be investigated.
      console.warn(
        `[supersession] warn: retro ${newEntryId} detected as duplicate and tombstoned in L2,` +
        ` but could not find original entry in L1 (${cortexDir}); L1 not updated`,
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
