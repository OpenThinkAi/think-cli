/**
 * One-shot rescue of stranded `engrams` rows — AGT-1302.
 *
 * The v2 engram tier was written by `think sync -d/--context/-e` and by every
 * daemon-unreachable write until AGT-1298. Nothing has drained it since the
 * curator LaunchAgents were retired, so real decision logs have been sitting
 * in a table nothing reads (229 rows on the Studio, 55 on a teammate's machine
 * — think-cli#95) while `pruneExpiredEngrams` deleted the expired ones
 * unevaluated. This module re-submits every one of them through the v3 write
 * path before the tier is deleted (AGT-1303).
 *
 * ## The one module that touches the engrams table
 *
 * Every read of, and write to, `engrams` needed by the rescue lives here.
 * AGT-1304 adds an invariant test that nothing else under `packages/cli/src`
 * references that table once AGT-1303 has deleted the rest of the tier. Keep it
 * that way: if you need engram data elsewhere, export a function from here.
 *
 * ## Why this is not a schema migration
 *
 * `db/engrams.ts` migration `up` callbacks run inside `getCortexDb()`, i.e.
 * before any command logic executes, on the first DB open of *any* process —
 * including `--dry-run`. A pass that loads the embedding model and writes L2 +
 * L1 rows has no business in the DB-open path, and it must be skippable. It is
 * therefore a plain exported function, invoked deliberately: once from daemon
 * start (`daemon/index.ts`), from `think migrate-engrams`, and — by AGT-1307 /
 * AGT-1308 — from the heal summary and `think doctor --fix`, which consume the
 * structured {@link EngramMigrationSummary} this returns.
 *
 * ## The write path
 *
 * Each rescued row becomes exactly what `daemon/sync-handler.ts` would have
 * written: an L2 `memories` row (embedded, `activity_seq` stamped) plus the
 * `l1_outbox` row the push-debouncer drains onto the cortex branch — built
 * with the shared `buildL1Entry`/`validateEntryFields` model (AGT-1298) so no
 * parallel format exists. The one deliberate difference from a fresh write:
 * `ts`/`created_at` are the engram's ORIGINAL `created_at`, not now. These are
 * old memories, and recall ranks on `ts`.
 *
 * ## Crash safety
 *
 * The rescued entry and the stamp that retires its source row land in ONE
 * SQLite transaction — they are tables in the same cortex database, so there is
 * no window in which an entry exists unstamped (re-run would duplicate it) or a
 * row is stamped without its entry (re-run would lose it). Belt and braces: the
 * entry id is DERIVED from the engram id ({@link migratedEntryId}), so even a
 * restored-from-backup DB whose stamps were rolled back re-derives the same id,
 * finds the entry already present, and repairs the stamp instead of writing a
 * second copy.
 *
 * ## Attribution and reversal
 *
 * Every rescued entry carries the {@link MIGRATED_TOPIC} topic. A team branch
 * receiving a one-time burst of backdated entries can therefore identify them
 * (`think recall --topic migrated-engram`) and revert them wholesale, which a
 * burst of ordinary-looking writes would not allow.
 */

import { DatabaseSync } from 'node:sqlite';
import { v5 as uuidv5 } from 'uuid';
import { getConfig, getPeerId } from './config.js';
import { getIndexDbPath, sanitizeName } from './paths.js';
import { getCortexDb, listKnownCortexes } from '../db/engrams.js';
import { assignNextSeq, recomputeActivitySeq } from '../db/activity-seq.js';
import { enqueueL1Outbox } from './l1-page.js';
import { buildL1Entry, validateEntryFields, MAX_CONTENT_BYTES, type EntryKind } from './l1-entry.js';
import { contextTopic, normalizeContext } from './working-context.js';
import { sanitizeForLog } from './sanitize.js';
import embed, { EMBEDDING_MODEL_NAME } from './embed.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The topic stamped on every rescued entry. Deliberately a plain (non
 * `repo:`-prefixed) topic so it rides `topics_json` and the recall `--topic`
 * filter without being mistaken for a working-context tag.
 */
export const MIGRATED_TOPIC = 'migrated-engram';

/**
 * Rows written by `think subscribe poll` (proxy events) carry an
 * `episode_key` of `subscribe:<feed>`. They were explicitly local-only —
 * re-submitting them would push another peer's feed content onto this peer's
 * cortex branch — so they are skipped and counted separately (AC2).
 */
const SUBSCRIBE_EPISODE_PREFIX = 'subscribe:';

/** Appended when a legacy row's text does not fit the v3 content limit. */
const TRUNCATION_MARK = ' …[truncated by engram migration]';

/**
 * Namespace for the deterministic entry id. Same well-known UUID namespace
 * `lib/deterministic-id.ts` uses; collision with its output is impossible
 * because it hashes its input to a 64-char hex string first and the name
 * below never has that shape. Changing this value would make a re-run write a
 * second copy of every rescued entry — don't.
 */
const THINK_UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What the rescue did (or would do) for one cortex. */
export interface CortexEngramMigration {
  /** Cortex name, as `listKnownCortexes()` reports it. */
  cortex: string;
  /** Rows written as `kind=event` (they carried decision text). */
  events: number;
  /** Rows written as `kind=memory`. */
  memories: number;
  /** `subscribe:*` rows deliberately left where they are (AC2). */
  skippedSubscribe: number;
  /**
   * Rows that could not be turned into a valid entry even after sanitizing
   * (e.g. no content left once control characters were stripped). Reported and
   * left UNSTAMPED so they are still there to be looked at — never dropped.
   */
  skippedInvalid: number;
  /**
   * Rows whose write failed this run (embedding unavailable, DB busy). Left
   * unstamped; the next run retries them.
   */
  failed: number;
  /**
   * Rows whose entry already existed but whose source row was not stamped
   * (interrupted earlier run against a restored DB). Only the stamp was
   * re-applied; no second entry was written.
   */
  repaired: number;
  /** Set when the cortex could not be opened or read at all. */
  error?: string;
  /** Per-row advisories (truncation, unparseable decisions, skips). */
  warnings: string[];
}

/** Aggregate result — the shape AGT-1307/AGT-1308 report from. */
export interface EngramMigrationSummary {
  dryRun: boolean;
  cortexes: CortexEngramMigration[];
  totals: {
    events: number;
    memories: number;
    skippedSubscribe: number;
    skippedInvalid: number;
    failed: number;
    repaired: number;
  };
}

export interface MigrateEngramsOptions {
  /** Cortexes to sweep. Defaults to every cortex DB under the index dir. */
  cortexes?: string[];
  /** Count only; write nothing at all (AC4). */
  dryRun?: boolean;
  /** Line sink for progress/advisories. Defaults to a no-op. */
  log?: (message: string) => void;
}

/** One stranded engram row, as read for the rescue. */
interface StrandedRow {
  id: string;
  content: string;
  created_at: string;
  episode_key: string | null;
  context: string | null;
  decisions: string | null;
}

/** The v3 entry a stranded row becomes. */
interface PlannedEntry {
  kind: EntryKind;
  content: string;
  topics: string[];
}

// ---------------------------------------------------------------------------
// Row → entry planning (pure; shared by the dry run and the real pass)
// ---------------------------------------------------------------------------

/**
 * The entry id for a rescued engram: deterministic in the source row's id, so a
 * re-run cannot mint a second id for the same row. See "Crash safety" above.
 */
export function migratedEntryId(engramId: string): string {
  return uuidv5(`engram-migration:${engramId}`, THINK_UUID_NAMESPACE);
}

/**
 * Strip control characters that have no business in stored content — the C0
 * range minus tab/newline/carriage-return, plus DEL and the 8-bit C1 range
 * (which includes the 8-bit CSI at \x9b). Legacy rows predate the v3 write
 * path's validation, so anything could be in them; a rescued row must not be
 * able to smuggle an escape sequence into a terminal that later prints it.
 * Newlines survive here — `oneLine` is what collapses them where a single line
 * is required.
 */
function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
}

/** Collapse a value to a single line with single spaces. */
function oneLine(value: string): string {
  return stripControlChars(value).replace(/\s+/g, ' ').trim();
}

/** Truncate to a UTF-8 byte budget without splitting a surrogate pair. */
function truncateToBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf-8') <= maxBytes) return value;
  let lo = 0;
  let hi = value.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(value.slice(0, mid), 'utf-8') <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  let out = value.slice(0, lo);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1); // lone high surrogate
  return out;
}

/**
 * Parse the `decisions` JSON column defensively. These rows were written over
 * a year by several code paths (and by `migrate-data`, which bypassed
 * validation entirely), so nothing about the column's shape can be assumed.
 *
 * - `null` / blank                → no decisions (the row becomes a memory)
 * - a JSON array                  → its members, non-strings JSON-rendered
 *                                   rather than dropped
 * - unparseable, or not an array  → the raw column text, kept as one decision
 *
 * The one rule: decision text is never silently discarded. An empty array is
 * the sole "no decisions" case, since there is nothing in it to preserve.
 */
function parseDecisions(raw: string | null): { decisions: string[]; warning?: string } {
  if (raw === null) return { decisions: [] };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { decisions: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const one = oneLine(trimmed);
    return {
      decisions: one.length > 0 ? [one] : [],
      warning: 'decisions column was not valid JSON — kept verbatim',
    };
  }

  if (!Array.isArray(parsed)) {
    const one = oneLine(typeof parsed === 'string' ? parsed : JSON.stringify(parsed));
    return {
      decisions: one.length > 0 ? [one] : [],
      warning: 'decisions column was not a JSON array — kept as a single decision',
    };
  }

  const decisions: string[] = [];
  let coerced = false;
  for (const member of parsed) {
    if (member === null || member === undefined) continue;
    if (typeof member !== 'string') coerced = true;
    const one = oneLine(typeof member === 'string' ? member : JSON.stringify(member));
    if (one.length > 0) decisions.push(one);
  }
  return {
    decisions,
    warning: coerced ? 'decisions array held non-string members — rendered as JSON' : undefined,
  };
}

/**
 * Turn one stranded row into the entry it should become, or explain why it
 * cannot become one.
 *
 * Kind: a row with at least one decision becomes `kind=event` (that is what
 * `think event` is for now that `think sync --decision` is gone), everything
 * else becomes `kind=memory`. Content and decisions are joined into ONE line
 * so the event reads as a sentence rather than losing its decision to a column
 * the v3 model does not carry — these rows came from single-line CLI writes.
 *
 * Topics: the migration marker, plus the row's `--context` re-encoded as the
 * `repo:<context>` topic the v3 model uses, so a rescued row stays scoped to
 * the repo it was logged against and `think brief --context <x>` still finds it.
 */
function planEntry(row: StrandedRow): { entry: PlannedEntry; warnings: string[] } | { invalid: string } {
  const warnings: string[] = [];
  const { decisions, warning } = parseDecisions(row.decisions);
  if (warning) warnings.push(warning);

  const kind: EntryKind = decisions.length > 0 ? 'event' : 'memory';

  const body = decisions.length > 0
    ? oneLine(row.content ?? '')
    : stripControlChars(row.content ?? '').trim();
  const suffix = decisions.length > 0 ? ` — Decisions: ${decisions.join('; ')}` : '';

  if (body.length === 0 && suffix.length === 0) {
    return { invalid: 'no content left after stripping control characters' };
  }

  // Legacy rows were capped at 4000 chars on insert, but `migrate-data` and
  // direct writers were not, so re-fit to the v3 limit. The decision suffix is
  // the part worth keeping, so the body yields first.
  let content = `${body}${suffix}`;
  if (Buffer.byteLength(content, 'utf-8') > MAX_CONTENT_BYTES) {
    const markBytes = Buffer.byteLength(TRUNCATION_MARK, 'utf-8');
    const suffixBytes = Buffer.byteLength(suffix, 'utf-8');
    const bodyBudget = MAX_CONTENT_BYTES - markBytes - suffixBytes;
    content = bodyBudget > 0
      ? `${truncateToBytes(body, bodyBudget)}${TRUNCATION_MARK}${suffix}`
      : `${truncateToBytes(suffix.trimStart(), MAX_CONTENT_BYTES - markBytes)}${TRUNCATION_MARK}`;
    warnings.push(`content exceeded ${MAX_CONTENT_BYTES} bytes — truncated`);
  }

  const topics = [MIGRATED_TOPIC];
  const context = row.context ? normalizeContext(row.context) : null;
  if (context) topics.push(contextTopic(context));

  // The same gate the daemon applies to a live write. A legacy row that still
  // fails it is reported, not written and not stamped.
  try {
    validateEntryFields(content, kind, topics);
  } catch (err: unknown) {
    return { invalid: err instanceof Error ? err.message : String(err) };
  }

  return { entry: { kind, content, topics }, warnings };
}

/** `subscribe:*` rows are local-only by construction (AC2). */
function isSubscribeRow(row: StrandedRow): boolean {
  return (row.episode_key ?? '').startsWith(SUBSCRIBE_EPISODE_PREFIX);
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/**
 * Every unevaluated, non-deleted row — INCLUDING rows past `expires_at`
 * (AC1). Those are precisely the ones `pruneExpiredEngrams` was deleting
 * unread, so an expiry filter here would rescue only what was never at risk.
 */
const SELECT_STRANDED =
  `SELECT id, content, created_at, episode_key, context, decisions
     FROM engrams
    WHERE evaluated_at IS NULL AND deleted_at IS NULL
    ORDER BY created_at ASC, id ASC`;

/**
 * Retire the source row using the columns the tier already has — no schema
 * change, so `--dry-run` has none to avoid and AGT-1303 has none to unwind.
 * `promoted = 1` is literally true: the row was promoted into a memory/event.
 * The `evaluated_at IS NULL` guard makes a concurrent second writer a no-op
 * rather than a double-stamp.
 */
const STAMP_ROW =
  `UPDATE engrams SET evaluated_at = ?, promoted = 1 WHERE id = ? AND evaluated_at IS NULL`;

/** Same columns and defaults as `handleSync` / `outbox-index`. */
const INSERT_MEMORY =
  `INSERT OR IGNORE INTO memories
     (id, ts, author, content, source_ids, created_at, deleted_at,
      sync_version, origin_peer_id, embedding, embedding_model, activity_seq,
      kind, topics_json, occurrences)
   VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function emptyResult(cortex: string): CortexEngramMigration {
  return {
    cortex,
    events: 0,
    memories: 0,
    skippedSubscribe: 0,
    skippedInvalid: 0,
    failed: 0,
    repaired: 0,
    warnings: [],
  };
}

/**
 * Rescue every stranded engram row in every named cortex (default: every
 * cortex DB under the index dir, via `listKnownCortexes()` — a bare readdir
 * misses slash-named cortexes like `cortex/engineering`, which is #78).
 *
 * Idempotent by construction: the scan is driven by rows that have not been
 * stamped, so the second run finds nothing and does nothing. It is safe — and
 * cheap — to call on every daemon start.
 *
 * Never throws: a cortex that cannot be read is recorded in its
 * `CortexEngramMigration.error` and the sweep continues. Daemon startup must
 * not hinge on a corrupt database from a tier that is being deleted anyway.
 */
export async function migrateStrandedEngrams(
  options: MigrateEngramsOptions = {},
): Promise<EngramMigrationSummary> {
  const dryRun = options.dryRun === true;
  const log = options.log ?? ((): void => {});
  const names = options.cortexes ?? listKnownCortexes();

  const cortexes: CortexEngramMigration[] = [];
  for (const name of names) {
    let safeCortex: string;
    try {
      safeCortex = sanitizeName(name);
    } catch {
      continue; // not a name this codebase could have written
    }

    const result = emptyResult(safeCortex);
    try {
      if (dryRun) countStranded(safeCortex, result);
      else await migrateCortex(safeCortex, result, log);
    } catch (err: unknown) {
      result.error = errMsg(err);
      log(
        `engram-migration: could not ${dryRun ? 'read' : 'migrate'} cortex ` +
          `'${sanitizeForLog(safeCortex)}': ${result.error}`,
      );
    }
    cortexes.push(result);
  }

  return { dryRun, cortexes, totals: sumTotals(cortexes) };
}

function sumTotals(cortexes: CortexEngramMigration[]): EngramMigrationSummary['totals'] {
  const totals = {
    events: 0, memories: 0, skippedSubscribe: 0, skippedInvalid: 0, failed: 0, repaired: 0,
  };
  for (const c of cortexes) {
    totals.events += c.events;
    totals.memories += c.memories;
    totals.skippedSubscribe += c.skippedSubscribe;
    totals.skippedInvalid += c.skippedInvalid;
    totals.failed += c.failed;
    totals.repaired += c.repaired;
  }
  return totals;
}

// ---------------------------------------------------------------------------
// Dry run (AC4) — writes NOTHING
// ---------------------------------------------------------------------------

/**
 * Count what a real pass would do, from a READ-ONLY connection.
 *
 * Deliberately not `getCortexDb()`: that opens read-write and runs any pending
 * schema migration on the way in, which is a write. `--dry-run` promises none,
 * so a cortex that cannot be opened read-only is reported as an error rather
 * than quietly opened for writing. (A read-only open succeeds against a WAL
 * database another process holds open; it fails only when the WAL would need
 * recovery, i.e. after an unclean exit with no live connection.)
 */
function countStranded(safeCortex: string, result: CortexEngramMigration): void {
  const db = new DatabaseSync(getIndexDbPath(safeCortex), { readOnly: true });
  try {
    const rows = db.prepare(SELECT_STRANDED).all() as unknown as StrandedRow[];
    for (const row of rows) {
      if (isSubscribeRow(row)) {
        result.skippedSubscribe++;
        continue;
      }
      const planned = planEntry(row);
      if ('invalid' in planned) {
        result.skippedInvalid++;
        result.warnings.push(`${sanitizeForLog(row.id)}: ${sanitizeForLog(planned.invalid)}`);
        continue;
      }
      if (planned.entry.kind === 'event') result.events++;
      else result.memories++;
      for (const w of planned.warnings) result.warnings.push(`${sanitizeForLog(row.id)}: ${w}`);
    }
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// The real pass
// ---------------------------------------------------------------------------

async function migrateCortex(
  safeCortex: string,
  result: CortexEngramMigration,
  log: (message: string) => void,
): Promise<void> {
  const db = getCortexDb(safeCortex);
  const stranded = db.prepare(SELECT_STRANDED).all() as unknown as StrandedRow[];
  if (stranded.length === 0) return;

  // `subscribe:*` rows are counted and left where they are, so they are out of
  // the way before anything claims to be rescuing a row (AC2).
  const rows = stranded.filter((row) => !isSubscribeRow(row));
  result.skippedSubscribe = stranded.length - rows.length;
  if (rows.length === 0) return;

  const safeLogName = sanitizeForLog(safeCortex);
  log(
    `engram-migration: ${rows.length} stranded engram row(s) in cortex '${safeLogName}' — rescuing`,
  );

  const config = getConfig();
  const author = config.cortex?.author ?? 'unknown';
  const originPeerId = getPeerId();

  const insertMemory = db.prepare(INSERT_MEMORY);
  const stampRow = db.prepare(STAMP_ROW);
  const entryExists = db.prepare('SELECT 1 FROM memories WHERE id = ? LIMIT 1');

  for (const row of rows) {
    const planned = planEntry(row);
    if ('invalid' in planned) {
      // Reported and left unstamped — an unusable legacy row stays visible
      // instead of disappearing into a counter.
      result.skippedInvalid++;
      const note = `${sanitizeForLog(row.id)}: ${sanitizeForLog(planned.invalid)}`;
      result.warnings.push(note);
      log(`engram-migration: skipping unusable row in '${safeLogName}' — ${note}`);
      continue;
    }
    for (const w of planned.warnings) result.warnings.push(`${sanitizeForLog(row.id)}: ${w}`);

    const { kind, content, topics } = planned.entry;
    const entryId = migratedEntryId(row.id);

    // Already written by an earlier run whose stamp did not survive (restored
    // backup). Re-apply the stamp only; never a second entry.
    if (entryExists.get(entryId) !== undefined) {
      stampRow.run(new Date().toISOString(), row.id);
      result.repaired++;
      continue;
    }

    let embeddingBytes: Buffer;
    try {
      const vec = await embed(content);
      embeddingBytes = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    } catch (err: unknown) {
      // No embedding means no recallable L2 row. Leave the source row alone so
      // the next start retries it — a stranded row is recoverable, a lost one
      // is not.
      result.failed++;
      log(
        `engram-migration: could not embed row ${sanitizeForLog(row.id)} in ` +
          `'${safeLogName}' (left for the next run): ${errMsg(err)}`,
      );
      continue;
    }

    const activitySeq = assignNextSeq(safeCortex);
    const entry = buildL1Entry({
      id: entryId,
      ts: row.created_at,
      author,
      origin_peer_id: originPeerId,
      kind,
      content,
      topics,
    });

    // L2 row, L1 hand-off and the source stamp in one transaction: all three
    // tables live in this database, so there is no crash window between
    // "entry written" and "row retired". BEGIN IMMEDIATE takes the write lock
    // up front rather than risking a mid-transaction upgrade against a running
    // daemon.
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        insertMemory.run(
          entryId,
          row.created_at,
          author,
          content,
          JSON.stringify([]),
          row.created_at,
          null,
          originPeerId,
          embeddingBytes,
          EMBEDDING_MODEL_NAME,
          activitySeq,
          kind,
          JSON.stringify(topics),
          null, // occurrences is retro-only; nothing here is a retro
        );
        enqueueL1Outbox(db, entryId, JSON.stringify(entry), row.created_at);
        stampRow.run(new Date().toISOString(), row.id);
        db.exec('COMMIT');
      } catch (err: unknown) {
        try { db.exec('ROLLBACK'); } catch { /* best effort */ }
        throw err;
      }
    } catch (err: unknown) {
      result.failed++;
      log(
        `engram-migration: could not write row ${sanitizeForLog(row.id)} in ` +
          `'${safeLogName}' (left for the next run): ${errMsg(err)}`,
      );
      continue;
    }

    if (kind === 'event') result.events++;
    else result.memories++;
  }

  const written = result.events + result.memories;
  if (written > 0) {
    // Rescued entries carry their ORIGINAL timestamps, so appending them with
    // the next free activity_seq would rank a 2026-05 memory as the newest
    // thing in the cortex. One recompute re-ranks every row by (ts, id) — the
    // same pass `think reindex` ends with.
    try {
      recomputeActivitySeq(safeCortex);
    } catch (err: unknown) {
      log(`engram-migration: activity_seq recompute failed for '${safeLogName}': ${errMsg(err)}`);
    }
    log(
      `engram-migration: rescued ${written} entr${written === 1 ? 'y' : 'ies'} ` +
        `(${result.events} event(s), ${result.memories} memor${result.memories === 1 ? 'y' : 'ies'}) ` +
        `from cortex '${safeLogName}'` +
        (result.skippedSubscribe > 0 ? `; skipped ${result.skippedSubscribe} subscribe row(s)` : '') +
        (result.skippedInvalid > 0 ? `; ${result.skippedInvalid} unusable row(s) left in place` : '') +
        (result.failed > 0 ? `; ${result.failed} row(s) failed, will retry next start` : ''),
    );
  }
}

function errMsg(err: unknown): string {
  return sanitizeForLog(err instanceof Error ? err.message : String(err));
}
