/**
 * Read/aggregation layer for retro-usage telemetry.
 *
 * Joins the append-only surfacing log (usage.db) against the live retro rows
 * (kind='retro' memories in each cortex's index DB) to produce the dataset
 * behind `think usage`:
 *   - which retros surface, how often, via what queries, on what days
 *   - which retros are "dead" — they exist but have never once been recalled
 */

import { getUsageDb } from './usage-db.js';
import { getCortexDb } from './engrams.js';
import { listLocalBranches } from '../lib/git.js';
import { getConfig } from '../lib/config.js';
import {
  computeRetroValueSignal,
  resolveRetroValueWeights,
} from '../lib/retro-value-signal.js';

export interface RetroUsageEntry {
  retro_id: string;
  cortex: string;
  /** Retro text; null if the retro has since been deleted/superseded out of memories. */
  content: string | null;
  created_at: string | null;
  surface_count: number;
  /** Calls broken down by surface: brief | recall | mcp | hook. */
  by_source: { brief: number; recall: number; mcp: number; hook: number };
  /** Session-stage split: calls that were the session's first recall vs later. */
  session_start_count: number;
  mid_session_count: number;
  /** Independent re-reports (`retros.occurrences`); 1 when the retro row is absent. */
  occurrences: number;
  /**
   * Composite value signal (AGT-460 / design doc §5 M5) — the quality-aware
   * proxy that replaces raw surface-count for ranking. Higher = more valuable.
   */
  value_signal: number;
  first_surfaced: string;
  last_surfaced: string;
  /** Distinct queries that surfaced this retro, most-recent first (capped). */
  queries: string[];
  /** Per-day surfacing counts, ascending by date. */
  timeline: { date: string; count: number }[];
}

export interface DeadRetro {
  retro_id: string;
  cortex: string;
  content: string;
  created_at: string;
}

export interface RetroUsageReport {
  generated_at: string;
  total_surfacings: number;
  cortexes: string[];
  surfaced: RetroUsageEntry[];
  dead: DeadRetro[];
}

interface AggRow {
  retro_id: string;
  cortex: string;
  c: number;
  first: string;
  last: string;
  brief: number;
  recall: number;
  mcp: number;
  hook: number;
  started: number;
  mid: number;
  /** Most-recent surfaced_at among high-similarity (score ≥ threshold) hits; null if none. */
  last_high_sim: string | null;
}

const MAX_QUERIES_PER_RETRO = 10;

/** Looks up a retro's current content/created_at from its cortex memories table. */
function lookupRetro(
  cortex: string,
  retroId: string,
): { content: string; created_at: string } | null {
  try {
    const db = getCortexDb(cortex);
    const row = db
      .prepare(
        `SELECT content, created_at FROM memories
         WHERE id = ? AND kind = 'retro' AND deleted_at IS NULL`,
      )
      .get(retroId) as { content: string; created_at: string } | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

/**
 * A retro's independent re-report count from the cortex `retros` table.
 * Defaults to 1 when the row is absent — a surfaced retro that has no curator
 * `retros` row (e.g. a ghost surfacing, or telemetry-only test data) is treated
 * as a single occurrence rather than zero, so the composite never undercounts.
 */
function lookupOccurrences(cortex: string, retroId: string): number {
  try {
    const db = getCortexDb(cortex);
    const row = db
      .prepare('SELECT occurrences FROM retros WHERE id = ? AND cortex_name = ?')
      .get(retroId, cortex) as { occurrences: number } | undefined;
    return row?.occurrences ?? 1;
  } catch {
    return 1;
  }
}

/** All non-deleted retros for a cortex (id, content, created_at). */
function listRetros(
  cortex: string,
): { id: string; content: string; created_at: string }[] {
  try {
    const db = getCortexDb(cortex);
    return db
      .prepare(
        `SELECT id, content, created_at FROM memories
         WHERE kind = 'retro' AND deleted_at IS NULL`,
      )
      .all() as { id: string; content: string; created_at: string }[];
  } catch {
    return [];
  }
}

/** Enumerate local cortex names; falls back to the cortexes seen in surfacings. */
function enumerateCortexes(seen: Set<string>): string[] {
  try {
    const branches = listLocalBranches();
    const merged = new Set<string>(branches);
    for (const c of seen) merged.add(c);
    return [...merged];
  } catch {
    return [...seen];
  }
}

export function getRetroUsageReport(): RetroUsageReport {
  const db = getUsageDb();
  const weights = resolveRetroValueWeights(getConfig().cortex?.retroValueSignal);
  const now = new Date();

  const totalRow = db
    .prepare('SELECT COUNT(*) AS n FROM retro_surfacings')
    .get() as { n: number };

  const aggRows = db
    .prepare(
      `SELECT retro_id,
              cortex,
              COUNT(*)                                        AS c,
              MIN(surfaced_at)                                AS first,
              MAX(surfaced_at)                                AS last,
              SUM(CASE WHEN source = 'brief'  THEN 1 ELSE 0 END) AS brief,
              SUM(CASE WHEN source = 'recall' THEN 1 ELSE 0 END) AS recall,
              SUM(CASE WHEN source = 'mcp'    THEN 1 ELSE 0 END) AS mcp,
              SUM(CASE WHEN source = 'hook'   THEN 1 ELSE 0 END) AS hook,
              SUM(CASE WHEN session_seq = 1   THEN 1 ELSE 0 END) AS started,
              SUM(CASE WHEN session_seq > 1   THEN 1 ELSE 0 END) AS mid,
              MAX(CASE WHEN score >= ? THEN surfaced_at END)     AS last_high_sim
       FROM retro_surfacings
       GROUP BY retro_id, cortex`,
    )
    .all(weights.highSimilarityThreshold) as unknown as AggRow[];

  const queriesStmt = db.prepare(
    `SELECT query, MAX(surfaced_at) AS m
     FROM retro_surfacings
     WHERE retro_id = ? AND cortex = ?
     GROUP BY query
     ORDER BY m DESC
     LIMIT ?`,
  );
  const timelineStmt = db.prepare(
    `SELECT substr(surfaced_at, 1, 10) AS date, COUNT(*) AS count
     FROM retro_surfacings
     WHERE retro_id = ? AND cortex = ?
     GROUP BY date
     ORDER BY date ASC`,
  );

  const surfacedIds = new Set<string>();
  const cortexesSeen = new Set<string>();

  const surfaced: RetroUsageEntry[] = aggRows.map((r) => {
    surfacedIds.add(`${r.cortex} ${r.retro_id}`);
    cortexesSeen.add(r.cortex);

    const queries = (
      queriesStmt.all(r.retro_id, r.cortex, MAX_QUERIES_PER_RETRO) as {
        query: string;
      }[]
    ).map((q) => q.query);

    const timeline = timelineStmt.all(r.retro_id, r.cortex) as {
      date: string;
      count: number;
    }[];

    const meta = lookupRetro(r.cortex, r.retro_id);
    const occurrences = lookupOccurrences(r.cortex, r.retro_id);
    const value_signal = computeRetroValueSignal(
      {
        occurrences,
        briefCount: r.brief,
        sessionStartCount: r.started,
        midSessionCount: r.mid,
        lastHighSimilarityAt: r.last_high_sim,
      },
      weights,
      now,
    );

    return {
      retro_id: r.retro_id,
      cortex: r.cortex,
      content: meta?.content ?? null,
      created_at: meta?.created_at ?? null,
      surface_count: r.c,
      by_source: { brief: r.brief, recall: r.recall, mcp: r.mcp, hook: r.hook },
      session_start_count: r.started,
      mid_session_count: r.mid,
      occurrences,
      value_signal,
      first_surfaced: r.first,
      last_surfaced: r.last,
      queries,
      timeline,
    };
  });

  // Rank by the composite value signal (AGT-460), not raw surface-count.
  // Tie-break on surface_count then most-recent surfacing for stability.
  surfaced.sort(
    (a, b) =>
      b.value_signal - a.value_signal ||
      b.surface_count - a.surface_count ||
      b.last_surfaced.localeCompare(a.last_surfaced),
  );

  // Dead retros: kind='retro' memories that have never appeared in a surfacing.
  const dead: DeadRetro[] = [];
  for (const cortex of enumerateCortexes(cortexesSeen)) {
    for (const retro of listRetros(cortex)) {
      if (surfacedIds.has(`${cortex} ${retro.id}`)) continue;
      dead.push({
        retro_id: retro.id,
        cortex,
        content: retro.content,
        created_at: retro.created_at,
      });
      cortexesSeen.add(cortex);
    }
  }

  return {
    generated_at: new Date().toISOString(),
    total_surfacings: totalRow.n,
    cortexes: [...cortexesSeen].sort(),
    surfaced,
    dead,
  };
}

/** Per-retro surfacing telemetry for one cortex (the inputs the composite needs
 *  beyond `occurrences`, which the caller already has from the `retros` table). */
export interface RetroSurfacingTelemetry {
  briefCount: number;
  sessionStartCount: number;
  midSessionCount: number;
  /** Most-recent high-similarity (score ≥ threshold) surfacing, or null. */
  lastHighSimilarityAt: string | null;
}

/**
 * Aggregate the surfacing telemetry for every retro that has surfaced in a
 * given cortex, keyed by retro_id. Used by the curator (AGT-460) to compute the
 * composite value signal for promotion. Retros with no surfacing rows are
 * simply absent from the map — the caller treats a miss as all-zero telemetry.
 *
 * `highSimilarityThreshold` selects which surfacings count toward the recency
 * bonus; pass the resolved config value.
 */
export function getRetroSurfacingTelemetry(
  cortex: string,
  highSimilarityThreshold: number,
): Map<string, RetroSurfacingTelemetry> {
  const db = getUsageDb();
  const rows = db
    .prepare(
      `SELECT retro_id,
              SUM(CASE WHEN source = 'brief'  THEN 1 ELSE 0 END) AS brief,
              SUM(CASE WHEN session_seq = 1   THEN 1 ELSE 0 END) AS started,
              SUM(CASE WHEN session_seq > 1   THEN 1 ELSE 0 END) AS mid,
              MAX(CASE WHEN score >= ? THEN surfaced_at END)     AS last_high_sim
       FROM retro_surfacings
       WHERE cortex = ?
       GROUP BY retro_id`,
    )
    .all(highSimilarityThreshold, cortex) as unknown as {
    retro_id: string;
    brief: number;
    started: number;
    mid: number;
    last_high_sim: string | null;
  }[];

  const map = new Map<string, RetroSurfacingTelemetry>();
  for (const r of rows) {
    map.set(r.retro_id, {
      briefCount: r.brief,
      sessionStartCount: r.started,
      midSessionCount: r.mid,
      lastHighSimilarityAt: r.last_high_sim,
    });
  }
  return map;
}
