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
import { listLocalBranches } from '../lib/git.js';
import { reindexingCortexes } from './embed-model-check.js';

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
 * "active"     — query only the caller's active cortex. Uses the `cortex`
 *                param if provided; falls back to `config.cortex.active`.
 *                Throws if neither is set.
 *
 * "accessible" — (default) fan out to all accessible cortexes enumerated by
 *                `listLocalBranches()` (local git refs, no network). If a `cortex`
 *                param is also provided
 *                alongside this scope, the federation fan-out is **skipped**
 *                and only that one cortex is queried — the `scope` param is
 *                effectively treated as "active". Use `scope="active"` for
 *                clarity when querying a single named cortex.
 *
 * "all"        — ALPHA: reserved for future remote-peer federation. Currently
 *                behaves **identically to "accessible"** (local cortexes only).
 *                When remote federation ships, "all" will **automatically**
 *                include remote peers that are not locally cloned — callers
 *                using "all" today will gain remote results without re-opting-in.
 *                Use "accessible" if you want to pin to local-only behavior.
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
  /**
   * Name of the cortex that produced this entry — always present, never
   * empty. Set unconditionally in `recallOneCortexWithVec` for both the
   * single-cortex and federated paths (AGT-307).
   *
   * Invariant: every element of the `recall` RPC response array has a
   * non-empty `cortex` string. This must be preserved by all future
   * recall code paths (including JSON output — AGT-319 — and the MCP
   * tool response — AGT-315).
   */
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
// Shared param parsing (avoids duplication between single-cortex and federated paths)
// ---------------------------------------------------------------------------

/**
 * Parsed and validated recall params (excluding cortex/scope, which are
 * resolved by the top-level dispatcher before reaching the inner functions).
 */
interface ParsedRecallParams {
  query: string;
  limit: number;
  kind: string | undefined;
  topic: string | undefined;
  since: string | undefined;
  decay: number;
}

/**
 * Validate and extract the common recall params from the raw params map.
 * Throws on any validation error.
 */
function parseRecallParams(params: Record<string, unknown>): ParsedRecallParams {
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

  return { query, limit, kind, topic, since, decay };
}

// ---------------------------------------------------------------------------
// Scope validation (module-scope constant, not per-call allocation)
// ---------------------------------------------------------------------------

const VALID_SCOPES: ReadonlySet<string> = new Set(['active', 'accessible', 'all']);

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
  const scopeRaw = params['scope'];
  if (scopeRaw !== undefined && (typeof scopeRaw !== 'string' || !VALID_SCOPES.has(scopeRaw))) {
    throw new Error(
      `recall: 'scope' must be one of "active", "accessible", or "all", got ${JSON.stringify(scopeRaw)}`,
    );
  }
  // Track whether scope was explicitly provided by the caller vs. defaulted.
  // Used below to avoid noisy warnings for legacy callers that pass `cortex`
  // without knowing about the new `scope` parameter.
  const scopeExplicit = scopeRaw !== undefined;
  const scope: RecallScope = (scopeRaw as RecallScope | undefined) ?? 'accessible';

  // ── route by scope + cortex ────────────────────────────────────────────────
  const cortexNameRaw = params['cortex'];
  // cortex is optional when scope is "accessible" or "all" (fan-out to all
  // local cortexes). It is required (or config.cortex.active is used as
  // fallback) when scope="active". If cortex is provided with
  // scope="accessible"/"all", it short-circuits the fan-out: only that
  // cortex is queried. Use scope="active" for clarity in single-cortex usage.
  if (scope === 'active') {
    if (typeof cortexNameRaw !== 'string' || cortexNameRaw.trim().length === 0) {
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
    return recallSingleCortex(cortexNameRaw.trim(), params);
  }

  // scope is "accessible" or "all"
  if (typeof cortexNameRaw === 'string' && cortexNameRaw.trim().length > 0) {
    // Explicit cortex overrides federation — only that cortex is queried.
    // Warn only when the caller explicitly set scope (not when they omitted
    // it and got the "accessible" default), so legacy callers that pass
    // `cortex` without the new scope param are not noisy.
    if (scopeExplicit) {
      process.stderr.write(
        `think recall: scope="${scope}" with explicit cortex="${cortexNameRaw.trim()}" — federation overridden, querying only that cortex. Use scope="active" for clarity.\n`,
      );
    }
    return recallSingleCortex(cortexNameRaw.trim(), params);
  }

  // ── federated recall ───────────────────────────────────────────────────────
  // scope="all" is reserved for future remote-peer federation. For the alpha
  // release, "all" behaves identically to "accessible" (local cortexes only).
  // Emit a warning so callers can see the ALPHA/no-op status at runtime.
  // When remote federation ships, "all" will automatically include remote peers
  // not locally cloned — callers using "all" today will gain remote results
  // without re-opting-in. Use "accessible" to pin to local-only behavior.
  if (scope === 'all') {
    process.stderr.write(
      'think recall: scope="all" is ALPHA — currently behaves identically to "accessible" (local cortexes only). Remote-peer federation is not yet implemented.\n',
    );
  }
  return recallFederated(params);
}

// ---------------------------------------------------------------------------
// recallOneCortexWithVec — low-level per-cortex vector query
// ---------------------------------------------------------------------------

/**
 * Low-level single-cortex query given a pre-computed embedding vector.
 * Called by `recallSingleCortex` and `recallFederated` (one call per cortex
 * in the fan-out). Not called directly by `handleRecall`.
 *
 * `limit` is the *user-facing* limit — this function applies the
 * RECENCY_OVERFETCH_FACTOR internally when needed. Callers must NOT
 * pre-multiply `limit`; doing so would square the overfetch factor and
 * contradict the <100ms latency target.
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
  // Per-cortex reindex busy check (AGT-277).
  // If the daemon is currently reindexing this cortex due to an embedding model
  // version change, return a transient error rather than querying stale or
  // partially-rebuilt vectors. Other cortexes are unaffected — the busy set is
  // per-cortex; there is no global lock.
  if (reindexingCortexes.has(cortexName)) {
    throw new Error(
      `cortex "${cortexName}" is currently being reindexed due to an embedding model version change — retry in a moment`
    );
  }

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

  // For the sqlite-vec engine, ANN search has no per-row metadata hook inside
  // the KNN scan, so we over-fetch by RECENCY_OVERFETCH_FACTOR and rerank in JS.
  // For brute-force, searchVectors ignores the `limit` parameter entirely and
  // returns all live candidates (see searchBruteForce in lib/search-vectors.ts),
  // so the inflated fetchLimit is also safe there — brute-force ignores it anyway.
  // After reranking, results are sliced to `limit` by the caller.
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
 * Full pipeline for recalling from one named cortex: parses params, embeds
 * query, queries the cortex, reranks, truncates. Used when `cortex` is
 * explicitly provided or scope="active".
 */
async function recallSingleCortex(
  cortexName: string,
  params: Record<string, unknown>,
): Promise<RecallEntry[]> {
  const { query, limit, kind, topic, since, decay } = parseRecallParams(params);
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
 * Fan out the query to all accessible cortexes in parallel, merge
 * results, rerank globally, and truncate to `limit`.
 *
 * Cortex enumeration: `listLocalBranches()` reads `refs/heads/*` from the
 * local `~/.think/repo` clone via `git for-each-ref`. This is a fast,
 * local-only call that does NOT block on network I/O — safe to use inside
 * the async daemon handler. Only branches that have been fetched locally
 * appear in the list; a cortex that exists on the remote but has never been
 * fetched locally will not be queried. That is the intended semantics for
 * the "accessible" scope level.
 *
 * Per-cortex queries run concurrently via Promise.all. Each cortex's
 * recency normalization uses its own max_seq — cortex A's "most recent"
 * entry is not penalised because cortex B has a larger seq space.
 *
 * Per-cortex failures are caught individually. A missing or corrupt L2 DB
 * contributes zero results rather than aborting the whole federated query
 * (partial degradation > total failure). Failures are emitted to stderr
 * so they are visible in daemon logs.
 */
async function recallFederated(
  params: Record<string, unknown>,
): Promise<RecallEntry[]> {
  const { query, limit, kind, topic, since, decay } = parseRecallParams(params);

  // Embed once; the vector is shared across all cortex legs so the model is
  // only invoked once regardless of how many cortexes are queried.
  const queryVec = await embed(query);

  // Enumerate locally-known cortexes via local git refs (no network call).
  // listLocalBranches() uses `git for-each-ref refs/heads/` — sync but does
  // not block on I/O. Branch names map 1:1 to cortex names. Throws on git
  // failure (repo not initialised, git not found, etc.).
  let cortexNames: string[];
  try {
    cortexNames = listLocalBranches();
  } catch (err) {
    // Enumeration failure — fall back to the active cortex from config if set.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`think recall: cortex enumeration failed (${msg}); falling back to active cortex\n`);
    const activeCortex = getConfig().cortex?.active;
    cortexNames = activeCortex ? [activeCortex] : [];
  }

  if (cortexNames.length === 0) {
    // Throw rather than silently returning [] — an agent receiving an empty
    // result cannot distinguish "no matching entries" from "recall was unable
    // to query any cortex," and the latter is a misconfiguration that should
    // surface as an error, not silence.
    throw new Error(
      'recall: no cortexes available to query. The git repo may not be initialised and no active cortex is configured. ' +
      'Run "think cortex setup" or set cortex.active in config.',
    );
  }

  // Fan out to all cortexes in parallel. Per-cortex failures are caught
  // individually so one unavailable/corrupt cortex doesn't abort the query.
  //
  // Pass `limit` (not a pre-inflated value) to recallOneCortexWithVec — that
  // function owns the RECENCY_OVERFETCH_FACTOR calculation internally. Passing
  // an already-inflated value would apply the factor twice (limit × factor²),
  // contradicting the <100ms latency target.
  const perCortexResults = await Promise.all(
    cortexNames.map(async (name) => {
      try {
        return await recallOneCortexWithVec(
          name, queryVec, limit, kind, topic, since, decay,
        );
      } catch (err) {
        // Partial failure: cortex is unavailable or corrupt; contribute zero
        // results. Emit to stderr so the failure is visible in daemon logs.
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`think recall: cortex "${name}" failed — ${msg}\n`);
        return [] as RecallEntry[];
      }
    }),
  );

  // Pool all candidates, sort globally by recency-weighted score, truncate.
  const allEntries = perCortexResults.flat();
  allEntries.sort((a, b) => b.score - a.score);
  return allEntries.slice(0, limit);
}
