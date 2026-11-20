/**
 * Memory tombstones — `think forget` (AGT-2331).
 *
 * A memory tombstone is a sync line-kind (`kind: "tombstone"`) that tells every
 * peer to remove a memory: delete its L2 row (content, embedding, FTS entry,
 * compaction links) and never re-ingest it. It rides every sync surface:
 *
 *   - L1 (git pages, daemon pull-loop, `think reindex`) via `l1_outbox`
 *   - the git adapter's shared bucket files and the fs adapter's per-peer
 *     bucket files (same JSONL files memories live in)
 *   - the hub, through its own `/v1/cortex-sync/tombstones` stream
 *
 * Line shape (JSONL, one per forget):
 *
 *   {
 *     "kind": "tombstone",
 *     "id": "<primary target id>",
 *     "ids": ["<target id>", "<content-derived id>"],
 *     "ts": "<forget time>", "author": "<who>", "origin_peer_id": "<peer>",
 *     "content": "[forgotten]", "deleted_at": "<forget time>",
 *     "tombstone_reason": "forget",
 *     "source_ids": [], "topics": [], "supersedes": [], "compacted_from": null
 *   }
 *
 * The line never carries the forgotten content. `ids` lists every id the
 * memory can be keyed under on some peer: the writer's own id (what the
 * daemon pull-loop keys on) and `deterministicId(ts, author, content)` (what
 * the git/fs/hub adapters key pulled copies on).
 *
 * Compatibility with peers that predate this kind — the redundant fields are
 * deliberate:
 *
 *   - `content` is a fixed placeholder and `deleted_at` is set, so an older
 *     daemon pull-loop treats the line as a pre-existing soft-delete tombstone
 *     for `id` and hides the row from recall (it keeps the content locally
 *     until that peer upgrades and runs `think reindex`).
 *   - older git/fs adapters skip any line with `deleted_at`; older reindex and
 *     compaction backfill do the same. Nothing errors.
 *   - older hub clients never see tombstones: the hub serves them on a
 *     separate route they don't call.
 *
 * Trust: a tombstone is accepted from anyone who can write to the sync
 * surface. On git/fs that matches the existing soft-delete line, except that a
 * tombstone removes rows instead of hiding them. On the hub it is a real
 * widening: before 3.3.0 a bearer-token holder could only append; now any
 * token holder can erase lines from the hub and from every peer that syncs
 * through it, with no undo (SECURITY.md, "Known trade-offs").
 */

import type { DatabaseSync } from 'node:sqlite';
import { deterministicId } from './deterministic-id.js';
import { tryLoadSqliteVec } from './search-vectors.js';
import { TOMBSTONE_MAX_IDS } from '../sync/hub-protocol.js';

export const TOMBSTONE_KIND = 'tombstone' as const;
/** Fixed placeholder content: never the forgotten text. See module header. */
export const TOMBSTONE_PLACEHOLDER = '[forgotten]';
export const TOMBSTONE_REASON = 'forget';
/** Upper bound on target ids in one tombstone line (the wire contract's cap). */
export const MAX_TOMBSTONE_IDS = TOMBSTONE_MAX_IDS;

export interface MemoryTombstone {
  /** Every id the forgotten memory may be keyed under. Never empty. */
  ids: string[];
  /** ISO-8601 forget time. */
  ts: string;
  author: string;
  origin_peer_id: string | null;
}

/** The ids one memory row can be keyed under across peers. */
export function tombstoneIdsFor(row: { id: string; ts: string; author: string; content: string }): string[] {
  const contentId = deterministicId(row.ts, row.author, row.content);
  return contentId === row.id ? [row.id] : [row.id, contentId];
}

/** Serialize a tombstone as a JSONL line (no trailing newline). */
export function serializeTombstoneLine(t: MemoryTombstone): string {
  return JSON.stringify({
    kind: TOMBSTONE_KIND,
    id: t.ids[0],
    ids: t.ids,
    ts: t.ts,
    author: t.author,
    ...(t.origin_peer_id ? { origin_peer_id: t.origin_peer_id } : {}),
    content: TOMBSTONE_PLACEHOLDER,
    deleted_at: t.ts,
    tombstone_reason: TOMBSTONE_REASON,
    source_ids: [],
    topics: [],
    supersedes: [],
    compacted_from: null,
  });
}

/**
 * Parse an already-JSON-decoded line as a tombstone. Returns null for anything
 * that isn't a well-formed `kind: "tombstone"` line, so callers can fall
 * through to their normal memory handling.
 */
export function parseTombstone(obj: unknown): MemoryTombstone | null {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (o['kind'] !== TOMBSTONE_KIND) return null;

  const ids: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === 'string' && v.length > 0 && v.length <= 200 && !ids.includes(v)) ids.push(v);
  };
  if (Array.isArray(o['ids'])) for (const v of o['ids']) push(v);
  push(o['id']);
  if (ids.length === 0) return null;

  const ts =
    typeof o['ts'] === 'string' && o['ts'].length > 0
      ? o['ts']
      : typeof o['deleted_at'] === 'string' && o['deleted_at'].length > 0
        ? o['deleted_at']
        : new Date().toISOString();
  return {
    ids: ids.slice(0, MAX_TOMBSTONE_IDS),
    ts,
    author: typeof o['author'] === 'string' && o['author'].length > 0 ? o['author'] : 'unknown',
    origin_peer_id:
      typeof o['origin_peer_id'] === 'string' && o['origin_peer_id'].length > 0
        ? o['origin_peer_id']
        : null,
  };
}

/** Parse every tombstone line out of a JSONL blob. Malformed lines are skipped. */
export function parseTombstonesJsonl(raw: string): MemoryTombstone[] {
  const out: MemoryTombstone[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    // Cheap pre-filter: skip the JSON parse for ordinary memory lines.
    if (!trimmed || !trimmed.includes('"tombstone"')) continue;
    try {
      const t = parseTombstone(JSON.parse(trimmed));
      if (t) out.push(t);
    } catch {
      /* malformed line — skip, never crash */
    }
  }
  return out;
}

/** True when `id` has been forgotten on this peer. */
export function isForgotten(db: DatabaseSync, id: string): boolean {
  return db.prepare('SELECT 1 FROM memory_tombstones WHERE id = ? LIMIT 1').get(id) !== undefined;
}

/** All forgotten ids (used by reindex to filter a full L1 walk). */
export function forgottenIdSet(db: DatabaseSync): Set<string> {
  const rows = db.prepare('SELECT id FROM memory_tombstones').all() as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

export interface ApplyTombstoneResult {
  /** L2 memory rows removed by this tombstone. */
  removed: number;
  /** True when at least one target id was newly recorded as forgotten. */
  recorded: boolean;
}

/**
 * Apply a tombstone to a cortex DB: hard-delete every targeted memory row and
 * everything derived from it locally, then record the ids so no sync path
 * re-ingests them. Idempotent — re-applying the same tombstone is a no-op.
 *
 * Does NOT open a transaction; callers that need atomicity with other writes
 * (the forget handler's outbox enqueue) wrap it. Use
 * {@link applyMemoryTombstone} for a standalone, transactional apply.
 */
export function applyMemoryTombstoneNoTx(
  db: DatabaseSync,
  t: MemoryTombstone,
  opts: { local?: boolean } = {},
): ApplyTombstoneResult {
  const ids = [...new Set(t.ids)].slice(0, MAX_TOMBSTONE_IDS);
  if (ids.length === 0) return { removed: 0, recorded: false };
  const ph = ids.map(() => '?').join(', ');

  const rowids = (
    db.prepare(`SELECT rowid AS r FROM memories WHERE id IN (${ph})`).all(...ids) as { r: number }[]
  ).map((x) => x.r);

  // The FTS row goes with the memories row (memories_ad trigger); the
  // embedding is a column on the row itself.
  const del = db.prepare(`DELETE FROM memories WHERE id IN (${ph})`).run(...ids);
  db.prepare(
    `DELETE FROM compaction_links WHERE raw_id IN (${ph}) OR compacted_id IN (${ph})`,
  ).run(...ids, ...ids);
  // Pending (never drained) outbox lines for the forgotten entry: drop them so
  // a memory that never left this machine never will. Tombstone lines carry
  // kind "tombstone" and are kept.
  db.prepare(
    `DELETE FROM l1_outbox WHERE entry_id IN (${ph}) AND line NOT LIKE '%"kind":"tombstone"%'`,
  ).run(...ids);

  if (rowids.length > 0) deleteFromVecIndex(db, rowids);

  const seqRow = db
    .prepare('SELECT COALESCE(MAX(tombstone_seq), 0) AS s FROM memory_tombstones')
    .get() as { s: number };
  const insert = db.prepare(
    `INSERT OR IGNORE INTO memory_tombstones
       (id, tombstone_seq, forgotten_at, author, origin_peer_id, local)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  let recorded = false;
  for (const id of ids) {
    const r = insert.run(id, seqRow.s + 1, t.ts, t.author, t.origin_peer_id, opts.local ? 1 : 0);
    if (Number(r.changes) > 0) recorded = true;
  }
  return { removed: Number(del.changes), recorded };
}

/** Transactional {@link applyMemoryTombstoneNoTx}, with SQLite secure_delete on. */
export function applyMemoryTombstone(db: DatabaseSync, t: MemoryTombstone): ApplyTombstoneResult {
  return withSecureDelete(db, () => {
    db.exec('BEGIN');
    try {
      const r = applyMemoryTombstoneNoTx(db, t);
      db.exec('COMMIT');
      return r;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  });
}

/**
 * Run `fn` with `PRAGMA secure_delete = ON` so SQLite overwrites the freed
 * pages of deleted rows instead of leaving the bytes in the file's free list.
 * Restores the previous setting afterwards. Best effort: the WAL can still
 * hold old page images until the next checkpoint.
 */
export function withSecureDelete<T>(db: DatabaseSync, fn: () => T): T {
  const row = db.prepare('PRAGMA secure_delete').get() as Record<string, number>;
  const prev = Number(Object.values(row)[0]);
  db.exec('PRAGMA secure_delete = ON');
  try {
    return fn();
  } finally {
    if (prev !== 1) db.exec(`PRAGMA secure_delete = ${prev === 2 ? 'FAST' : 'OFF'}`);
  }
}

/**
 * The opt-in sqlite-vec backend keeps its own copy of each embedding in the
 * `memories_vec` virtual table, keyed by memories.rowid. Remove the forgotten
 * rows' vectors when that table exists. Best effort: if the extension can't be
 * loaded the table is unusable anyway, and `think reindex` rebuilds it.
 */
function deleteFromVecIndex(db: DatabaseSync, rowids: number[]): void {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE name = 'memories_vec' LIMIT 1")
    .get();
  if (!exists) return;
  try {
    if (!tryLoadSqliteVec(db)) return;
    const ph = rowids.map(() => '?').join(', ');
    db.prepare(`DELETE FROM memories_vec WHERE rowid IN (${ph})`).run(...rowids);
  } catch {
    /* best effort — see JSDoc */
  }
}

export interface LocalTombstoneBatch {
  tombstones: MemoryTombstone[];
  /** Highest tombstone_seq in this batch; the push cursor after sending it. */
  maxSeq: number;
}

/**
 * Tombstones created on this machine by `think forget` (local = 1) after
 * `sinceSeq`, grouped back into one tombstone per forget, oldest first, at
 * most `limit` of them. A pulled tombstone is never returned, so it is never
 * re-emitted to another sync surface. `maxSeq` is `sinceSeq` when there is
 * nothing to send.
 */
export function getLocalTombstonesSince(
  db: DatabaseSync,
  sinceSeq: number,
  limit = Number.MAX_SAFE_INTEGER,
): LocalTombstoneBatch {
  const rows = db
    .prepare(
      `SELECT id, tombstone_seq, forgotten_at, author, origin_peer_id
         FROM memory_tombstones
        WHERE tombstone_seq > ? AND local = 1
        ORDER BY tombstone_seq ASC, rowid ASC`,
    )
    .all(sinceSeq) as {
      id: string;
      tombstone_seq: number;
      forgotten_at: string;
      author: string | null;
      origin_peer_id: string | null;
    }[];
  let maxSeq = sinceSeq;
  const groups = new Map<number, MemoryTombstone>();
  for (const r of rows) {
    const g = groups.get(r.tombstone_seq);
    if (g) {
      g.ids.push(r.id);
      continue;
    }
    if (groups.size >= limit) break;
    groups.set(r.tombstone_seq, {
      ids: [r.id],
      ts: r.forgotten_at,
      author: r.author ?? 'unknown',
      origin_peer_id: r.origin_peer_id,
    });
    maxSeq = r.tombstone_seq;
  }
  return { tombstones: [...groups.values()], maxSeq };
}
