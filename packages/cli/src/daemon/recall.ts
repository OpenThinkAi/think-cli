/**
 * Daemon `recall` endpoint — AGT-285
 *
 * Embed query → brute-force or sqlite-vec cosine search → return ranked entries.
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
 */

import type { DatabaseSync } from 'node:sqlite';
import embed from '../lib/embed.js';
import { getCortexDb } from '../db/engrams.js';
import { searchVectors } from '../lib/search-vectors.js';

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
  similarity: number;
  cortex: string;
}

interface HydratedRow {
  id: string;
  ts: string;
  content: string;
  kind: string | null;
  topics: string | null;
}

// ---------------------------------------------------------------------------
// Schema column cache (per DB instance — avoids PRAGMA on every recall call)
// ---------------------------------------------------------------------------

interface ColumnInfo {
  hasKind: boolean;
  hasTopics: boolean;
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
  const info: ColumnInfo = { hasKind: cols.has('kind'), hasTopics: cols.has('topics') };
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
 * @returns       Array of {@link RecallEntry} sorted by cosine similarity desc.
 */
export async function handleRecall(
  params: Record<string, unknown>,
): Promise<RecallEntry[]> {
  // ── validate params ────────────────────────────────────────────────────────

  const cortexName = params['cortex'];
  if (typeof cortexName !== 'string' || cortexName.trim().length === 0) {
    throw new Error('recall: missing or empty required param "cortex"');
  }

  const query = params['query'];
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new Error('recall: missing or empty required param "query"');
  }

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

  const { hasKind, hasTopics } = getColumnInfo(db);

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

  // ── vector search ──────────────────────────────────────────────────────────
  // searchVectors delegates to the configured engine (brute-force or sqlite-vec)
  // and returns up to `limit` results sorted by cosine similarity desc.

  const vectorResults = searchVectors(cortexName, queryVec, limit);
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

    return {
      id: row.id,
      ts: row.ts,
      kind: row.kind ?? null,
      content: row.content,
      topics: topicsValue,
      similarity,
      cortex: cortexName,
    };
  });

  // Sort descending by similarity and return.
  entries.sort((a, b) => b.similarity - a.similarity);
  return entries.slice(0, limit);
}
