/**
 * Local usage-telemetry DB (~/.think/usage.db).
 *
 * Records an append-only event log of *retro surfacings* — every time a
 * retro (a kind='retro' memory) is returned by the daemon `recall` handler,
 * one row lands here. This is the data behind `think usage`.
 *
 * Each row answers: which retro (retro_id), from which repo/cortex (cortex),
 * how it was pulled in (source), and where in the session (session_id +
 * session_seq). Count over retro_id = "how many times a retro was called".
 *
 * Design notes:
 *   - Separate from the per-cortex index DBs on purpose. The sync adapters
 *     only ever touch the index DBs + JSONL; usage.db is never synced, so the
 *     "memories are immutable via sync" invariant is unaffected.
 *   - Append-only. Aggregation happens at read time; each surfacing is a fact.
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
      source TEXT NOT NULL DEFAULT 'recall',
      session_id TEXT,
      session_seq INTEGER
    ) STRICT;
  `);
  // Older DBs (pre session columns): add them if missing.
  const cols = new Set(
    (database.prepare('PRAGMA table_info(retro_surfacings)').all() as { name: string }[]).map((c) => c.name),
  );
  if (!cols.has('session_id')) database.exec('ALTER TABLE retro_surfacings ADD COLUMN session_id TEXT;');
  if (!cols.has('session_seq')) database.exec('ALTER TABLE retro_surfacings ADD COLUMN session_seq INTEGER;');

  database.exec('CREATE INDEX IF NOT EXISTS idx_surfacings_retro_id ON retro_surfacings(retro_id);');
  database.exec('CREATE INDEX IF NOT EXISTS idx_surfacings_surfaced_at ON retro_surfacings(surfaced_at);');
  database.exec('CREATE INDEX IF NOT EXISTS idx_surfacings_session ON retro_surfacings(session_id);');
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

/** One retro returned by a single recall call. */
export interface SurfacedRetro {
  retro_id: string;
  /** The repo/cortex the returned retro belongs to. */
  cortex: string;
  /** Recency-weighted recall score; null in FTS-fallback mode. */
  score: number | null;
}

/** A single recall call that returned one or more retros. */
export interface RetroSurfacingCall {
  /** The query that triggered the recall. */
  query: string;
  /** Calling surface: 'brief' | 'recall' | 'mcp' | 'hook'. */
  source: string;
  /** Harness session id (CLAUDE_CODE_SESSION_ID / hook payload); null if unknown. */
  session_id: string | null;
  /** The retros this call returned. */
  retros: SurfacedRetro[];
}

/**
 * Record one recall call's retro surfacings. Computes session_seq (the 1-based
 * ordinal of this call within its session, so seq=1 means "session start") and
 * writes one row per returned retro in a single transaction.
 *
 * Best-effort: any failure is swallowed so telemetry can never break recall.
 */
export function recordRetroSurfacings(call: RetroSurfacingCall): void {
  if (call.retros.length === 0) return;

  try {
    const database = getUsageDb();
    const now = new Date().toISOString();

    // session_seq = 1 + number of prior calls in this session. Distinct
    // surfaced_at values approximate distinct calls (each call stamps one ts).
    let seq: number | null = null;
    if (call.session_id) {
      const row = database
        .prepare('SELECT COUNT(DISTINCT surfaced_at) AS n FROM retro_surfacings WHERE session_id = ?')
        .get(call.session_id) as { n: number };
      seq = row.n + 1;
    }

    const stmt = database.prepare(
      `INSERT INTO retro_surfacings
         (retro_id, cortex, query, surfaced_at, score, source, session_id, session_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    database.exec('BEGIN');
    try {
      for (const r of call.retros) {
        stmt.run(r.retro_id, r.cortex, call.query, now, r.score, call.source, call.session_id, seq);
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
