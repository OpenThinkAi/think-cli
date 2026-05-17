/**
 * Daemon `recall` endpoint — AGT-285 / AGT-291
 *
 * Embed query → brute-force or sqlite-vec cosine search → recency-weighted
 * rerank → return ranked entries.
 *
 * Params:
 *   cortex  string   (required) — target cortex name (validated via sanitizeName)
 *   query   string   (required) — semantic search query
 *   limit   number   (optional, default 20, max 500) — must be a positive integer
 *   kind    string   (optional) — filter by kind (error if column absent)
 *   topic   string   (optional) — filter entries whose topics array contains this value
 *   since   string   (optional) — ISO-8601 lower bound on ts (format check, inclusive)
 *
 * Returns: RecallEntry[]
 *
 * Security: `cortexName` is passed through `getCortexDb` which calls `sanitizeName`,
 * which enforces alphanumeric + hyphens/underscores only and rejects `/`, `\`, and `..`.
 * Any path-traversal attempt surfaces as an Error before the DB is opened.
 *
 * Filter contract: If a requested filter cannot be applied (kind column absent,
 * JSON1 unavailable for topic), the handler throws rather than silently returning
 * unfiltered results. Callers that request a filter are asserting intent; silent
 * pass-through is worse than an explicit error.
 *
 * Recency weighting (AGT-291):
 *   score = cosine × exp(-decay × (max_seq - entry_seq))
 *
 * `max_seq` is MAX(activity_seq) for the cortex — a single cheap query served by
 * the descending idx_entries_activity_seq index (AGT-270). `decay` defaults to
 * 0.05, which gives ~50% weight at seq_distance=14 and ~25% at seq_distance=28,
 * so the most recent ~20 entries always dominate regardless of corpus age or
 * wall-clock spread. Tunable via config.recall.recency_decay.
 *
 * For the sqlite-vec engine, ANN search returns candidates sorted by vector
 * distance only — there is no per-row metadata hook inside the KNN scan. We
 * compensate by over-fetching (RECENCY_OVERFETCH_FACTOR × limit) and reranking
 * in JS. This is the only pluggable-engine-safe path; the overfetch is bounded
 * and cheap because sqlite-vec KNN is sub-10ms even at 3–5× the final limit.
 */

import type { DatabaseSync } from 'node:sqlite';
import embed from '../lib/embed.js';
import { getCortexDb } from '../db/engrams.js';
import { searchVectors } from '../lib/search-vectors.js';
import { getConfig } from '../lib/config.js';

// How many extra candidates to fetch from sqlite-vec before JS rerank.
// 5× ensures the reranked window is wide enough that a very recent entry
// with moderate cosine can displace old-but-high-cosine entries.
const RECENCY_OVERFETCH_FACTOR = 5;

// Default decay constant. At 0.05:
//   seq_distance=0  → weight=1.00
//   seq_distance=14 → weight≈0.50
//   seq_distance=28 → weight≈0.25
const DEFAULT_DECAY = 0.05;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecallEntry {
  id: string;
  ts: string;
  /** Null for memory rows that pre-date kind tagging. */
  kind: string | null;
  content: string;
  /** Parsed topics array; empty array if column absent or value unparseable. */
  topics: string[];
  /** Raw cosine similarity in [−1, 1] before recency weighting. */
  similarity: number;
  /**
   * Final ranking score: cosine × exp(-decay × (max_seq - entry_seq)).
   * Equals `similarity` when activity_seq is unavailable (pre-AGT-291 rows).
   */
  score: number;
  cortex: string;
}

interface HydratedRow {
  id: string;
  ts: string;
  content: string;
  kind: string | null;
  topics: string | null;
  /** Null for rows that pre-date the AGT-291 activity_seq backfill. */
  activity_seq: number | null;
}

// ---------------------------------------------------------------------------
// Schema column cache (per DB instance — avoids PRAGMA on every recall call)
// ---------------------------------------------------------------------------

interface ColumnInfo {
  hasKind: boolean;
  hasTopics: boolean;
  hasActivitySeq: boolean;
}

const columnInfoCache = new WeakMap<DatabaseSync, ColumnInfo>();

function getColumnInfo(db: DatabaseSync): ColumnInfo {
  const cached = columnInfoCache.get(db);
  if (cached !== undefined) return cached;

  const cols = new Set(
    (db.prepare('PRAGMA table_info(memories)').all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  const info: ColumnInfo = {
    hasKind: cols.has('kind'),
    hasTopics: cols.has('topics'),
    hasActivitySeq: cols.has('activity_seq'),
  };
  columnInfoCache.set(db, info);
  return info;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const MAX_LIMIT = 500;

// Basic ISO-8601 format check (not a calendar-validity check).
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

function isValidIso8601(s: string): boolean {
  return ISO_8601_RE.test(s);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Implements the `recall` daemon method.
 *
 * @param params  Validated incoming params from the protocol dispatcher.
 * @returns       Array of {@link RecallEntry} sorted by recency-weighted score desc.
 */
export async function handleRecall(
  params: Record<string, unknown>,
): Promise<RecallEntry[]> {
  // ── validate params ────────────────────────────────────────────────────────

  const cortexNameRaw = params['cortex'];
  if (typeof cortexNameRaw !== 'string' || cortexNameRaw.trim().length === 0) {
    throw new Error('recall: missing or empty required param "cortex"');
  }
  const cortexName = cortexNameRaw.trim();

  const queryRaw = params['query'];
  if (typeof queryRaw !== 'string' || queryRaw.trim().length === 0) {
    throw new Error('recall: missing or empty required param "query"');
  }
  const query = queryRaw.trim();

  const limitRaw = params['limit'];
  if (limitRaw !== undefined) {
    if (
      typeof limitRaw !== 'number' ||
      !Number.isFinite(limitRaw) ||
      limitRaw <= 0 ||
      !Number.isInteger(limitRaw)
    ) {
      throw new Error(
        `recall: 'limit' must be a positive integer, got ${JSON.stringify(limitRaw)}`,
      );
    }
    if (limitRaw > MAX_LIMIT) {
      throw new Error(
        `recall: 'limit' must not exceed ${MAX_LIMIT}, got ${limitRaw}`,
      );
    }
  }
  const limit = (limitRaw as number | undefined) ?? 20;

  const kind = typeof params['kind'] === 'string' ? params['kind'] : undefined;
  const topic = typeof params['topic'] === 'string' ? params['topic'] : undefined;

  const sinceRaw = params['since'];
  if (sinceRaw !== undefined) {
    if (typeof sinceRaw !== 'string' || !isValidIso8601(sinceRaw)) {
      throw new Error(
        `recall: 'since' must be an ISO-8601 date string (format check only), got ${JSON.stringify(sinceRaw)}`,
      );
    }
  }
  const since = typeof sinceRaw === 'string' ? sinceRaw : undefined;

  // ── open cortex DB ─────────────────────────────────────────────────────────
  // getCortexDb calls getIndexDbPath → sanitizeName, which rejects `/`, `\`, and
  // `..` sequences. Path-traversal attempts are caught here with a clear error.

  const db = getCortexDb(cortexName);

  // ── discover optional columns (cached per DB instance) ─────────────────────

  const { hasKind, hasTopics, hasActivitySeq } = getColumnInfo(db);

  // Fail fast if the caller requested a filter against a column that doesn't
  // exist yet. Silent pass-through is worse than an explicit error.
  if (kind !== undefined && !hasKind) {
    throw new Error(
      `recall: 'kind' filter requested but the memories table in cortex "${cortexName}" does not have a 'kind' column`,
    );
  }
  if (topic !== undefined && !hasTopics) {
    throw new Error(
      `recall: 'topic' filter requested but the memories table in cortex "${cortexName}" does not have a 'topics' column`,
    );
  }

  // ── embed query ────────────────────────────────────────────────────────────

  const queryVec = await embed(query);

  // ── recency decay config ───────────────────────────────────────────────────
  // score = cosine × exp(-decay × (max_seq - entry_seq))
  // Default 0.05 → ~50% weight at seq_distance=14, ~25% at seq_distance=28.
  const decay = getConfig().recall?.recency_decay ?? DEFAULT_DECAY;

  // ── max_seq (one query, served by descending idx_entries_activity_seq) ─────
  // Used as the "current" anchor for recency distance. When the column is absent
  // (pre-migration DBs) or no rows have been backfilled, falls back to null and
  // recency weighting is skipped (score = cosine, matching the pre-AGT-291 behavior).
  let maxSeq: number | null = null;
  if (hasActivitySeq) {
    const seqRow = db.prepare(
      'SELECT MAX(activity_seq) AS max_seq FROM memories WHERE deleted_at IS NULL',
    ).get() as { max_seq: number | null };
    maxSeq = seqRow.max_seq;
  }

  // ── vector search ──────────────────────────────────────────────────────────
  // For the sqlite-vec engine, ANN search has no per-row metadata hook inside
  // the KNN scan, so we over-fetch by RECENCY_OVERFETCH_FACTOR and rerank in JS.
  // The brute-force engine already returns all candidates; we still pass the
  // larger fetch window so the hydration query brings back enough rows for rerank.
  // After reranking, results are sliced to `limit`.
  const engine = getConfig().search?.engine ?? 'brute-force';
  const fetchLimit = (hasActivitySeq && maxSeq !== null && engine === 'sqlite-vec')
    ? limit * RECENCY_OVERFETCH_FACTOR
    : limit;

  const vectorResults = searchVectors(cortexName, queryVec, fetchLimit);
  if (vectorResults.length === 0) {
    return [];
  }

  // ── build single batched hydration query ───────────────────────────────────

  const vectorIds = vectorResults.map((r) => r.id);
  const placeholders = vectorIds.map(() => '?').join(', ');

  const conditions: string[] = ['deleted_at IS NULL', `id IN (${placeholders})`];
  const binds: (string | number)[] = [...vectorIds];

  if (since) {
    conditions.push('ts >= ?');
    binds.push(since);
  }

  if (kind) {
    // hasKind is guaranteed true above.
    conditions.push('kind = ?');
    binds.push(kind);
  }

  if (topic) {
    // hasTopics is guaranteed true above.
    // JSON1 is required; if the extension is absent we throw so the caller
    // knows the filter was not applied rather than silently getting wrong results.
    conditions.push(
      `EXISTS (SELECT 1 FROM json_each(topics) jt WHERE jt.value = ?)`,
    );
    binds.push(topic);
  }

  const selectCols = [
    'id',
    'ts',
    'content',
    hasKind ? 'kind' : 'NULL as kind',
    hasTopics ? 'topics' : "'[]' as topics",
    hasActivitySeq ? 'activity_seq' : 'NULL as activity_seq',
  ].join(', ');

  let rows: HydratedRow[];
  try {
    rows = db.prepare(
      `SELECT ${selectCols} FROM memories WHERE ${conditions.join(' AND ')}`,
    ).all(...binds) as unknown as HydratedRow[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`recall: DB query failed for cortex "${cortexName}": ${msg}`);
  }

  // ── build result set ───────────────────────────────────────────────────────

  const simMap = new Map<string, number>(
    vectorResults.map((r) => [r.id, r.similarity]),
  );

  const entries: RecallEntry[] = rows.map((row) => {
    let topicsValue: string[] = [];
    try {
      topicsValue = JSON.parse(row.topics ?? '[]') as string[];
    } catch {
      topicsValue = [];
    }

    // `simMap` contains every id in `vectorIds`; each `row.id` was fetched via
    // `WHERE id IN (vectorIds)`, so the map lookup is always present.
    const similarity = simMap.get(row.id)!;

    // Recency weight: exp(-decay × (max_seq - entry_seq)).
    // Falls back to weight=1 when activity_seq is unavailable — preserves
    // pre-AGT-291 ranking for DBs that haven't been reindexed yet.
    let score: number;
    if (maxSeq !== null && row.activity_seq !== null) {
      const seqDistance = maxSeq - row.activity_seq;
      const weight = Math.exp(-decay * seqDistance);
      score = similarity * weight;
    } else {
      score = similarity;
    }

    return {
      id: row.id,
      ts: row.ts,
      kind: row.kind ?? null,
      content: row.content,
      topics: topicsValue,
      similarity,
      score,
      cortex: cortexName,
    };
  });

  // Sort descending by recency-weighted score, then slice to `limit`.
  // The over-fetched window (for sqlite-vec) may contain more than `limit` rows
  // after hydration; slicing after sort ensures the caller gets exactly `limit`.
  entries.sort((a, b) => b.score - a.score);
  return entries.slice(0, limit);
}
