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

export interface RetroUsageEntry {
  retro_id: string;
  cortex: string;
  /** Retro text; null if the retro has since been deleted/superseded out of memories. */
  content: string | null;
  created_at: string | null;
  surface_count: number;
  brief_count: number;
  recall_count: number;
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
              SUM(CASE WHEN source = 'recall' THEN 1 ELSE 0 END) AS recall
       FROM retro_surfacings
       GROUP BY retro_id, cortex
       ORDER BY c DESC, last DESC`,
    )
    .all() as unknown as AggRow[];

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

    return {
      retro_id: r.retro_id,
      cortex: r.cortex,
      content: meta?.content ?? null,
      created_at: meta?.created_at ?? null,
      surface_count: r.c,
      brief_count: r.brief,
      recall_count: r.recall,
      first_surfaced: r.first,
      last_surfaced: r.last,
      queries,
      timeline,
    };
  });

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
