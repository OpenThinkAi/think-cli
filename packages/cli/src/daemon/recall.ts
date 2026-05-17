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
 * the descending idx_entries_activity_seq index on the memories table (AGT-270 /
 * migration 13 in engrams.ts). `decay` defaults to
 * 0.05, which gives ~50% weight at seq_distance=14 and ~25% at seq_distance=28,
 * so the most recent ~20 entries always dominate regardless of corpus age or
 * wall-clock spread. Tunable via config.recall.recencyDecay.
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
import { listRemoteBranches } from '../lib/git.js';

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

/**
 * Federation scope for the `recall` RPC (AGT-306).
 *
 * "active"     — query only the caller's active cortex (from config, or from
 *                the `cortex` param if provided).
 * "accessible" — (default) query all locally-cloned cortexes, i.e. every git
 *                branch present under ~/.think/repo refs/heads/*. If `cortex`
 *                is also provided alongside this scope, it behaves as "active"
 *                on that cortex (explicit cortex overrides the fan-out).
 * "all"        — ALPHA: reserved for future remote-peer federation. For the
 *                alpha release, "all" is identical to "accessible". When remote
 *                federation ships, "all" will additionally query remote peers
 *                that are not cloned locally.
 */
export type RecallScope = 'active' | 'accessible' | 'all';

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
 * Implements the `recall` daemon method — AGT-285 / AGT-291 / AGT-306.
 *
 * When `scope` is "accessible" or "all" (the default), this function fans out
 * to all locally-cloned cortexes in parallel and merges the results.
 * When `scope` is "active" (or when a `cortex` param is provided alongside
 * scope="accessible"), it queries a single cortex.
 *
 * @param params  Validated incoming params from the protocol dispatcher.
 * @returns       Array of {@link RecallEntry} sorted by recency-weighted score desc.
 */
export async function handleRecall(
  params: Record<string, unknown>,
): Promise<RecallEntry[]> {
  // ── validate scope ─────────────────────────────────────────────────────────
  const VALID_SCOPES: ReadonlySet<string> = new Set(['active', 'accessible', 'all']);
  const scopeRaw = params['scope'];
  if (scopeRaw !== undefined && (typeof scopeRaw !== 'string' || !VALID_SCOPES.has(scopeRaw))) {
    throw new Error(
      `recall: 'scope' must be one of "active", "accessible", or "all", got ${JSON.stringify(scopeRaw)}`,
    );
  }
  const scope: RecallScope = (scopeRaw as RecallScope | undefined) ?? 'accessible';

  // ── validate params ────────────────────────────────────────────────────────

  const cortexNameRaw = params['cortex'];
  // cortex is optional when scope is "accessible" or "all" (fan-out to all
  // local cortexes). It remains required only when scope="active" (no
  // auto-discovery). If cortex is provided with scope="accessible"/"all",
  // it short-circuits the fan-out (treat as scope="active" on that cortex).
  if (scope === 'active') {
    if (typeof cortexNameRaw !== 'string' || (cortexNameRaw as string).trim().length === 0) {
      // Fall back to the active cortex from config when cortex param is absent.
      const cfg = getConfig();
      const activeCortex = cfg.cortex?.active;
      if (!activeCortex || activeCortex.trim().length === 0) {
        throw new Error(
          'recall: scope="active" requires either a "cortex" param or a configured active cortex (cortex.active in config)',
        );
      }
      return recallSingleCortex(activeCortex.trim(), params);
    }
    return recallSingleCortex((cortexNameRaw as string).trim(), params);
  }

  // scope is "accessible" or "all"
  if (typeof cortexNameRaw === 'string' && (cortexNameRaw as string).trim().length > 0) {
    // Explicit cortex overrides federation — query only that cortex.
    return recallSingleCortex((cortexNameRaw as string).trim(), params);
  }

  // ── federated recall ───────────────────────────────────────────────────────
  // "all" is reserved for future remote-peer federation. For the alpha release,
  // "all" behaves identically to "accessible" (local cortexes only).
  return recallFederated(params);
}

// ---------------------------------------------------------------------------
// recallSingleCortex — inner implementation for one cortex
// ---------------------------------------------------------------------------

/**
 * Query a single cortex by name. All filtering, embedding, and recency
 * ranking is performed here. Called by `handleRecall` for single-cortex
 * paths; also called per-cortex by `recallFederated`.
 *
 * The embed step is NOT performed here — the caller must provide the
 * pre-computed query vector. This avoids re-embedding on every fan-out leg.
 *
 * @internal
 */
async function recallOneCortexWithVec(
  cortexName: string,
  queryVec: Float32Array,
  limit: number,
  kind: string | undefined,
  topic: string | undefined,
  since: string | undefined,
  decay: number,
): Promise<RecallEntry[]> {
  // getCortexDb calls getIndexDbPath → sanitizeName, which rejects `/`, `\`, and
  // `..` sequences. Path-traversal attempts are caught here with a clear error.
  const db = getCortexDb(cortexName);
  const { hasKind, hasTopics, hasActivitySeq } = getColumnInfo(db);

  // Fail fast if the caller requested a filter against a column that doesn't exist.
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

  // ── max_seq — each cortex uses its own max for recency normalization ────────
  // This preserves per-corpus recency semantics: a cortex with 10 entries
  // and one with 10K entries each have their own "recent" anchor. Flattening
  // to a global max_seq would distort recency for smaller or older cortexes.
  let maxSeq: number | null = null;
  if (hasActivitySeq) {
    const seqRow = db.prepare(
      'SELECT MAX(activity_seq) AS max_seq FROM memories WHERE deleted_at IS NULL',
    ).get() as { max_seq: number | null };
    maxSeq = seqRow.max_seq;
  }

  const fetchLimit = (hasActivitySeq && maxSeq !== null)
    ? limit * RECENCY_OVERFETCH_FACTOR
    : limit;

  const vectorResults = searchVectors(cortexName, queryVec, fetchLimit);
  if (vectorResults.length === 0) {
    return [];
  }

  const vectorIds = vectorResults.map((r) => r.id);
  const placeholders = vectorIds.map(() => '?').join(', ');

  const conditions: string[] = ['deleted_at IS NULL', `id IN (${placeholders})`];
  const binds: (string | number)[] = [...vectorIds];

  if (since) {
    conditions.push('ts >= ?');
    binds.push(since);
  }
  if (kind) {
    conditions.push('kind = ?');
    binds.push(kind);
  }
  if (topic) {
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

  const simMap = new Map<string, number>(
    vectorResults.map((r) => [r.id, r.similarity]),
  );

  return rows.map((row) => {
    let topicsValue: string[] = [];
    try {
      topicsValue = JSON.parse(row.topics ?? '[]') as string[];
    } catch {
      topicsValue = [];
    }

    const similarity = simMap.get(row.id)!;

    // Recency weight: exp(-decay × (max_seq - entry_seq)) ∈ (0, 1].
    // Falls back to score=cosine when activity_seq is unavailable.
    //
    // TODO(#55): For negative cosine similarities, multiplying by a weight in
    // (0,1] moves the score toward zero, so old-but-negative entries are promoted
    // relative to newer-but-negative ones. In practice this is low-impact since
    // vector search rarely surfaces negative cosines, but the formula is not
    // monotonic for the negative range. See GitHub issue #55 for fix direction.
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
}

// ---------------------------------------------------------------------------
// recallSingleCortex — full-pipeline single-cortex entry point
// ---------------------------------------------------------------------------

/**
 * Full pipeline for recalling from one named cortex: validates params, embeds
 * query, queries the cortex, reranks, truncates. Used when `cortex` is
 * explicitly provided or scope="active".
 */
async function recallSingleCortex(
  cortexName: string,
  params: Record<string, unknown>,
): Promise<RecallEntry[]> {
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

  const cfg = getConfig();
  const decay = cfg.recall?.recencyDecay ?? DEFAULT_DECAY;

  const queryVec = await embed(query);

  const entries = await recallOneCortexWithVec(
    cortexName, queryVec, limit, kind, topic, since, decay,
  );

  entries.sort((a, b) => b.score - a.score);
  return entries.slice(0, limit);
}

// ---------------------------------------------------------------------------
// recallFederated — fan-out across all accessible cortexes
// ---------------------------------------------------------------------------

/**
 * Fan out the query to all locally-cloned cortexes in parallel, merge
 * results, rerank globally, and truncate to `limit`.
 *
 * Per-cortex queries run concurrently via Promise.all. Each cortex's
 * recency normalization uses its own max_seq — cortex A's "most recent"
 * entry is not penalised because cortex B has a larger seq space.
 *
 * If a cortex fails (e.g. its L2 is missing or corrupt), the error is
 * swallowed and that cortex contributes zero results rather than poisoning
 * the whole response. The design intent: partial degradation is better than
 * a total failure when one of N cortexes has an issue.
 *
 * Latency target (AGT-306): 5 cortexes × 10K entries each in <100ms warm.
 * The dominant cost is embed() (one call, shared across all cortex legs),
 * not the per-cortex SQLite queries.
 */
async function recallFederated(
  params: Record<string, unknown>,
): Promise<RecallEntry[]> {
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

  const cfg = getConfig();
  const decay = cfg.recall?.recencyDecay ?? DEFAULT_DECAY;

  // Embed once, shared across all cortex legs.
  const queryVec = await embed(query);

  // Enumerate all locally-cloned cortexes from git branches.
  // listRemoteBranches() reads refs/heads/* from ~/.think/repo via ls-remote.
  // An empty list (no branches, no remote) produces an empty result set.
  let cortexNames: string[];
  try {
    cortexNames = listRemoteBranches();
  } catch {
    // If enumeration fails (e.g. repo not yet initialised), fall back to
    // the active cortex from config if available, otherwise return empty.
    const activeCortex = cfg.cortex?.active;
    cortexNames = activeCortex ? [activeCortex] : [];
  }

  if (cortexNames.length === 0) {
    return [];
  }

  // Fan out to all cortexes in parallel. Per-cortex failures are caught
  // individually so one bad cortex doesn't abort the entire federated query.
  // Over-fetch per cortex so that reranking has enough candidates globally.
  const perCortexLimit = limit * RECENCY_OVERFETCH_FACTOR;

  const perCortexResults = await Promise.all(
    cortexNames.map(async (name) => {
      try {
        return await recallOneCortexWithVec(
          name, queryVec, perCortexLimit, kind, topic, since, decay,
        );
      } catch {
        // Partial failure: cortex N is unavailable; contribute zero results.
        return [] as RecallEntry[];
      }
    }),
  );

  // Pool all candidates, sort globally by recency-weighted score, truncate.
  const allEntries: RecallEntry[] = ([] as RecallEntry[]).concat(...perCortexResults);
  allEntries.sort((a, b) => b.score - a.score);
  return allEntries.slice(0, limit);
}
