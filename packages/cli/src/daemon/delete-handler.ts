/**
 * Daemon `delete` endpoint — issue #84.
 *
 * Soft-deletes entries in the ACTIVE cortex — the same store `recall` reads —
 * and appends a tombstone line per deleted entry to L1 (via `l1_outbox`, same
 * plumbing as the supersession worker) so the deletion:
 *
 *   - propagates to every peer of a shared cortex (their pull loop applies the
 *     tombstone to the already-ingested row — see pull-loop `ingestEntry`), and
 *   - survives a local `think reindex` (the tombstone line replays over the
 *     original line; reindex is last-wins via INSERT OR REPLACE).
 *
 * The pre-#84 `think delete` targeted an `entries` table in the legacy local
 * `think.db` — a table that does not exist in cortex index DBs — so deletion of
 * any synced entry silently no-oped while `--match` reported success.
 *
 * Params:
 *   cortex  string  (required) — target cortex (validated via sanitizeName)
 *   id      string  — delete the live entry with this exact id
 *   match   string  — delete live entries whose content contains this substring
 *   last    boolean — delete the most recently written live entry
 *   force   boolean — required when `match` hits more than MAX_UNFORCED_MATCH
 *                     entries (guard against a broad pattern tombstoning a
 *                     shared cortex)
 *
 * Exactly one of id / match / last must be provided.
 *
 * Returns: { deleted: number, entries: [{ id, content }] } — deleted may be 0;
 * the CLI is responsible for NOT presenting a zero-delete as success.
 */

import fs from 'node:fs';
import { getCortexDb } from '../db/engrams.js';
import { enqueueL1Outbox } from '../lib/l1-page.js';
import { getIndexDbPath, sanitizeName } from '../lib/paths.js';
import { pushDebouncer } from './push-debouncer.js';

/** Above this many `--match` hits, deletion requires `force: true`. */
export const MAX_UNFORCED_MATCH = 20;

export interface DeleteResult {
  deleted: number;
  entries: { id: string; content: string }[];
}

interface TargetRow {
  id: string;
  ts: string;
  author: string;
  content: string;
  origin_peer_id: string | null;
  kind: string | null;
  topics_json: string | null;
  source_ids: string | null;
}

const TARGET_COLUMNS =
  'id, ts, author, content, origin_peer_id, kind, topics_json, source_ids';

function parseJsonArray(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Build the L1 tombstone line for a deleted entry. Same shape the supersession
 * worker appends for duplicate retros: the original entry's fields with
 * `deleted_at` set, re-using the original id so peers and reindex apply it to
 * the existing record.
 */
function buildTombstoneLine(row: TargetRow, deletedAt: string): string {
  return JSON.stringify({
    id: row.id,
    ts: row.ts,
    author: row.author,
    origin_peer_id: row.origin_peer_id,
    kind: row.kind ?? 'memory',
    content: row.content,
    topics: parseJsonArray(row.topics_json),
    supersedes: [],
    compacted_from: null,
    source_ids: parseJsonArray(row.source_ids),
    deleted_at: deletedAt,
    tombstone_reason: 'user_delete',
  });
}

export function handleDelete(params: Record<string, unknown>): DeleteResult {
  const cortexRaw = params['cortex'];
  if (typeof cortexRaw !== 'string' || cortexRaw.length === 0) {
    throw new Error("invalid field 'cortex': must be a non-empty string");
  }
  const safeCortex = sanitizeName(cortexRaw);
  if (!fs.existsSync(getIndexDbPath(safeCortex))) {
    throw new Error(`cortex '${safeCortex}' not found`);
  }

  const id = typeof params['id'] === 'string' && params['id'].length > 0 ? params['id'] : undefined;
  const match = typeof params['match'] === 'string' && params['match'].length > 0 ? params['match'] : undefined;
  const last = params['last'] === true;
  const force = params['force'] === true;

  const selectors = [id !== undefined, match !== undefined, last].filter(Boolean).length;
  if (selectors !== 1) {
    throw new Error("delete: provide exactly one of 'id', 'match', or 'last'");
  }

  const db = getCortexDb(safeCortex);

  let targets: TargetRow[];
  if (id) {
    targets = db.prepare(
      `SELECT ${TARGET_COLUMNS} FROM memories WHERE id = ? AND deleted_at IS NULL`,
    ).all(id) as unknown as TargetRow[];
  } else if (match) {
    targets = db.prepare(
      `SELECT ${TARGET_COLUMNS} FROM memories WHERE content LIKE ? AND deleted_at IS NULL`,
    ).all(`%${match}%`) as unknown as TargetRow[];
  } else {
    targets = db.prepare(
      `SELECT ${TARGET_COLUMNS} FROM memories WHERE deleted_at IS NULL
       ORDER BY ts DESC LIMIT 1`,
    ).all() as unknown as TargetRow[];
  }

  if (targets.length === 0) {
    return { deleted: 0, entries: [] };
  }

  if (match && targets.length > MAX_UNFORCED_MATCH && !force) {
    throw new Error(
      `delete: pattern matches ${targets.length} entries (more than ${MAX_UNFORCED_MATCH}); ` +
        `re-run with --force to delete them all`,
    );
  }

  // L2 tombstone + L1 outbox line land atomically per entry, all in one
  // transaction: either the whole delete is durable or none of it is.
  const deletedAt = new Date().toISOString();
  const updateStmt = db.prepare(
    `UPDATE memories SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`,
  );

  db.exec('BEGIN');
  try {
    for (const row of targets) {
      updateStmt.run(deletedAt, row.id);
      enqueueL1Outbox(db, row.id, buildTombstoneLine(row, deletedAt), deletedAt);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // Schedule the L1 append + push (same debounced drain the sync path uses).
  pushDebouncer.notify(safeCortex);

  return {
    deleted: targets.length,
    entries: targets.map((t) => ({ id: t.id, content: t.content })),
  };
}
