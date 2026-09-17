/**
 * Boot-time L1 → L2 indexing of pending `l1_outbox` rows — AGT-1298.
 *
 * `handleSync` writes the L2 row and the outbox row in one transaction, so a
 * row the daemon itself enqueued always has its L2 counterpart. The
 * daemon-unreachable CLI fallback (`lib/l1-fallback.ts`) cannot: embedding in
 * a short-lived CLI process would cost seconds per write, and L2 rows carry an
 * embedding. It therefore enqueues the L1 line alone, and this module — run
 * once at daemon startup, before the push-debouncer drains (and deletes) those
 * rows — embeds each un-indexed entry and inserts it into L2 exactly as
 * `handleSync` would have.
 *
 * That is what makes an offline `think sync` / `think event` / `think retro`
 * show up in `think recall` after `think daemon start` with no manual
 * `think reindex`.
 *
 * Idempotent: rows whose id is already in `memories` are skipped, so replaying
 * the daemon's own un-drained rows (crash between the transaction and the
 * debounce) is a no-op, and a backend whose drain keeps failing does not
 * double-insert on every boot.
 */

import { getCortexDb } from '../db/engrams.js';
import { assignNextSeq } from '../db/activity-seq.js';
import { sanitizeName } from '../lib/paths.js';
import { sanitizeForLog } from '../lib/sanitize.js';
import embed, { EMBEDDING_MODEL_NAME } from '../lib/embed.js';
import { validateEntryFields, type EntryKind } from '../lib/l1-entry.js';
import { compactionQueue } from './compaction/queue.js';

/** One pending outbox row, as read for indexing. */
interface OutboxRow {
  id: number;
  entry_id: string;
  line: string;
}

/**
 * Index every pending `l1_outbox` row that has no `memories` row yet, for each
 * named cortex. Returns the number of entries inserted into L2.
 *
 * Best-effort per entry and per cortex: a malformed line, a failed embed, or an
 * unreadable DB is logged and skipped rather than blocking daemon startup. A
 * skipped row keeps its outbox row until the drain removes it; if that happens
 * first the entry is still durable in L1 and `think reindex` recovers it.
 */
export async function indexPendingOutboxEntries(
  cortexes: string[],
  writeLine: (msg: string) => void,
): Promise<number> {
  let indexed = 0;

  for (const cortex of cortexes) {
    let safeCortex: string;
    try {
      safeCortex = sanitizeName(cortex);
    } catch {
      continue; // invalid cortex name — not ours to index
    }
    const safeLogName = sanitizeForLog(safeCortex);

    let rows: OutboxRow[];
    let exists: (id: string) => boolean;
    try {
      const db = getCortexDb(safeCortex);
      rows = db
        .prepare('SELECT id, entry_id, line FROM l1_outbox ORDER BY id ASC')
        .all() as unknown as OutboxRow[];
      const existsStmt = db.prepare('SELECT 1 FROM memories WHERE id = ? LIMIT 1');
      exists = (id: string): boolean => existsStmt.get(id) !== undefined;
    } catch (err: unknown) {
      writeLine(
        `outbox-index: could not read outbox for cortex '${safeLogName}': ${errMsg(err)}`,
      );
      continue;
    }

    if (rows.length === 0) continue;

    let indexedHere = 0;
    for (const row of rows) {
      try {
        if (await indexOneRow(safeCortex, row, exists, writeLine)) indexedHere++;
      } catch (err: unknown) {
        // Leave the row in place: it is still the durable record until the
        // drain pushes it to L1.
        writeLine(
          `outbox-index: could not index entry ${sanitizeForLog(row.entry_id)} ` +
            `for cortex '${safeLogName}' (left for 'think reindex'): ${errMsg(err)}`,
        );
      }
    }

    if (indexedHere > 0) {
      writeLine(
        `outbox-index: indexed ${indexedHere} un-indexed entr${indexedHere === 1 ? 'y' : 'ies'} ` +
          `for cortex '${safeLogName}' (written while the daemon was down)`,
      );
      indexed += indexedHere;
    }
  }

  return indexed;
}

/**
 * Index a single outbox row. Returns true when a row was inserted into L2,
 * false when the entry was deliberately skipped (already indexed, tombstone,
 * or malformed). Throws only on embed/DB failure.
 */
async function indexOneRow(
  safeCortex: string,
  row: OutboxRow,
  exists: (id: string) => boolean,
  writeLine: (msg: string) => void,
): Promise<boolean> {
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(row.line) as Record<string, unknown>;
  } catch {
    writeLine(
      `outbox-index: skipping unparseable outbox line ${row.id} for cortex '${sanitizeForLog(safeCortex)}'`,
    );
    return false;
  }

  const id = typeof entry.id === 'string' ? entry.id : null;
  if (id === null) return false;

  // Tombstone lines (delete-handler / supersession apply) reuse an existing
  // id and only mark it deleted — never a fresh row.
  if (entry.deleted_at !== null && entry.deleted_at !== undefined) return false;

  // The common case: the daemon wrote L2 and the outbox row in one
  // transaction and simply never drained. Nothing to do.
  if (exists(id)) return false;

  const content = typeof entry.content === 'string' ? entry.content : '';
  const kind = typeof entry.kind === 'string' ? entry.kind : 'memory';
  const topics = Array.isArray(entry.topics) ? (entry.topics as string[]) : [];
  try {
    validateEntryFields(content, kind, topics);
  } catch (err: unknown) {
    writeLine(
      `outbox-index: skipping invalid entry ${sanitizeForLog(id)} for cortex ` +
        `'${sanitizeForLog(safeCortex)}': ${errMsg(err)}`,
    );
    return false;
  }

  const ts = typeof entry.ts === 'string' ? entry.ts : new Date().toISOString();
  const author = typeof entry.author === 'string' ? entry.author : 'unknown';
  const originPeerId =
    typeof entry.origin_peer_id === 'string' ? entry.origin_peer_id : null;

  // Original write time is preserved: this is a replay, not a new write.
  const embeddingVec = await embed(content);
  const embeddingBytes = Buffer.from(
    embeddingVec.buffer,
    embeddingVec.byteOffset,
    embeddingVec.byteLength,
  );

  const activitySeq = assignNextSeq(safeCortex);
  const db = getCortexDb(safeCortex);
  // Same columns and defaults as handleSync's insert — including the
  // retro-only `occurrences` baseline of 1 so a later near-duplicate fold
  // increments a known value. INSERT OR IGNORE keeps a concurrent write from
  // turning into an error.
  db.prepare(
    `INSERT OR IGNORE INTO memories
       (id, ts, author, content, source_ids, created_at, deleted_at,
        sync_version, origin_peer_id, embedding, embedding_model, activity_seq,
        kind, topics_json, occurrences)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    ts,
    author,
    content,
    JSON.stringify([]),
    ts,
    null,
    originPeerId,
    embeddingBytes,
    EMBEDDING_MODEL_NAME,
    activitySeq,
    kind,
    JSON.stringify(topics),
    kind === 'retro' ? 1 : null,
  );

  // Mirrors handleSync: only kind=memory is compacted. The retro supersession
  // worker is deliberately NOT scheduled here — it is an LLM round trip per
  // entry and daemon startup is not the place for it; the retro is recallable
  // either way and `think curate-retros` still folds duplicates later.
  if ((kind as EntryKind) === 'memory') {
    compactionQueue.enqueue(id, safeCortex);
  }

  return true;
}

function errMsg(err: unknown): string {
  return sanitizeForLog(err instanceof Error ? err.message : String(err));
}
