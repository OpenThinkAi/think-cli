/**
 * Daemon `recall` endpoint — AGT-285 / AGT-291 / AGT-320 / AGT-324
 *
 * Embed query → brute-force or sqlite-vec cosine search → recency-weighted
 * rerank → return ranked entries.
 *
 * Params:
 *   cortex   string   (required) — target cortex name (validated via sanitizeName)
 *   query    string   (required) — semantic search query
 *   limit    number   (optional, default 20, max 500) — must be a positive integer
 *   kind     string   (optional) — filter by kind
 *   topic    string   (optional) — exact-match (lowercase) on topics array
 *   since    string   (optional) — ISO-8601 lower bound on ts (format check, inclusive)
 *   no_embed boolean  (optional) — skip embedding model entirely; fall back to FTS ranking
 *
 * Returns: RecallEntry[]
 *
 * Security: `cortexName` is passed through `getCortexDb` which calls `sanitizeName`,
 * which enforces alphanumeric + hyphens/underscores only and rejects `/`, `\`, and `..`.
 * Any path-traversal attempt surfaces as an Error before the DB is opened.
 *
 * Filter contract: when a requested filter cannot be applied (e.g. topic, which
 * is not yet wired through), the handler throws rather than silently returning
 * unfiltered results. Callers that request a filter are asserting intent.
 *
 * Relevance floor (AGT-456, design doc §5 M2):
 *   Candidates whose RAW cosine similarity is below config.recall.relevanceFloor
 *   (default 0.6) are excluded BEFORE recency reweighting, so a sparse cortex
 *   returns zero entries instead of a top-K of garbage-tier matches. The floor
 *   does NOT apply to the FTS-fallback path (no cosine to compare). Set the
 *   config value ≤ -1 to disable.
 *
 * Quality-aware ranking (AGT-459, design doc §5 M4):
 *   After recency weighting, an additive curator-quality term is folded into the
 *   score: +config.recall.qualityBoost for a promoted retro (retros.promoted=1),
 *   −config.recall.qualityPenalty for a relegated retro (promoted=0 with prior
 *   recall history). Candidates with no matching retros row (memories, un-curated
 *   cortexes) get no term, so ranking degrades gracefully to cosine × recency.
 *   Set either knob to 0 to disable that term.
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
 *
 * FTS fallback (AGT-324):
 *   When `no_embed` is true or when the embedding model fails to load (network
 *   error, timeout, missing optional dep), recall falls back to FTS5 keyword
 *   ranking via `searchMemories`. The `fts_fallback` field on each result entry
 *   is true in this mode so callers can detect degraded operation. The note
 *   string NOTE_FTS_FALLBACK is exported for callers to surface to the user.
 */

import type { DatabaseSync } from 'node:sqlite';
import embed from '../lib/embed.js';
import { getCortexDb } from '../db/engrams.js';
import { searchVectors } from '../lib/search-vectors.js';
import { searchMemories } from '../db/memory-queries.js';
import { getConfig } from '../lib/config.js';
import type { TrustTierRule, TrustTier } from '../lib/config.js';
import { listLocalBranches } from '../lib/git.js';
import { reindexingCortexes, reindexFailedCortexes } from './embed-model-check.js';
import { sanitizeName } from '../lib/paths.js';
import { recordRetroSurfacings } from '../db/usage-db.js';
import { bumpRecallStats } from '../db/retro-queries.js';

/**
 * User-facing note printed when recall falls back to FTS ranking due to
 * an automatic embedding model failure (network, timeout, missing dep).
 * Lowercase `note:` prefix follows product prose conventions.
 */
export const NOTE_FTS_FALLBACK =
  'note: semantic recall unavailable, using FTS ranking (rerun with model cached for semantic ranking)';

/**
 * User-facing note printed when recall uses FTS ranking due to an explicit
 * --no-embed / THINK_NO_EMBED=1 opt-out (not a failure).
 */
export const NOTE_FTS_EXPLICIT =
  'note: using FTS keyword search (--no-embed)';

/**
 * Returns true when an embed() error indicates the model is unavailable
 * (network failure, download timeout, or missing optional dep) rather than
 * a programming error. Both cases trigger FTS fallback; this helper is
 * used to decide the log message.
 */
function isEmbedModelUnavailable(msg: string): boolean {
  return (
    msg.includes('failed to load embedding model') ||
    msg.includes('@huggingface/transformers') ||
    msg.includes('timed out')
  );
}

// How many extra candidates to fetch from sqlite-vec before JS rerank.
// 5× ensures the reranked window is wide enough that a very recent entry
// with moderate cosine can displace old-but-high-cosine entries.
const RECENCY_OVERFETCH_FACTOR = 5;

// Default decay constant. At 0.05:
//   seq_distance=0  → weight=1.00
//   seq_distance=14 → weight≈0.50
//   seq_distance=28 → weight≈0.25
const DEFAULT_DECAY = 0.05;

// Default absolute cosine-similarity floor (AGT-456 / design doc §5 M2).
// Candidates whose raw cosine is below this are excluded BEFORE recency
// reweighting, so sparse cortexes stop surfacing garbage-tier "best of a bad
// top-K" matches. Reuses the compaction-triage 0.6 as a starting point;
// config-tunable via config.recall.relevanceFloor. Set ≤ -1 to disable.
const DEFAULT_RELEVANCE_FLOOR = 0.6;

// Quality-aware ranking terms (AGT-459 / design doc §5 M4).
// Additive to the cosine × recency score: a promoted retro gets a small boost,
// a relegated retro a small penalty. Kept small relative to the cosine spread
// so curated quality breaks ties and lifts good lessons WITHOUT a weak-but-
// promoted match drowning a strong exact match (design doc §8 open question).
// Config-tunable via config.recall.qualityBoost / .qualityPenalty (set 0 to
// disable). Candidates with no matching retros row (memories, un-curated
// cortexes) get neither term, so ranking degrades gracefully to the prior
// cosine × recency behaviour.
const DEFAULT_QUALITY_BOOST = 0.1;
const DEFAULT_QUALITY_PENALTY = 0.1;

// Context-aware ranking term (iterative-learning v3 — retro locality).
// When recall is given a `context` (the repo the caller is working in), retros
// tagged `repo:<context>` get an additive boost so lessons for the current
// codebase surface first — WITHOUT hard-filtering out cross-context lessons
// (design doc §3.3: brief scopes, recall boosts). Additive and applied after
// recency weighting, like the M4 quality term; a row without the matching
// `repo:` topic gets no term, so ranking degrades gracefully to cosine ×
// recency (+ quality). Config-tunable via config.recall.contextBoost (0 to
// disable). Kept on the same small scale as the quality boost.
const DEFAULT_CONTEXT_BOOST = 0.1;

// ---------------------------------------------------------------------------
// Provenance — AGT-465
// ---------------------------------------------------------------------------

/**
 * Pattern for subscribe episode keys: subscribe:<connector>.
 * The connector part is `[A-Za-z0-9_-]+`, set by commands/subscribe.ts
 * (episodeKey: `subscribe:${s.kind}`), and is the local subscribe code's
 * value — the proxy does not control this key.
 */
const SUBSCRIBE_KEY_RE = /^subscribe:([A-Za-z0-9_-]+)$/;

/**
 * Derive the provenance tag for a recall entry (AGT-465).
 *
 * Priority:
 *  1. proxy:<connector> — episode_key matches ^subscribe:([A-Za-z0-9_-]+)$
 *     (wins over peer: when both apply — subscribe origin is the highest-fidelity signal)
 *  2. self — entry.cortex === activeCortex
 *  3. peer:<cortex> — entry.cortex !== activeCortex
 *  4. unknown — activeCortex is blank/undefined (can't distinguish self from peer)
 *
 * Returns a string matching ^(self|unknown|peer:[A-Za-z0-9_-]+|proxy:[A-Za-z0-9_-]+)$.
 */
export function deriveProvenance(
  entryCortex: string,
  episodeKey: string | null | undefined,
  activeCortex: string | undefined,
): string {
  // proxy: wins when episode_key matches the subscribe pattern.
  if (episodeKey) {
    const m = SUBSCRIBE_KEY_RE.exec(episodeKey);
    if (m) return `proxy:${m[1]}`;
  }

  // unknown: can't distinguish self from peer when activeCortex is unset.
  if (!activeCortex || activeCortex.trim().length === 0) return 'unknown';

  // self vs peer based on cortex name equality.
  return entryCortex === activeCortex ? 'self' : `peer:${entryCortex}`;
}

/**
 * Returns true when `provenance` satisfies a single source selector string.
 *
 * Exact-string match EXCEPT:
 *   - "peer"  matches every `peer:*` value
 *   - "proxy" matches every `proxy:*` value
 *   - "self" and "unknown" match only themselves
 */
export function provenanceMatches(provenance: string, selector: string): boolean {
  if (selector === 'peer') return provenance.startsWith('peer:');
  if (selector === 'proxy') return provenance.startsWith('proxy:');
  return provenance === selector;
}

/**
 * Apply sources / excludeSources filters to an array of entries.
 *
 * - `sources`:        when provided, keep only entries whose provenance matches
 *                     at least one selector in the list.
 * - `excludeSources`: when provided, drop entries whose provenance matches
 *                     any selector in the list.
 * - Excludes win over includes when both name the same entry.
 *
 * Must be called AFTER rerank + limit slice per the pre-rerank-filter retro:
 * applying filters before rerank silently breaks orthogonal-axis vector-path
 * fixtures (cosine≈0 entries disappear without failing tests).
 */
export function applyProvenanceFilters(
  entries: RecallEntry[],
  sources: string[] | undefined,
  excludeSources: string[] | undefined,
): RecallEntry[] {
  if ((!sources || sources.length === 0) && (!excludeSources || excludeSources.length === 0)) {
    return entries;
  }

  return entries.filter((e) => {
    const prov = e.provenance;

    // Excludes win unconditionally.
    if (excludeSources && excludeSources.length > 0) {
      if (excludeSources.some((sel) => provenanceMatches(prov, sel))) return false;
    }

    // If sources filter is active, entry must match at least one.
    if (sources && sources.length > 0) {
      return sources.some((sel) => provenanceMatches(prov, sel));
    }

    return true;
  });
}

/**
 * Validate a single provenance selector for --source / --exclude-source.
 *
 * Valid selectors (case-sensitive):
 *   - "self"            — exact match for self entries
 *   - "unknown"         — exact match for unknown entries
 *   - "peer"            — matches all peer:* entries
 *   - "proxy"           — matches all proxy:* entries
 *   - "peer:<name>"     — exact match for a specific peer cortex
 *   - "proxy:<connector>" — exact match for a specific proxy connector
 *
 * Throws with a lowercase `error:` prefix on invalid input.
 * Exported so the CLI layer can validate eagerly before the daemon RPC.
 */
export function validateSourceSelector(selector: string): void {
  const VALID_SOURCE_RE = /^(self|unknown|peer|proxy|peer:[A-Za-z0-9_-]+|proxy:[A-Za-z0-9_-]+)$/;
  if (!VALID_SOURCE_RE.test(selector)) {
    throw new Error(
      `error: unknown provenance selector "${selector}". Valid selectors: self, unknown, peer, peer:<name>, proxy, proxy:<connector>`,
    );
  }
}

// ---------------------------------------------------------------------------
// Trust tiers — AGT-466
// ---------------------------------------------------------------------------

/**
 * Validate a single provenance selector for the trust-tier rule `match` field.
 *
 * Extends `validateSourceSelector` to also accept `*` as a wildcard selector
 * (which matches every provenance). The wildcard is intentionally not accepted
 * by `validateSourceSelector` for `--source` / `--exclude-source` flags (where
 * `*` is nonsensical — "include all sources" is just the default). But in a
 * `trustTiers.rules[].match` field it is the explicit fail-safe override.
 *
 * Valid selectors (case-sensitive):
 *   - `"*"`                    — wildcard; matches every provenance
 *   - `"self"`                 — exact match for self entries
 *   - `"unknown"`              — exact match for unknown entries
 *   - `"peer"`                 — matches all peer:* entries
 *   - `"proxy"`                — matches all proxy:* entries
 *   - `"peer:<name>"`          — exact match for a specific peer cortex
 *   - `"proxy:<connector>"`    — exact match for a specific proxy connector
 *
 * Throws with a lowercase `error:` prefix on invalid input.
 * Exported so the CLI layer can validate trust tier selectors eagerly.
 */
export function validateTrustTierSelector(selector: string): void {
  if (selector === '*') return; // wildcard accepted in trust-tier context
  // Delegate to the existing --source validator for all other shapes.
  try {
    validateSourceSelector(selector);
  } catch {
    throw new Error(
      `error: unknown trust tier selector "${selector}". Valid selectors: *, self, unknown, peer, peer:<name>, proxy, proxy:<connector>`,
    );
  }
}

/**
 * Shipped default trust tier rules (AGT-466).
 *
 * Applied when `cortex.trustTiers` is absent OR `cortex.trustTiers.rules` is
 * empty. The implicit `* → untrusted` rule is always appended in
 * `deriveTrustTier` after all explicit rules; these defaults give `self →
 * trusted` so the user's own entries are never labelled untrusted by default.
 */
const DEFAULT_TRUST_TIER_RULES: readonly TrustTierRule[] = [
  { match: 'self', tier: 'trusted' },
];

/**
 * Classify a recall entry into one of three trust tiers (AGT-466).
 *
 * Resolution: walk the configured rules in priority order; the first rule
 * whose `match` selector satisfies `provenanceMatchesTrustSelector(provenance,
 * match)` wins. If no rule matches, the implicit final rule `* → untrusted`
 * applies (fail-safe default per AC #2).
 *
 * When `rules` is undefined or empty the shipped defaults (`self → trusted`)
 * are used before the implicit wildcard, so existing users see:
 *   - `self`    → `trusted`
 *   - everything else → `untrusted`
 *
 * @param provenance  The entry's derived provenance string (AGT-465 shape).
 * @param rules       The `cortex.trustTiers.rules` array from config, if set.
 * @returns           `'trusted'`, `'untrusted'`, or `'quarantined'`.
 */
export function deriveTrustTier(
  provenance: string,
  rules: TrustTierRule[] | undefined,
): TrustTier {
  const effective = (rules && rules.length > 0) ? rules : DEFAULT_TRUST_TIER_RULES;

  for (const rule of effective) {
    if (rule.match === '*') return rule.tier;
    if (provenanceMatches(provenance, rule.match)) return rule.tier;
  }

  // Implicit final rule: * → untrusted (fail-safe default).
  return 'untrusted';
}

/**
 * Apply trust tier filters to an array of entries (AGT-466).
 *
 * Order of operations (per approved plan):
 *   1. Quarantine drop (runs ALWAYS unless `includeQuarantined`): silently
 *      removes entries whose `trustTier === 'quarantined'` and returns the
 *      count of dropped entries via the `quarantinedDropped` field.
 *   2. Tier filter (runs ONLY when `tiers` or `excludeTiers` is non-empty):
 *      `tiers` keeps only entries in the listed tiers; `excludeTiers` drops
 *      entries in the listed tiers; excludes win over includes.
 *
 * MUST be called AFTER rerank + limit slice, same as `applyProvenanceFilters`.
 * Applying it pre-rerank silently breaks orthogonal-axis vector-path tests
 * (per the AGT-466 spike retro on this codebase).
 *
 * @returns `{ entries, quarantinedDropped }` — the filtered entries plus the
 *          number of quarantined entries that were silently removed.
 */
export function applyTrustTierFilters(
  entries: RecallEntry[],
  opts: {
    tiers: string[] | undefined;
    excludeTiers: string[] | undefined;
    includeQuarantined: boolean;
  },
): { entries: RecallEntry[]; quarantinedDropped: number } {
  const { tiers, excludeTiers, includeQuarantined } = opts;

  // Step 1 — quarantine drop.
  let quarantinedDropped = 0;
  let working = entries;
  if (!includeQuarantined) {
    const before = working.length;
    working = working.filter((e) => e.trustTier !== 'quarantined');
    quarantinedDropped = before - working.length;
  }

  // Step 2 — tier filter (only when flags are active).
  const hasTierFilter = (tiers && tiers.length > 0) || (excludeTiers && excludeTiers.length > 0);
  if (!hasTierFilter) {
    return { entries: working, quarantinedDropped };
  }

  working = working.filter((e) => {
    const tier = e.trustTier;

    // Excludes win unconditionally.
    if (excludeTiers && excludeTiers.length > 0) {
      if (excludeTiers.includes(tier)) return false;
    }

    // If inclusion filter is active, entry must match at least one listed tier.
    if (tiers && tiers.length > 0) {
      return tiers.includes(tier);
    }

    return true;
  });

  return { entries: working, quarantinedDropped };
}

/**
 * Valid tier values for `--trust-tier` / `--exclude-trust-tier`.
 */
export const VALID_TRUST_TIERS: ReadonlySet<string> = new Set(['trusted', 'untrusted', 'quarantined']);

/**
 * Emit a single stderr line when quarantined entries were silently dropped
 * from a recall or curate call. Count-only — never emits entry content.
 * Suppressed when count is 0.
 *
 * Canonical wording per SECURITY.md and the approved AGT-466 plan:
 *   "note: dropped N quarantined entr(y|ies); pass --include-quarantined to surface"
 */
export function emitQuarantineDropNotice(count: number): void {
  if (count > 0) {
    process.stderr.write(
      `note: dropped ${count} quarantined entr${count === 1 ? 'y' : 'ies'}; pass --include-quarantined to surface\n`,
    );
  }
}

/**
 * Validate a single trust tier value. Throws with a lowercase `error:` prefix
 * on invalid input. Exported so the CLI layer can validate eagerly.
 */
export function validateTrustTierValue(tier: string): void {
  if (!VALID_TRUST_TIERS.has(tier)) {
    throw new Error(
      `error: unknown trust tier "${tier}". Valid tiers: trusted, untrusted, quarantined`,
    );
  }
}

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
  /** Raw cosine similarity in [−1, 1] before recency weighting. 0 in FTS fallback mode. */
  similarity: number;
  /**
   * Final ranking score: cosine × exp(-decay × (max_seq - entry_seq)).
   * Equals `similarity` when activity_seq is unavailable (pre-AGT-291 rows).
   * 0 in FTS fallback mode (rank is determined by FTS5 engine, not this field).
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
  /**
   * True when this entry was retrieved via FTS ranking rather than vector
   * similarity search (AGT-324). Set when the embedding model is unavailable
   * or `no_embed` was requested.
   */
  fts_fallback?: true;
  /**
   * The raw entry IDs that were folded into this compacted entry.
   * Non-empty only for compacted entries; null for raw entries.
   */
  compacted_from: string[] | null;
  /**
   * The set of entry IDs this entry supersedes.
   * For compacted memory entries, equals `compacted_from`.
   * For retros, this field is always `[]` — retro supersession is tracked via
   * `memories.superseded_by` and is not yet surfaced in the recall response.
   * Always an array (empty when not applicable).
   */
  supersedes: string[];
  /**
   * Stable integer position within this cortex (ORDER BY ts ASC, id ASC).
   * Null for entries that pre-date the AGT-291 activity_seq backfill.
   */
  activity_seq: number | null;
  /**
   * Derived provenance tag (AGT-465). One of four shapes:
   *   - "self"              — entry's cortex == caller's cortex.active
   *   - "peer:<name>"       — entry's cortex differs from cortex.active
   *   - "proxy:<connector>" — entry's episode_key matches ^subscribe:([A-Za-z0-9_-]+)$
   *                           (wins over peer: when both apply)
   *   - "unknown"           — cortex.active is unset, or classification fails
   *
   * Schema regex (locked for AGT-466): ^(self|unknown|peer:[A-Za-z0-9_-]+|proxy:[A-Za-z0-9_-]+)$
   *
   * Derived at read time from already-persisted fields (cortex + episode_key);
   * no DB column added. Present on every entry returned by handleRecall.
   */
  provenance: string;
  /**
   * Derived trust tier (AGT-466). One of three values:
   *   - "trusted"     — provenance matched a `trusted` rule in cortex.trustTiers.rules
   *   - "untrusted"   — provenance matched an `untrusted` rule, or the implicit
   *                     `* → untrusted` fail-safe fired
   *   - "quarantined" — provenance matched a `quarantined` rule; the entry is
   *                     silently dropped from recall + curate by default; surfaced
   *                     only when `--include-quarantined` is passed.
   *
   * Derived post-rerank from `provenance` + `cortex.trustTiers.rules`. No DB
   * column. Additive field — old clients that don't know about this field will
   * simply ignore it.
   */
  trustTier: TrustTier;
}

interface HydratedRow {
  id: string;
  ts: string;
  content: string;
  kind: string | null;
  topics: string | null;
  /** Null for rows that pre-date the AGT-291 activity_seq backfill. */
  activity_seq: number | null;
  /** The episode_key column value for proxy detection (AGT-465). Null when absent. */
  episode_key: string | null;
}

// ---------------------------------------------------------------------------
// Schema column cache (per DB instance — avoids PRAGMA on every recall call)
// ---------------------------------------------------------------------------

interface ColumnInfo {
  /**
   * True when a legacy `topics` column exists. Migration 14 added `topics_json`
   * (not `topics`), so this is false on current schemas — and that is fine:
   * topic filtering IS wired through `topics_json` (the filter uses
   * `json_each(topics_json)` and the SELECT projects `topics_json as topics`
   * below; AGT-320). `hasTopics` only distinguishes which column name to read
   * when an older `topics` column is present.
   */
  hasTopics: boolean;
  hasTopicsJson: boolean;
  hasActivitySeq: boolean;
  /** True when migration 14 has run and superseded_at column exists. */
  hasSupersededAt: boolean;
  /** True when migration 12 has run and the compaction_links table exists. */
  hasCompactionLinks: boolean;
  /**
   * True when the curator `retros` table exists (migration 8) AND carries the
   * `promoted` / `recalled_count` columns (migration 9). Gates the AGT-459
   * quality-aware rerank: older DBs that haven't migrated have no curator state,
   * so the quality terms are skipped and ranking is pure cosine × recency.
   */
  hasRetros: boolean;
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

  // Check for compaction_links table existence (added in migration 12).
  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );

  // The quality-aware rerank (AGT-459) reads retros.promoted / .recalled_count.
  // Confirm both the table and the migration-9 columns exist before relying on
  // them — a partially-migrated DB has the table (migration 8) but not the
  // columns, and querying a missing column would throw.
  let hasRetros = false;
  if (tables.has('retros')) {
    const retroCols = new Set(
      (db.prepare('PRAGMA table_info(retros)').all() as { name: string }[]).map((c) => c.name),
    );
    hasRetros = retroCols.has('promoted') && retroCols.has('recalled_count');
  }

  const info: ColumnInfo = {
    hasTopics: cols.has('topics'),
    hasTopicsJson: cols.has('topics_json'),
    hasActivitySeq: cols.has('activity_seq'),
    hasSupersededAt: cols.has('superseded_at'),
    hasCompactionLinks: tables.has('compaction_links'),
    hasRetros,
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

/** Valid kind values for the --kind filter (AGT-320). */
const VALID_KINDS: ReadonlySet<string> = new Set(['memory', 'retro', 'event']);

/**
 * Validate a `kind` filter value. Throws with a lowercase `error:` prefix on
 * invalid input (product prose convention from AGT-320 review guidance).
 *
 * Exported so the CLI command layer can reuse validation before the daemon RPC
 * is invoked (fail fast on the client side for a cleaner UX).
 */
export function validateKind(kind: string): void {
  if (!VALID_KINDS.has(kind)) {
    throw new Error(
      `error: kind must be one of memory, retro, event, got '${kind}'`,
    );
  }
}

/**
 * Validate a `since` ISO-8601 date string. Throws with a lowercase `error:`
 * prefix on invalid input.
 *
 * Accepts date-only (2026-05-01) or full ISO-8601 timestamps. Uses only a
 * regex check — no Date constructor side-effects, no eval.
 *
 * Exported so the CLI command layer can reuse validation before the daemon RPC
 * is invoked (fail fast on the client side for a cleaner UX).
 */
export function validateSince(since: string): void {
  if (!ISO_8601_RE.test(since)) {
    throw new Error(
      `error: since must be an ISO-8601 date (e.g. 2026-05-01 or 2026-05-01T00:00:00Z), got '${since}'`,
    );
  }
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
  /**
   * Working context (repo basename) the caller is in (v3 retro locality).
   * When set, retros tagged `repo:<context>` receive an additive contextBoost.
   * Normalized lowercase. Undefined when the caller is not in a repo / did not
   * pass one — recall then behaves identically to the pre-v3 ranking.
   */
  context: string | undefined;
  since: string | undefined;
  decay: number;
  /**
   * Absolute cosine-similarity floor (AGT-456). Candidates with raw cosine
   * below this are excluded before recency reweighting. Inapplicable to the
   * FTS-fallback path (no cosine). Default DEFAULT_RELEVANCE_FLOOR (0.6);
   * config-tunable via config.recall.relevanceFloor.
   */
  relevanceFloor: number;
  /**
   * Additive boost for curator-promoted retros (AGT-459). Default
   * DEFAULT_QUALITY_BOOST (0.1); config-tunable via config.recall.qualityBoost.
   */
  qualityBoost: number;
  /**
   * Additive penalty (a non-negative magnitude, subtracted from the score) for
   * curator-relegated retros (AGT-459). Default DEFAULT_QUALITY_PENALTY (0.1);
   * config-tunable via config.recall.qualityPenalty.
   */
  qualityPenalty: number;
  /**
   * Additive boost for retros tagged with the active `context` (v3). Default
   * DEFAULT_CONTEXT_BOOST (0.1); config-tunable via config.recall.contextBoost.
   * Ignored when `context` is undefined.
   */
  contextBoost: number;
  /**
   * When true, skip BOTH the superseded_at and compaction_links filters —
   * return every entry regardless of supersession or compaction state.
   * Set by the `--full` CLI flag (AGT-305).
   */
  full: boolean;
  /**
   * When true, skip ONLY the superseded_at filter but still apply the
   * compaction_links filter for kind=memory entries.
   * Set by the `--include-superseded` CLI flag (AGT-305).
   */
  includeSuperseded: boolean;
  /**
   * When true, skip the embedding model entirely and use FTS5 ranking (AGT-324).
   * Set by the `--no-embed` CLI flag or `THINK_NO_EMBED=1` env var.
   */
  noEmbed: boolean;
  /**
   * Provenance source inclusion filter (AGT-465). When provided, only entries
   * matching at least one selector are returned. Applied post-rerank,
   * post-limit-slice — never pre-rerank.
   *
   * Selectors: "self", "unknown", "peer" (matches all peer:*), "proxy" (matches
   * all proxy:*), or exact "peer:<name>" / "proxy:<connector>" forms.
   */
  sources: string[] | undefined;
  /**
   * Provenance source exclusion filter (AGT-465). Entries matching any selector
   * are dropped. Excludes win over includes when both name the same entry.
   * Applied post-rerank, post-limit-slice — never pre-rerank.
   */
  excludeSources: string[] | undefined;
  /**
   * Trust tier inclusion filter (AGT-466). When provided, only entries whose
   * derived `trustTier` is in this list are returned. Applied post-rerank,
   * post-limit-slice, after the quarantine drop.
   */
  tiers: string[] | undefined;
  /**
   * Trust tier exclusion filter (AGT-466). Entries whose derived `trustTier`
   * is in this list are dropped. Excludes win over includes. Applied post-rerank,
   * post-limit-slice, after the quarantine drop.
   */
  excludeTiers: string[] | undefined;
  /**
   * When true, quarantined entries are surfaced instead of silently dropped
   * (AGT-466). Off by default; must be explicitly passed to surface quarantined
   * content. Does NOT opt out of `--trust-tier` / `--exclude-trust-tier` filters.
   */
  includeQuarantined: boolean;
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

  // AGT-320: validate kind against enum if provided.
  const kindRaw = typeof params['kind'] === 'string' ? params['kind'] : undefined;
  if (kindRaw !== undefined) {
    validateKind(kindRaw);
  }
  const kind = kindRaw;

  const topic = typeof params['topic'] === 'string' ? params['topic'] : undefined;

  // v3 retro locality: working context (repo basename). Normalized lowercase so
  // the `repo:<context>` topic match is case-insensitive and stable.
  const contextRaw = typeof params['context'] === 'string' ? params['context'].trim().toLowerCase() : '';
  const context = contextRaw.length > 0 ? contextRaw : undefined;

  // AGT-320: validate since as ISO-8601 if provided.
  const sinceRaw = params['since'];
  if (sinceRaw !== undefined) {
    if (typeof sinceRaw !== 'string') {
      throw new Error(
        `recall: 'since' must be an ISO-8601 date string, got ${JSON.stringify(sinceRaw)}`,
      );
    }
    validateSince(sinceRaw);
  }
  const since = typeof sinceRaw === 'string' ? sinceRaw : undefined;

  const cfg = getConfig();
  const decay = cfg.recall?.recencyDecay ?? DEFAULT_DECAY;

  // AGT-456: validate the configured floor. Cosine ∈ [−1, 1], so any value
  // above 1 would suppress every candidate forever — a silent foot-gun.
  // Reject it with a clear error rather than returning empty results
  // indefinitely. Values in [−1, 1] are active floors; anything below −1 is
  // the "disabled" sentinel (no real cosine is < −1, so nothing is filtered).
  const relevanceFloorRaw = cfg.recall?.relevanceFloor ?? DEFAULT_RELEVANCE_FLOOR;
  if (typeof relevanceFloorRaw !== 'number' || !Number.isFinite(relevanceFloorRaw) || relevanceFloorRaw > 1) {
    throw new Error(
      `recall: config.recall.relevanceFloor must be a number ≤ 1 (cosine range is [−1, 1]; use ≤ -1 to disable the floor), got ${JSON.stringify(relevanceFloorRaw)}`,
    );
  }
  const relevanceFloor = relevanceFloorRaw;

  // AGT-459: quality-aware ranking terms. Both must be finite, non-negative
  // numbers — a negative boost or penalty would invert the curator's intent
  // (penalise the promoted, boost the relegated), a silent foot-gun. Reject
  // rather than rank perversely. Set either to 0 to disable that term.
  const qualityBoostRaw = cfg.recall?.qualityBoost ?? DEFAULT_QUALITY_BOOST;
  if (typeof qualityBoostRaw !== 'number' || !Number.isFinite(qualityBoostRaw) || qualityBoostRaw < 0) {
    throw new Error(
      `recall: config.recall.qualityBoost must be a non-negative number (use 0 to disable), got ${JSON.stringify(qualityBoostRaw)}`,
    );
  }
  const qualityBoost = qualityBoostRaw;

  const qualityPenaltyRaw = cfg.recall?.qualityPenalty ?? DEFAULT_QUALITY_PENALTY;
  if (typeof qualityPenaltyRaw !== 'number' || !Number.isFinite(qualityPenaltyRaw) || qualityPenaltyRaw < 0) {
    throw new Error(
      `recall: config.recall.qualityPenalty must be a non-negative number (use 0 to disable), got ${JSON.stringify(qualityPenaltyRaw)}`,
    );
  }
  const qualityPenalty = qualityPenaltyRaw;

  // v3: context boost must be a finite, non-negative number (a negative boost
  // would demote the current repo's lessons — the inverse of intent). Set 0 to
  // disable. Mirrors the qualityBoost validation.
  const contextBoostRaw = cfg.recall?.contextBoost ?? DEFAULT_CONTEXT_BOOST;
  if (typeof contextBoostRaw !== 'number' || !Number.isFinite(contextBoostRaw) || contextBoostRaw < 0) {
    throw new Error(
      `recall: config.recall.contextBoost must be a non-negative number (use 0 to disable), got ${JSON.stringify(contextBoostRaw)}`,
    );
  }
  const contextBoost = contextBoostRaw;

  const full = params['full'] === true;
  const includeSuperseded = params['includeSuperseded'] === true;
  const noEmbed = params['no_embed'] === true;

  // AGT-465: provenance source filters. Accept a string[] or a comma-joined
  // string; normalize into a flat string[] with commas split out.
  // Each parsed selector is validated against the allowed vocabulary — an
  // unrecognized selector throws so the caller sees an actionable error rather
  // than silently getting an empty result set.
  function parseSourceList(raw: unknown): string[] | undefined {
    if (raw === undefined || raw === null) return undefined;
    let parts: string[] = [];
    if (Array.isArray(raw)) {
      parts = raw.flatMap((v) =>
        typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : [],
      );
    } else if (typeof raw === 'string') {
      parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (parts.length === 0) return undefined;
    for (const sel of parts) {
      validateSourceSelector(sel); // throws with error: prefix on invalid selector
    }
    return parts;
  }

  const sources = parseSourceList(params['sources']);
  const excludeSources = parseSourceList(params['excludeSources']);

  // AGT-466: trust tier filters. Same comma-split + repeat convention as source
  // filters. Each value must be a valid tier string (trusted/untrusted/quarantined).
  function parseTierList(raw: unknown): string[] | undefined {
    if (raw === undefined || raw === null) return undefined;
    let parts: string[] = [];
    if (Array.isArray(raw)) {
      parts = raw.flatMap((v) =>
        typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : [],
      );
    } else if (typeof raw === 'string') {
      parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (parts.length === 0) return undefined;
    for (const t of parts) {
      validateTrustTierValue(t); // throws with error: prefix on invalid value
    }
    return parts;
  }

  const tiers = parseTierList(params['tiers']);
  const excludeTiers = parseTierList(params['excludeTiers']);
  const includeQuarantined = params['includeQuarantined'] === true;

  return { query, limit, kind, topic, context, since, decay, relevanceFloor, qualityBoost, qualityPenalty, contextBoost, full, includeSuperseded, noEmbed, sources, excludeSources, tiers, excludeTiers, includeQuarantined };
}

// ---------------------------------------------------------------------------
// Scope validation (module-scope constant, not per-call allocation)
// ---------------------------------------------------------------------------

const VALID_SCOPES: ReadonlySet<string> = new Set(['active', 'accessible', 'all']);

// ---------------------------------------------------------------------------
// FTS fallback — per-cortex (AGT-324)
// ---------------------------------------------------------------------------

/**
 * Query a single cortex via FTS5 keyword ranking when the embedding model is
 * unavailable or bypassed by `no_embed`. Returns RecallEntry[] with
 * `fts_fallback: true` and `similarity: 0, score: 0` so callers can detect
 * degraded mode. The FTS5 engine itself orders results by relevance rank.
 *
 * This is a thin wrapper around `searchMemories` (the existing v2 FTS path)
 * that maps MemoryRow → RecallEntry and attaches the cortex name.
 *
 * AGT-465: accepts activeCortex for provenance derivation. The FTS path runs
 * in the CLI process and has direct access to getConfig(), so this is passed
 * in rather than called inside the inner map for testability.
 * AGT-466: each entry is classified with a `trustTier` derived from
 * `cortex.trustTiers.rules` (or the defaults when no config is set).
 */
function recallOneCortexWithFts(
  cortexName: string,
  query: string,
  limit: number,
  activeCortex?: string,
): RecallEntry[] {
  const rows = searchMemories(cortexName, query, limit);
  const trustRules = getConfig().cortex?.trustTiers?.rules;
  return rows.map((row) => {
    const provenance = deriveProvenance(cortexName, row.episode_key, activeCortex);
    const trustTier = deriveTrustTier(provenance, trustRules);
    return {
      id: row.id,
      ts: row.ts,
      kind: row.kind ?? null,
      content: row.content,
      topics: [],
      similarity: 0,
      score: 0,
      cortex: cortexName,
      fts_fallback: true as const,
      activity_seq: null,
      compacted_from: null,
      supersedes: [],
      provenance,
      trustTier,
    };
  });
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
  const entries = await handleRecallInner(params);
  recordSurfacings(params, entries);
  return entries;
}

/**
 * Append a usage-telemetry row for every retro in the recall result and bump
 * each surfaced retro's recall stats on its cortex's retros table.
 *
 * This is the single capture point for retro-surfacing analytics: every
 * `think recall`, MCP `think_recall`, and both of `think brief`'s internal
 * recall calls flow through here. Source defaults to 'recall'; `brief` tags
 * its calls with source='brief' so the report can separate task-start
 * orientation from ad-hoc recall.
 *
 * AGT-457 (design doc §5 M3): besides the append-only usage.db row, each
 * surfacing advances the originating retro's `last_recalled_at` /
 * `recalled_count` (via bumpRecallStats, grouped by cortex). This is the live
 * write-back that closes the surfacing → curation feedback loop and activates
 * the otherwise-dormant relegation path in `curate-retros`. The live option is
 * simpler than reconciling from usage.db in the curator: the daemon already
 * holds the surfaced ids + cortexes here, and `bumpRecallStats` already exists.
 *
 * Best-effort and non-throwing — recordRetroSurfacings swallows write errors,
 * and the bump is wrapped in try/catch, so telemetry/stat updates can never
 * degrade a recall response.
 */
const KNOWN_SOURCES: ReadonlySet<string> = new Set(['brief', 'recall', 'mcp', 'hook']);

function recordSurfacings(
  params: Record<string, unknown>,
  entries: RecallEntry[],
): void {
  const retros = entries.filter((e) => e.kind === 'retro');
  if (retros.length === 0) return;

  const query = typeof params['query'] === 'string' ? params['query'] : '';
  const sourceRaw = params['source'];
  const source = typeof sourceRaw === 'string' && KNOWN_SOURCES.has(sourceRaw) ? sourceRaw : 'recall';
  const session_id =
    typeof params['session_id'] === 'string' && params['session_id'].length > 0
      ? params['session_id']
      : null;

  recordRetroSurfacings({
    query,
    source,
    session_id,
    retros: retros.map((e) => ({
      retro_id: e.id,
      cortex: e.cortex,
      score: e.fts_fallback ? null : e.score,
    })),
  });

  // AGT-457 (§5 M3): write the surfacing back to the retros table so
  // last_recalled_at / recalled_count advance and the curator's relegation
  // path can fire. Group by cortex (bumpRecallStats is per-cortex) and bump
  // best-effort — a stat-update failure must never break recall.
  try {
    const idsByCortex = new Map<string, string[]>();
    for (const e of retros) {
      const ids = idsByCortex.get(e.cortex);
      if (ids) ids.push(e.id);
      else idsByCortex.set(e.cortex, [e.id]);
    }
    for (const [cortex, ids] of idsByCortex) {
      bumpRecallStats(cortex, ids);
    }
  } catch {
    /* best-effort: recall-stat write must never break recall */
  }
}

async function handleRecallInner(
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
  context: string | undefined,
  since: string | undefined,
  decay: number,
  relevanceFloor: number,
  qualityBoost: number,
  qualityPenalty: number,
  contextBoost: number,
  full: boolean,
  includeSuperseded: boolean,
  activeCortex?: string,
): Promise<RecallEntry[]> {
  // Per-cortex reindex busy check (AGT-277).
  // If the daemon is currently reindexing this cortex due to an embedding model
  // version change, return a transient error rather than querying stale or
  // partially-rebuilt vectors. Other cortexes are unaffected — the busy set is
  // per-cortex; there is no global lock.
  if (reindexingCortexes.has(cortexName)) {
    throw new Error(
      `cortex "${cortexName}" is currently being reindexed due to an embedding model version change — this may take a moment (up to several minutes for large cortexes); retry shortly or check the daemon log for progress`
    );
  }

  // Per-cortex stale-vector warning (AGT-277).
  // If the last model-mismatch reindex for this cortex failed, log a daemon-level
  // warning and proceed with recall. Stale results are better than no results;
  // we do not block. The warning surfaces via stderr so operators can see the
  // degraded state without silently returning bad vectors.
  //
  // Note: `writeLine` (the daemon log writer) is not threaded into this inner
  // function — it is owned by the daemon startup scope in index.ts and is not
  // part of the recall handler's call chain. console.error routes to stderr,
  // which the daemon captures in the log when running in background mode.
  // This is an accepted trade-off; a future refactor could thread writeLine
  // through the recall handler if daemon-log routing for this warning matters.
  if (reindexFailedCortexes.has(cortexName)) {
    const safeCortex = cortexName.replace(/[\r\n]/g, ' ');
    console.error(
      `think recall: cortex "${safeCortex}" results may be degraded — the last embedding model reindex failed; results may reflect an older model. Check the daemon log for details.`
    );
  }

  // getCortexDb calls getIndexDbPath → sanitizeName, which rejects `/`, `\`, and
  // `..` sequences. Path-traversal attempts are caught here with a clear error.
  const db = getCortexDb(cortexName);
  const { hasTopics, hasTopicsJson, hasActivitySeq, hasSupersededAt, hasCompactionLinks, hasRetros } = getColumnInfo(db);

  // AGT-320: topic filter requires a topics column. Throw rather than silently
  // returning unfiltered results. Give a helpful hint to run 'think reindex'.
  const canFilterTopics = hasTopics || hasTopicsJson;
  if (topic !== undefined && !canFilterTopics) {
    throw new Error(
      `recall: 'topic' filter requires a topics column in cortex "${cortexName}" — run 'think reindex' to apply the latest schema migrations`,
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

  // AGT-305: Filter superseded entries unless --full or --include-superseded.
  // The superseded_at column was added in migration 14; skip when absent so
  // older DBs that haven't migrated yet continue to work without filtering.
  if (!full && !includeSuperseded && hasSupersededAt) {
    conditions.push('superseded_at IS NULL');
  }

  // AGT-305: Filter compacted-raw entries for kind=memory unless --full.
  // Raw entries that have been folded into a compaction are hidden by default
  // so the caller sees the compacted (summarised) version instead.
  // This filter is ONLY applied to kind=memory — retros and events are never
  // compacted, so hiding them via compaction_links would be incorrect.
  // Uses NOT IN subquery — acceptable because compaction_links stays small
  // relative to the `memories` table (one row per compaction, not per entry).
  if (!full && hasCompactionLinks) {
    // When kind is explicitly filtered to memory, OR when no kind filter is
    // set (mixed results may include memories), apply the compaction filter
    // conditionally per-row using a WHERE-clause expression that only hides
    // memory rows in compaction_links.
    if (kind === 'memory') {
      // All returned rows are memories — safe to filter globally.
      conditions.push(
        'id NOT IN (SELECT raw_id FROM compaction_links)',
      );
    } else if (kind === undefined) {
      // Mixed results — apply only to memory rows. Non-memory kinds pass through.
      conditions.push(
        "(kind != 'memory' OR kind IS NULL OR id NOT IN (SELECT raw_id FROM compaction_links))",
      );
    }
    // If kind is set to something other than 'memory', no compaction filter
    // is needed — retros/events are never in compaction_links.
  }

  // AGT-320: since filter — ISO-8601 lower bound (inclusive) on ts.
  if (since) {
    conditions.push('ts >= ?');
    binds.push(since);
  }

  // AGT-320: kind filter — SQL parameterized, not string concat.
  if (kind) {
    conditions.push('kind = ?');
    binds.push(kind);
  }

  // AGT-320: topic filter — exact-match (lowercase) on the topics array.
  // Uses json_each() for both topics and topics_json columns.
  // Parameterized with `?` — no string concatenation of user input.
  if (topic) {
    const topicsColName = hasTopics ? 'topics' : 'topics_json';
    // Case-insensitive match: lower() on both sides so stored topics like
    // "Auth" match user input "auth" (AGT-320 review feedback).
    conditions.push(
      `EXISTS (SELECT 1 FROM json_each(${topicsColName}) jt WHERE lower(jt.value) = ?)`,
    );
    binds.push(topic.toLowerCase());
  }

  // AGT-320: topics_json wiring — alias topics_json as `topics` in the SELECT
  // so the rest of the pipeline (HydratedRow, JSON.parse) is uniform regardless
  // of which column is present. Fallback to '[]' when neither column exists.
  const topicsSelectExpr = hasTopics
    ? 'topics'
    : hasTopicsJson
      ? 'topics_json as topics'
      : "'[]' as topics";

  // AGT-465: include episode_key for proxy provenance detection.
  // The column has existed since the subscribe feature (commands/subscribe.ts);
  // gracefully fall back to NULL if it's absent on older DBs.
  const hasEpisodeKey = (db.prepare('PRAGMA table_info(memories)').all() as { name: string }[]).some(c => c.name === 'episode_key');

  const selectCols = [
    'id',
    'ts',
    'content',
    'kind',
    topicsSelectExpr,
    hasActivitySeq ? 'activity_seq' : 'NULL as activity_seq',
    hasEpisodeKey ? 'episode_key' : 'NULL as episode_key',
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

  // AGT-456 (design doc §5 M2): apply the absolute cosine-similarity floor to
  // the RAW cosine, BEFORE recency reweighting. Candidates below the floor are
  // dropped entirely so a sparse cortex returns zero entries rather than a
  // top-K of garbage-tier "best of a bad bunch" matches. Recency weighting only
  // discounts, so a sub-floor cosine could never recover above the floor anyway
  // — filtering on the raw cosine here is both correct and the cheapest cut.
  // Note: this is only reached on the vector path; the FTS fallback
  // (recallOneCortexWithFts) carries similarity=0 and is intentionally exempt,
  // since there is no cosine to compare against.
  const floorActive = relevanceFloor > -1;
  const flooredRows = floorActive
    ? rows.filter((row) => (simMap.get(row.id) ?? -Infinity) >= relevanceFloor)
    : rows;

  // Breadcrumb (AGT-456 review): the floor silently changes the long-standing
  // "always return the top-K" contract to "return nothing when nothing clears
  // the bar." Without a signal a user can't tell "no matching memories" from
  // "matches existed but scored below the floor and were suppressed." Emit a
  // stderr hint naming the drop count + floor so they know to reach for
  // `config.recall.relevanceFloor` (set ≤ -1 to disable) rather than assuming
  // data loss. Matches the existing stderr-warning convention in this file
  // (reindex/degraded warnings above); the daemon captures stderr in its log.
  if (floorActive) {
    const dropped = rows.length - flooredRows.length;
    if (dropped > 0) {
      const safeCortex = cortexName.replace(/[\r\n]/g, ' ');
      process.stderr.write(
        `think recall: ${dropped} candidate${dropped === 1 ? '' : 's'} in cortex "${safeCortex}" fell below the relevance floor (${relevanceFloor}) and ${dropped === 1 ? 'was' : 'were'} excluded. Lower or disable it via config.recall.relevanceFloor (set ≤ -1 to disable) if you expected ${dropped === 1 ? 'it' : 'them'}.\n`,
      );
    }
  }

  // Batched compaction_links lookup — one query for all returned IDs, not N+1.
  // compacted_from_map: compacted_id → array of raw_ids that folded into it.
  const compactedFromMap = new Map<string, string[]>();
  if (hasCompactionLinks && flooredRows.length > 0) {
    const rowIds = flooredRows.map((r) => r.id);
    const idPlaceholders = rowIds.map(() => '?').join(', ');
    const linkRows = db.prepare(
      `SELECT raw_id, compacted_id FROM compaction_links WHERE compacted_id IN (${idPlaceholders})`,
    ).all(...rowIds) as { raw_id: string; compacted_id: string }[];
    for (const link of linkRows) {
      const existing = compactedFromMap.get(link.compacted_id);
      if (existing) {
        existing.push(link.raw_id);
      } else {
        compactedFromMap.set(link.compacted_id, [link.raw_id]);
      }
    }
  }

  // AGT-459 (design doc §5 M4): quality-aware rerank. A retro lives in BOTH the
  // memories table (what recall surfaces, keyed by id) and the curator `retros`
  // table (which carries the promoted/relegation state), sharing one id. Batch-
  // load the curator state for the floored ids in a single query, then fold an
  // ADDITIVE quality term into the cosine × recency score below:
  //   - promoted=1                          → +qualityBoost
  //   - promoted=0 AND recalled_count > 0   → −qualityPenalty  (relegated:
  //       once promoted, demoted by the relegation pass — distinct from a
  //       never-curated promoted=0/recalled_count=0 retro, which is untouched)
  // Memory rows and un-curated cortexes have no matching retros row and get no
  // term, so ranking degrades gracefully to the prior cosine × recency order
  // (AC2). Chose additive-to-score over a similarity-only top-N re-rank because
  // the AC and design doc call for additivity, the pipeline already reranks by
  // `score`, and a small additive term breaks ties on quality without a weak-
  // but-promoted match drowning a strong exact match (design doc §8).
  const qualityApplies = hasRetros && (qualityBoost > 0 || qualityPenalty > 0);
  // id → 1 (promoted) | -1 (relegated). Absent => neutral (no term).
  const qualityMap = new Map<string, 1 | -1>();
  if (qualityApplies && flooredRows.length > 0) {
    const rowIds = flooredRows.map((r) => r.id);
    const idPlaceholders = rowIds.map(() => '?').join(', ');
    try {
      const retroRows = db.prepare(
        `SELECT id, promoted, recalled_count FROM retros
         WHERE cortex_name = ? AND tombstoned_at IS NULL AND id IN (${idPlaceholders})`,
      ).all(cortexName, ...rowIds) as { id: string; promoted: number; recalled_count: number }[];
      for (const r of retroRows) {
        if (r.promoted === 1) qualityMap.set(r.id, 1);
        else if (r.recalled_count > 0) qualityMap.set(r.id, -1);
        // promoted=0 && recalled_count=0 → never-curated; leave neutral.
      }
    } catch {
      // Best-effort: a curator-state read failure must never break recall.
      // Fall through with an empty qualityMap (pure cosine × recency ranking).
      qualityMap.clear();
    }
  }

  // v3: the reserved topic that marks a retro as belonging to the active
  // context. Computed once per cortex; null when no context is in play so the
  // boost branch is skipped entirely (and pre-v3 ranking is preserved exactly).
  const contextApplies = context !== undefined && contextBoost > 0;
  const ctxTopic = contextApplies ? `repo:${context}` : null;

  return flooredRows.map((row) => {
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
    // Sign-aware effective weight (AGT-477): for negative cosine, multiply by
    // (2 - weight) ∈ [1, 2) so older entries decay toward 2×similarity (more
    // negative) rather than toward zero, preserving recency monotonicity.
    // Positive cosine is unchanged: effWeight = weight ∈ (0, 1].
    let score: number;
    if (maxSeq !== null && row.activity_seq !== null) {
      const seqDistance = maxSeq - row.activity_seq;
      const weight = Math.exp(-decay * seqDistance);
      const effWeight = similarity >= 0 ? weight : (2 - weight);
      score = similarity * effWeight;
    } else {
      score = similarity;
    }

    // AGT-459: additive quality term, applied AFTER recency weighting so the
    // boost/penalty is a flat curator signal independent of recency, not scaled
    // by it. Neutral (absent from qualityMap) leaves the score untouched.
    const quality = qualityMap.get(row.id);
    if (quality === 1) score += qualityBoost;
    else if (quality === -1) score -= qualityPenalty;

    // v3 context boost: additive, applied after recency weighting like the
    // quality term. Only retros carrying the active `repo:<context>` topic get
    // it; everything else (other contexts, memories, events) is untouched, so
    // this never hard-filters and never perturbs the orthogonal-axis ranking
    // fixtures (which carry no repo: topic and pass no context).
    if (ctxTopic !== null && topicsValue.some((t) => t.toLowerCase() === ctxTopic)) {
      score += contextBoost;
    }

    const compactedFrom = compactedFromMap.get(row.id) ?? null;
    // For compacted entries, supersedes == compacted_from (the raws absorbed).
    // For retros, supersedes is tracked in memories.superseded_by (out of scope here).
    const supersedes = compactedFrom ?? [];

    // AGT-465: derive provenance from entry cortex + episode_key + active cortex.
    const provenance = deriveProvenance(cortexName, row.episode_key, activeCortex);

    // AGT-466: derive trust tier from provenance + cortex.trustTiers.rules.
    // getConfig() is called once per cortex (not per row) by the caller; here
    // we call it per row for simplicity since it is cached after the first call.
    // The cost is a Map lookup, not an FS read.
    const trustTier = deriveTrustTier(provenance, getConfig().cortex?.trustTiers?.rules);

    return {
      id: row.id,
      ts: row.ts,
      kind: row.kind ?? null,
      content: row.content,
      topics: topicsValue,
      similarity,
      score,
      cortex: cortexName,
      activity_seq: row.activity_seq,
      compacted_from: compactedFrom,
      supersedes,
      provenance,
      trustTier,
    };
  });
}

// ---------------------------------------------------------------------------
// recallSingleCortex — full-pipeline single-cortex entry point
// ---------------------------------------------------------------------------

/**
 * Full pipeline for recalling from one named cortex: parses params, embeds
 * query (or falls back to FTS), queries the cortex, reranks, truncates.
 * Used when `cortex` is explicitly provided or scope="active".
 *
 * When `no_embed` is true, or when the embedding model fails to load (network
 * error, timeout, missing optional dep), falls back to FTS5 ranking (AGT-324).
 * Embedding load failures are distinguished from other errors:
 *   - Network/timeout: embed() throws with a "failed to load embedding model" message.
 *   - Missing dep:     embed() throws with a "@huggingface/transformers" message.
 * Both are treated as "unavailable" and trigger the FTS fallback. Other errors
 * (e.g., DB corruption) are re-thrown so callers see them as real errors.
 */
async function recallSingleCortex(
  cortexName: string,
  params: Record<string, unknown>,
): Promise<RecallEntry[]> {
  // Validate cortex name before any expensive work (embedding model load).
  // sanitizeName throws synchronously on path-traversal or invalid chars so the
  // caller gets a fast, clear error rather than a timeout waiting for embed().
  sanitizeName(cortexName);

  const { query, limit, kind, topic, context, since, decay, relevanceFloor, qualityBoost, qualityPenalty, contextBoost, full, includeSuperseded, noEmbed, sources, excludeSources, tiers, excludeTiers, includeQuarantined } = parseRecallParams(params);

  // AGT-465: activeCortex for provenance derivation.
  const activeCortex = getConfig().cortex?.active;

  if (noEmbed) {
    const ftsEntries = recallOneCortexWithFts(cortexName, query, limit, activeCortex);
    // AGT-465: provenance filter is applied post-result on the FTS path too.
    const provFiltered = applyProvenanceFilters(ftsEntries, sources, excludeSources);
    // AGT-466: trust tier filter (quarantine drop + tier filter) applied after provenance filter.
    const { entries: tierFiltered, quarantinedDropped } = applyTrustTierFilters(provFiltered, { tiers, excludeTiers, includeQuarantined });
    emitQuarantineDropNotice(quarantinedDropped);
    return tierFiltered;
  }

  let queryVec: Float32Array;
  try {
    queryVec = await embed(query);
  } catch (err) {
    // Distinguish embedding model unavailability (network, timeout, missing dep)
    // from other failures. Both trigger FTS fallback; different log messages.
    const msg = err instanceof Error ? err.message : String(err);
    if (isEmbedModelUnavailable(msg)) {
      process.stderr.write(`think recall: embedding model unavailable (${msg}); falling back to FTS ranking\n`);
    } else {
      process.stderr.write(`think recall: embedding error (${msg}); falling back to FTS ranking\n`);
    }
    const ftsEntries = recallOneCortexWithFts(cortexName, query, limit, activeCortex);
    const provFiltered = applyProvenanceFilters(ftsEntries, sources, excludeSources);
    const { entries: tierFiltered, quarantinedDropped } = applyTrustTierFilters(provFiltered, { tiers, excludeTiers, includeQuarantined });
    emitQuarantineDropNotice(quarantinedDropped);
    return tierFiltered;
  }

  const entries = await recallOneCortexWithVec(
    cortexName, queryVec, limit, kind, topic, context, since, decay, relevanceFloor, qualityBoost, qualityPenalty, contextBoost, full, includeSuperseded, activeCortex,
  );
  entries.sort((a, b) => b.score - a.score);
  // AGT-465: provenance filter applied post-rerank, post-limit-slice.
  // NEVER apply pre-rerank — per think-cli retro: orthogonal-axis fixtures
  // in recall vector-path tests break silently if filtered before rerank.
  const sliced = entries.slice(0, limit);
  const provFiltered = applyProvenanceFilters(sliced, sources, excludeSources);
  // AGT-466: trust tier filter applied post-rerank, post-provenance-filter.
  const { entries: tierFiltered, quarantinedDropped } = applyTrustTierFilters(provFiltered, { tiers, excludeTiers, includeQuarantined });
  emitQuarantineDropNotice(quarantinedDropped);
  return tierFiltered;
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
 *
 * When `no_embed` is true or the embedding model is unavailable, all
 * cortexes fall back to FTS5 ranking (AGT-324).
 */
async function recallFederated(
  params: Record<string, unknown>,
): Promise<RecallEntry[]> {
  const { query, limit, kind, topic, context, since, decay, relevanceFloor, qualityBoost, qualityPenalty, contextBoost, full, includeSuperseded, noEmbed, sources, excludeSources, tiers, excludeTiers, includeQuarantined } = parseRecallParams(params);

  // AGT-465: read activeCortex once for provenance derivation across all cortex legs.
  const activeCortex = getConfig().cortex?.active;

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

  // noEmbed fast-path: skip embed() and fan out FTS across all cortexes.
  if (noEmbed) {
    const noEmbedFts = await Promise.all(
      cortexNames.map(async (name) => {
        try { return recallOneCortexWithFts(name, query, limit, activeCortex); }
        catch (err) {
          process.stderr.write(`think recall: cortex "${name}" failed — ${err instanceof Error ? err.message : String(err)}
`);
          return [] as RecallEntry[];
        }
      }),
    );
    // AGT-465: provenance filter applied post-result on the FTS path.
    const noEmbedSliced = noEmbedFts.flat().slice(0, limit);
    const noEmbedProvFiltered = applyProvenanceFilters(noEmbedSliced, sources, excludeSources);
    // AGT-466: trust tier filter applied after provenance filter.
    const { entries: noEmbedTierFiltered, quarantinedDropped: noEmbedDropped } = applyTrustTierFilters(noEmbedProvFiltered, { tiers, excludeTiers, includeQuarantined });
    emitQuarantineDropNotice(noEmbedDropped);
    return noEmbedTierFiltered;
  }

  // Embed once; shared across all cortex legs so the model is only invoked once.
  let queryVec: Float32Array;
  try {
    queryVec = await embed(query);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const logKind = isEmbedModelUnavailable(msg) ? 'embedding model unavailable' : 'embedding error';
    process.stderr.write(`think recall: ${logKind} (${msg}); falling back to FTS ranking\n`);
    const fallbackFts = await Promise.all(
      cortexNames.map(async (name) => {
        try { return recallOneCortexWithFts(name, query, limit, activeCortex); }
        catch (ftsErr) {
          process.stderr.write(`think recall: cortex "${name}" FTS failed — ${ftsErr instanceof Error ? ftsErr.message : String(ftsErr)}
`);
          return [] as RecallEntry[];
        }
      }),
    );
    // AGT-465: provenance filter applied post-result on the FTS fallback path.
    const fallbackSliced = fallbackFts.flat().slice(0, limit);
    const fallbackProvFiltered = applyProvenanceFilters(fallbackSliced, sources, excludeSources);
    // AGT-466: trust tier filter applied after provenance filter.
    const { entries: fallbackTierFiltered, quarantinedDropped: fallbackDropped } = applyTrustTierFilters(fallbackProvFiltered, { tiers, excludeTiers, includeQuarantined });
    emitQuarantineDropNotice(fallbackDropped);
    return fallbackTierFiltered;
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
          name, queryVec, limit, kind, topic, context, since, decay, relevanceFloor, qualityBoost, qualityPenalty, contextBoost, full, includeSuperseded, activeCortex,
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
  // AGT-465: provenance filter applied post-rerank, post-limit-slice.
  // NEVER apply pre-rerank — per think-cli retro: orthogonal-axis fixtures
  // break silently if filtered before rerank.
  const sliced = allEntries.slice(0, limit);
  const fedProvFiltered = applyProvenanceFilters(sliced, sources, excludeSources);
  // AGT-466: trust tier filter applied after provenance filter.
  const { entries: fedTierFiltered, quarantinedDropped: fedDropped } = applyTrustTierFilters(fedProvFiltered, { tiers, excludeTiers, includeQuarantined });
  emitQuarantineDropNotice(fedDropped);
  return fedTierFiltered;
}
