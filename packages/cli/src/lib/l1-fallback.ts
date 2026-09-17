/**
 * Daemon-unreachable write fallback — AGT-1298 (AGT-289 AC4, finally).
 *
 * `think sync` / `think event` / `think retro` route every write through the
 * daemon. When the daemon cannot be reached the write still has to land
 * somewhere the daemon will pick up on its next start — historically it went
 * to the v2 `engrams` table, which nothing drains and nothing recalls, so
 * months of decisions were stranded there (think-cli#95).
 *
 * The durable hand-off every L1 writer already uses is the cortex's
 * `l1_outbox` table (see `lib/l1-page.ts` and `daemon/push-debouncer.ts`): the
 * daemon drains it onto the cortex branch under a global mutex, and
 * `daemon/outbox-index.ts` indexes any un-indexed row into L2 on boot. Writing
 * there — rather than checking the shared worktree out from a CLI process —
 * means an offline write is replayed by exactly the machinery a crashed
 * daemon's own un-drained rows are replayed by, on either sync backend (the
 * outbox lives in the cortex index DB, which the git-remote and `--fs`
 * backends both have).
 */

import chalk from 'chalk';
import { v7 as uuidv7 } from 'uuid';
import { getConfig, getPeerId } from './config.js';
import { sanitizeName } from './paths.js';
import { getCortexDb, closeCortexDb } from '../db/engrams.js';
import { enqueueL1Outbox } from './l1-page.js';
import { buildL1Entry, validateEntryFields, type EntryKind } from './l1-entry.js';

export interface DaemonDownWrite {
  /** Target cortex name (unsanitized — validated here). */
  cortex: string;
  content: string;
  kind: EntryKind;
  topics?: string[];
}

export interface DaemonDownResult {
  /** uuidv7 of the entry, as the daemon would have minted it. */
  id: string;
  /** ISO-8601 write timestamp. */
  ts: string;
}

/**
 * The one-line stderr note this path always emits.
 *
 * Stderr, so callers capturing stdout (`OUT=$(think sync …)`) never embed it
 * in their parsed value; unconditional, so a `--silent` auto-logging hook
 * still leaves a trace that the daemon was down when it wrote (AGT-1298 AC3).
 * It is deliberately the ONLY output difference between this path and the
 * daemon path — stdout stays byte-identical.
 */
export const DAEMON_DOWN_NOTE =
  '  note: daemon unavailable — wrote to L1; it will be indexed on next daemon start\n';

/**
 * Write one entry to the active cortex's L1 outbox and emit the stderr note.
 *
 * Throws when the entry cannot be made durable (invalid cortex name, invalid
 * field, or a SQLite failure) — callers surface the message and exit non-zero
 * (AC4). Never writes to the `engrams` table.
 */
export function writeDaemonDownEntry(write: DaemonDownWrite): DaemonDownResult {
  validateEntryFields(write.content, write.kind, write.topics);

  // Throws on path-traversal / illegal characters, same gate the daemon's
  // cortexExists() applies before touching the filesystem.
  const safeCortex = sanitizeName(write.cortex);

  const id = uuidv7();
  const ts = new Date().toISOString();
  const config = getConfig();

  const entry = buildL1Entry({
    id,
    ts,
    author: config.cortex?.author ?? 'unknown',
    origin_peer_id: getPeerId(),
    kind: write.kind,
    content: write.content,
    topics: write.topics,
  });

  try {
    // No L2 row here: L2 rows carry an embedding, and loading the embedding
    // model in a short-lived CLI process would cost seconds per write. The
    // daemon owns embedding — it indexes this row into L2 on its next start.
    enqueueL1Outbox(getCortexDb(safeCortex), id, JSON.stringify(entry), ts);
  } finally {
    // One-shot CLI write: close the handle so WAL contents are visible to the
    // daemon process that will drain this row.
    closeCortexDb(safeCortex);
  }

  process.stderr.write(chalk.dim(DAEMON_DOWN_NOTE));

  return { id, ts };
}
