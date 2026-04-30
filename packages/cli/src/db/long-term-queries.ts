import { getCortexDb } from './engrams.js';
import { deterministicEventId } from '../lib/deterministic-id.js';

export type LongTermEventKind =
  | 'adoption'
  | 'migration'
  | 'pivot'
  | 'decision'
  | 'milestone'
  | 'incident';

export interface LongTermEventRow {
  id: string;
  ts: string;
  author: string;
  kind: string;
  title: string;
  content: string;
  topics: string;             // JSON array string
  supersedes: string | null;
  source_memory_ids: string;  // JSON array string
  created_at: string;
  deleted_at: string | null;
  sync_version: number;
}

export interface InsertLongTermEventParams {
  id?: string;
  ts: string;
  author: string;
  kind: string;
  title: string;
  content: string;
  topics?: string[];
  supersedes?: string | null;
  source_memory_ids?: string[];
  deleted_at?: string | null;
}

export interface InsertLongTermEventResult {
  row: LongTermEventRow;
  /** true if this call actually inserted a new row; false if a row with this
   *  (deterministic) id already existed and the insert was skipped. The row
   *  returned in that case is the pre-existing one, which may have differed
   *  on fields the caller passed in (e.g. supersedes). Callers that need to
   *  act on the distinction — like backfill, which feeds inserted events
   *  forward as supersession context — should branch on this flag. */
  inserted: boolean;
}

export function insertLongTermEvent(
  cortexName: string,
  params: InsertLongTermEventParams,
): InsertLongTermEventResult {
  const db = getCortexDb(cortexName);
  // Deterministic by default so locally-inserted events have the same id as
  // they will after round-tripping through git sync. Supersession links work
  // across machines only if ids are stable across them.
  const id = params.id ?? deterministicEventId(params.ts, params.author, params.title, params.content);
  const now = new Date().toISOString();
  const topics = JSON.stringify(params.topics ?? []);
  const sourceIds = JSON.stringify(params.source_memory_ids ?? []);

  // OR IGNORE so re-inserting a deterministic-id duplicate is a no-op.
  // `changes` tells us whether the insert actually added a row or was a
  // dedup no-op.
  const runResult = db.prepare(
    `INSERT OR IGNORE INTO long_term_events
       (id, ts, author, kind, title, content, topics, supersedes, source_memory_ids, created_at, deleted_at, sync_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sync_version), 0) + 1 FROM long_term_events))`,
  ).run(
    id,
    params.ts,
    params.author,
    params.kind,
    params.title,
    params.content,
    topics,
    params.supersedes ?? null,
    sourceIds,
    now,
    params.deleted_at ?? null,
  );

  const row = db.prepare('SELECT * FROM long_term_events WHERE id = ?').get(id) as unknown as LongTermEventRow;
  return { row, inserted: Number(runResult.changes) > 0 };
}

export function insertLongTermEventIfNotExists(
  cortexName: string,
  params: InsertLongTermEventParams & { id: string },
): boolean {
  const db = getCortexDb(cortexName);
  const existing = db.prepare('SELECT id FROM long_term_events WHERE id = ?').get(params.id);
  if (existing) return false;

  return insertLongTermEvent(cortexName, params).inserted;
}

export function getLongTermEvents(
  cortexName: string,
  params: { since?: string; until?: string; limit?: number } = {},
): LongTermEventRow[] {
  const db = getCortexDb(cortexName);
  const conditions = ['deleted_at IS NULL'];
  const values: (string | number)[] = [];

  if (params.since) {
    conditions.push('ts >= ?');
    values.push(params.since);
  }
  if (params.until) {
    conditions.push('ts <= ?');
    values.push(params.until);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  if (params.limit) {
    values.push(params.limit);
    return db.prepare(
      `SELECT * FROM long_term_events ${where} ORDER BY ts ASC LIMIT ?`,
    ).all(...values) as unknown as LongTermEventRow[];
  }
  return db.prepare(
    `SELECT * FROM long_term_events ${where} ORDER BY ts ASC`,
  ).all(...values) as unknown as LongTermEventRow[];
}

export function getLongTermEventsBySyncVersion(
  cortexName: string,
  sinceVersion: number,
): LongTermEventRow[] {
  const db = getCortexDb(cortexName);
  return db.prepare(
    'SELECT * FROM long_term_events WHERE sync_version > ? ORDER BY sync_version ASC',
  ).all(sinceVersion) as unknown as LongTermEventRow[];
}

/**
 * Fetch recent events optionally filtered to those sharing any of the given
 * topics. Used by the curator to see what might be superseded and what
 * topics to reuse.
 */
export function getRecentLongTermEventsForContext(
  cortexName: string,
  opts: { topics?: string[]; limit?: number } = {},
): LongTermEventRow[] {
  const db = getCortexDb(cortexName);
  const limit = opts.limit ?? 30;

  if (opts.topics && opts.topics.length > 0) {
    // Match any event whose topics JSON array contains at least one of the
    // requested topics. SQLite JSON1 makes this tractable; fall back to a
    // LIKE scan if JSON1 isn't available.
    try {
      const placeholders = opts.topics.map(() => '?').join(', ');
      return db.prepare(
        `SELECT DISTINCT lte.*
         FROM long_term_events lte, json_each(lte.topics)
         WHERE lte.deleted_at IS NULL
           AND json_each.value IN (${placeholders})
         ORDER BY lte.ts DESC
         LIMIT ?`,
      ).all(...opts.topics, limit) as unknown as LongTermEventRow[];
    } catch {
      // JSON1 missing — fall through to plain recent-events lookup.
    }
  }

  return db.prepare(
    `SELECT * FROM long_term_events
     WHERE deleted_at IS NULL
     ORDER BY ts DESC
     LIMIT ?`,
  ).all(limit) as unknown as LongTermEventRow[];
}

/**
 * Wrap a user query as an FTS5 phrase so special tokens (AND, OR, NOT, ", *, etc.)
 * don't break parsing. FTS5 escapes a literal double quote inside a phrase by
 * doubling it. This gives substring-y phrase semantics, which is what a naive
 * user expects from `recall "some text"`.
 */
function sanitizeFtsQuery(q: string): string {
  return `"${q.replace(/"/g, '""')}"`;
}

export function searchLongTermEvents(
  cortexName: string,
  query: string,
  limit: number = 20,
): LongTermEventRow[] {
  const db = getCortexDb(cortexName);
  const ftsQuery = sanitizeFtsQuery(query);
  try {
    return db.prepare(
      `SELECT lte.* FROM long_term_events lte
       JOIN long_term_events_fts f ON lte.rowid = f.rowid
       WHERE long_term_events_fts MATCH ? AND lte.deleted_at IS NULL
       ORDER BY rank LIMIT ?`,
    ).all(ftsQuery, limit) as unknown as LongTermEventRow[];
  } catch {
    // FTS itself failed (rare with sanitized phrase syntax, but empty-string
    // or adversarial input can still trip it). Fall back to LIKE.
    const pattern = `%${query.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
    return db.prepare(
      `SELECT * FROM long_term_events
       WHERE (content LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')
         AND deleted_at IS NULL
       ORDER BY ts DESC LIMIT ?`,
    ).all(pattern, pattern, limit) as unknown as LongTermEventRow[];
  }
}

export function getLongTermEventById(
  cortexName: string,
  id: string,
): LongTermEventRow | null {
  const db = getCortexDb(cortexName);
  const row = db.prepare('SELECT * FROM long_term_events WHERE id = ?').get(id) as unknown as LongTermEventRow | undefined;
  return row ?? null;
}

export function tombstoneLongTermEvent(cortexName: string, id: string): void {
  const db = getCortexDb(cortexName);
  db.prepare(
    `UPDATE long_term_events
       SET deleted_at = ?, sync_version = (SELECT COALESCE(MAX(sync_version), 0) + 1 FROM long_term_events)
     WHERE id = ? AND deleted_at IS NULL`,
  ).run(new Date().toISOString(), id);
}

export function getLongTermEventCount(cortexName: string): number {
  const db = getCortexDb(cortexName);
  const row = db.prepare(
    'SELECT COUNT(*) as count FROM long_term_events WHERE deleted_at IS NULL',
  ).get() as { count: number };
  return row.count;
}
