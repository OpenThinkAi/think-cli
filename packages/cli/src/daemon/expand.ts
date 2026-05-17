/**
 * Daemon `expand` endpoint — AGT-288
 *
 * Returns a bundle containing the primary entry plus its raw/compaction
 * relationships, allowing agents to drill into the provenance behind a
 * compacted memory or see the compactions that fold a given raw entry.
 *
 * Params:
 *   cortex    string  (required) — target cortex name (sanitized via getCortexDb)
 *   entry_id  string  (required) — id of the entry to expand
 *
 * Response:
 *   {
 *     primary:     <full ExpandEntry>,
 *     raws:        <ExpandEntry[]>,   // entries in primary.compacted_from (if compacted)
 *                                      // OR entries whose compacted_from references primary (if raw, via compaction_links)
 *     compactions: <ExpandEntry[]>,   // entries whose compacted_from references primary (reverse lookup)
 *   }
 *
 * Rules:
 *   - kind === "memory" and compacted_from is non-null → primary is a compaction.
 *     raws = entries listed in compacted_from. compactions = [].
 *   - kind === "memory" and compacted_from is null → primary is raw.
 *     raws = []. compactions = compacted entries that reference primary (via getCompactionsForRaw).
 *   - kind !== "memory" (retro, event, or absent/null defaulting to "memory") →
 *     raws = [], compactions = [].
 *   - Entry not found → throw with code "not_found".
 *   - Soft-deleted entries (deleted_at IS NOT NULL) are included in all three fields;
 *     callers should check ExpandEntry.deleted_at if they only want live entries.
 *
 * Security: cortexName passes through getCortexDb → sanitizeName; path traversal rejected.
 */

import type { DatabaseSync } from 'node:sqlite';
import { getCortexDb } from '../db/engrams.js';
import { getCompactionsForRaw } from '../db/compaction-links-queries.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Full representation of one entry as returned by the expand endpoint. */
export interface ExpandEntry {
  id: string;
  ts: string;
  author: string;
  content: string;
  /** null when kind column is absent (pre-v3 DB) — treat as "memory" for logic */
  kind: string | null;
  /** Parsed compacted_from array; null when the entry is raw (compacted_from IS NULL) */
  compacted_from: string[] | null;
  /** Parsed topics array; empty array when column is absent */
  topics: string[];
  /** Parsed supersedes array; empty array when column is absent */
  supersedes: string[];
  deleted_at: string | null;
  cortex: string;
}

interface RawMemoryRow {
  id: string;
  ts: string;
  author: string;
  content: string;
  kind: string | null;
  compacted_from_json: string | null;
  /** JSON-encoded string array; null when the column is absent (pre-v3 DB). */
  topics_json: string | null;
  /** JSON-encoded string array; null when the column is absent (pre-v3 DB). */
  supersedes_json: string | null;
  deleted_at: string | null;
}

export interface ExpandResult {
  primary: ExpandEntry;
  raws: ExpandEntry[];
  compactions: ExpandEntry[];
}

// ---------------------------------------------------------------------------
// Schema column cache (per DB instance)
// ---------------------------------------------------------------------------

interface ColFlags {
  hasKind: boolean;
  hasCompactedFrom: boolean;
  hasTopics: boolean;
  hasSupersedes: boolean;
}

const colFlagsCache = new WeakMap<DatabaseSync, ColFlags>();

function getColFlags(db: DatabaseSync): ColFlags {
  const cached = colFlagsCache.get(db);
  if (cached !== undefined) return cached;

  const cols = new Set(
    (db.prepare('PRAGMA table_info(memories)').all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  const flags: ColFlags = {
    hasKind: cols.has('kind'),
    hasCompactedFrom: cols.has('compacted_from'),
    hasTopics: cols.has('topics'),
    hasSupersedes: cols.has('supersedes'),
  };
  colFlagsCache.set(db, flags);
  return flags;
}

// ---------------------------------------------------------------------------
// Row hydration helper
// ---------------------------------------------------------------------------

function buildSelectCols(flags: ColFlags): string {
  return [
    'id',
    'ts',
    'author',
    'content',
    flags.hasKind ? 'kind' : 'NULL AS kind',
    flags.hasCompactedFrom ? 'compacted_from AS compacted_from_json' : 'NULL AS compacted_from_json',
    flags.hasTopics ? 'topics AS topics_json' : "'[]' AS topics_json",
    flags.hasSupersedes ? 'supersedes AS supersedes_json' : "'[]' AS supersedes_json",
    'deleted_at',
  ].join(', ');
}

/**
 * Parse a JSON-encoded string array from a DB column, returning an empty array
 * on null, empty, or unparseable input.  Used for `topics` and `supersedes`.
 */
function parseJsonStringArray(raw: string | null): string[] {
  try {
    const parsed = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function hydrateRow(row: RawMemoryRow, cortexName: string): ExpandEntry {
  let compacted_from: string[] | null = null;
  if (row.compacted_from_json !== null) {
    try {
      const parsed = JSON.parse(row.compacted_from_json);
      compacted_from = Array.isArray(parsed)
        ? parsed.filter((v): v is string => typeof v === 'string')
        : null;
    } catch {
      compacted_from = null;
    }
  }

  const topics = parseJsonStringArray(row.topics_json);
  const supersedes = parseJsonStringArray(row.supersedes_json);

  return {
    id: row.id,
    ts: row.ts,
    author: row.author,
    content: row.content,
    kind: row.kind,
    compacted_from,
    topics,
    supersedes,
    deleted_at: row.deleted_at,
    cortex: cortexName,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Implements the `expand` daemon method.
 *
 * @param params  Validated incoming params from the protocol dispatcher.
 * @returns       {@link ExpandResult} with primary + raws + compactions arrays.
 */
export function handleExpand(
  params: Record<string, unknown>,
): ExpandResult {
  // ── validate params ────────────────────────────────────────────────────────

  const cortexRaw = params['cortex'];
  if (typeof cortexRaw !== 'string' || cortexRaw.trim().length === 0) {
    throw new Error('expand: missing or empty required param "cortex"');
  }
  const cortexName = cortexRaw.trim();

  const entryIdRaw = params['entry_id'];
  if (typeof entryIdRaw !== 'string' || entryIdRaw.trim().length === 0) {
    throw new Error('expand: missing or empty required param "entry_id"');
  }
  const entryId = entryIdRaw.trim();

  // ── open cortex DB ─────────────────────────────────────────────────────────
  // getCortexDb calls getIndexDbPath → sanitizeName; path traversal is rejected.

  const db = getCortexDb(cortexName);

  // ── detect schema columns ─────────────────────────────────────────────────

  const flags = getColFlags(db);
  const selectCols = buildSelectCols(flags);

  // ── fetch primary entry ───────────────────────────────────────────────────

  let primaryRow: RawMemoryRow | undefined;
  try {
    primaryRow = db
      .prepare(`SELECT ${selectCols} FROM memories WHERE id = ?`)
      .get(entryId) as RawMemoryRow | undefined;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`expand: DB query failed for cortex "${cortexName}": ${msg}`);
  }

  if (!primaryRow) {
    const e = new Error(`expand: entry "${entryId}" not found in cortex "${cortexName}"`);
    (e as NodeJS.ErrnoException).code = 'not_found';
    throw e;
  }

  const primary = hydrateRow(primaryRow, cortexName);

  // ── determine effective kind ──────────────────────────────────────────────
  // Absent kind column (pre-v3 DB) → treat as "memory" for expansion logic.

  const effectiveKind = primary.kind ?? 'memory';

  // ── short-circuit for non-memory kinds ───────────────────────────────────

  if (effectiveKind !== 'memory') {
    return { primary, raws: [], compactions: [] };
  }

  // ── memory kind: build raws + compactions ─────────────────────────────────

  const isCompacted = primary.compacted_from !== null && primary.compacted_from.length > 0;

  if (isCompacted) {
    // Primary is a compacted entry. Fetch the raw entries it was compacted from.
    const rawIds = primary.compacted_from ?? [];
    const raws = fetchEntriesByIds(db, rawIds, selectCols, cortexName);
    return { primary, raws, compactions: [] };
  } else {
    // Primary is a raw entry. Find compacted entries that fold it.
    const compactedIds = getCompactionsForRaw(cortexName, entryId);
    const compactions = fetchEntriesByIds(db, compactedIds, selectCols, cortexName);
    return { primary, raws: [], compactions };
  }
}

// ---------------------------------------------------------------------------
// Batch fetch helper
// ---------------------------------------------------------------------------

/**
 * Maximum number of ids to spread into a single SQLite IN (?, …) query.
 * SQLite's default SQLITE_MAX_VARIABLE_NUMBER is 999 on pre-3.32 builds
 * (32 766 on newer builds, but not guaranteed).  Guard at 900 to leave
 * headroom for the SELECT column list's own positional markers.
 */
const MAX_IN_PARAMS = 900;

/**
 * Fetch multiple entries by their ids in a single query.
 * Returns entries in the same order as `ids`. Missing entries are silently
 * omitted (they may have been tombstoned or are from a different cortex shard).
 * Soft-deleted entries (deleted_at IS NOT NULL) are intentionally included —
 * expand is a provenance endpoint and callers may need to trace tombstoned raws.
 */
function fetchEntriesByIds(
  db: DatabaseSync,
  ids: string[],
  selectCols: string,
  cortexName: string,
): ExpandEntry[] {
  if (ids.length === 0) return [];

  if (ids.length > MAX_IN_PARAMS) {
    throw new Error(
      `expand: cannot fetch ${ids.length} entries in a single query ` +
      `(limit ${MAX_IN_PARAMS}). Compaction batches larger than this are not supported.`,
    );
  }

  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT ${selectCols} FROM memories WHERE id IN (${placeholders})`)
    .all(...ids) as RawMemoryRow[];

  // Preserve the requested id order, silently dropping any that weren't found.
  const rowMap = new Map<string, RawMemoryRow>(rows.map((r) => [r.id, r]));
  return ids
    .map((id) => rowMap.get(id))
    .filter((r): r is RawMemoryRow => r !== undefined)
    .map((r) => hydrateRow(r, cortexName));
}
