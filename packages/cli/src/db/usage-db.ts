/**
 * Local usage-telemetry DB (~/.think/usage.db).
 *
 * Records an append-only event log of *retro surfacings* — every time a
 * retro (a kind='retro' memory) is returned by the daemon `recall` handler,
 * one row lands here. This is the data behind `think usage`.
 *
 * Design notes:
 *   - Separate from the per-cortex index DBs on purpose. The sync adapters
 *     only ever touch the index DBs + JSONL; usage.db is never synced, so the
 *     "memories are immutable via sync" invariant is unaffected.
 *   - Append-only. The view aggregates (count, last_surfaced, timeline); we
 *     never mutate or dedupe at write time — each surfacing is a fact.
 *   - Best-effort. Recording must never break recall, so callers wrap writes
 *     in try/catch and swallow failures (see recordRetroSurfacings).
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getUsageDbPath } from '../lib/paths.js';

let db: DatabaseSync | null = null;

function ensureUsageSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS retro_surfacings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      retro_id TEXT NOT NULL,
      cortex TEXT NOT NULL,
      query TEXT NOT NULL,
      surfaced_at TEXT NOT NULL,
      score REAL,
      source TEXT NOT NULL DEFAULT 'recall'
    ) STRICT;
  `);
  database.exec('CREATE INDEX IF NOT EXISTS idx_surfacings_retro_id ON retro_surfacings(retro_id);');
  database.exec('CREATE INDEX IF NOT EXISTS idx_surfacings_surfaced_at ON retro_surfacings(surfaced_at);');
}

/** Returns the singleton usage DB connection, creating the file + schema on first use. */
export function getUsageDb(): DatabaseSync {
  if (db) return db;

  const dbPath = getUsageDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  ensureUsageSchema(db);

  return db;
}

export function closeUsageDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export interface RetroSurfacing {
  retro_id: string;
  cortex: string;
  /** The recall query that surfaced this retro. */
  query: string;
  /** Recency-weighted recall score at surfacing time; null in FTS-fallback mode. */
  score: number | null;
  /** Which surface returned it: 'recall' (think recall / MCP) or 'brief'. */
  source: string;
}

/**
 * Append one surfacing row per retro. Single transaction. Best-effort: any
 * failure (locked DB, disk full, etc.) is swallowed so recall never breaks —
 * usage telemetry is strictly secondary to serving the recall result.
 */
export function recordRetroSurfacings(surfacings: RetroSurfacing[]): void {
  if (surfacings.length === 0) return;

  try {
    const database = getUsageDb();
    const now = new Date().toISOString();
    const stmt = database.prepare(
      `INSERT INTO retro_surfacings (retro_id, cortex, query, surfaced_at, score, source)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    database.exec('BEGIN');
    try {
      for (const s of surfacings) {
        stmt.run(s.retro_id, s.cortex, s.query, now, s.score, s.source);
      }
      database.exec('COMMIT');
    } catch (err) {
      database.exec('ROLLBACK');
      throw err;
    }
  } catch {
    /* best-effort: telemetry must never break recall */
  }
}
