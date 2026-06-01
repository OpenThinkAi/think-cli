/**
 * Proxy cortex-writer — AGT-384, think-proxy-events PE-04.
 *
 * Takes the segmentation curator's output (1..N memories per terminal
 * event — see AGT-383's `runTerminalEventCuration`) and appends each
 * memory as one JSONL line to the team cortex's L1 page. After the
 * append, the existing push-debouncer is notified so the change is
 * eventually committed and pushed to the team-shared cortex remote.
 *
 * The proxy is its own actor in the cortex: every memory it writes is
 * stamped with `author = "proxy"` and the persisted proxy peer-id (see
 * `getProxyPeerId` in `serve/peer-id.ts`). This is intentionally distinct
 * from per-machine memories written via `think log` / `think sync` —
 * those carry the user's per-machine peer-id and a human author name.
 *
 * Episode-grouping invariant: all memories produced from a single
 * terminal event share `episode_key = <event.id>` (more precisely
 * `event.episodeKey`, which the connector sets to a stable
 * source-specific id like `github:org/repo#536`). Sibling memories under
 * the same episode are NOT linked via `supersedes` — they are discrete
 * topical narratives of the same source event. Recall reconstructs the
 * full episode by grouping on `episode_key`.
 *
 * What this module does NOT do (intentional, out of scope for AGT-384):
 *   - It does not call the curator. The caller (AGT-386 smoke test or
 *     the eventual terminal-event ingest worker) is responsible for
 *     running the curator and passing the resulting `memories` array in.
 *   - It does not write to L2. Proxy memories land in the team-shared
 *     git-backed JSONL cortex (L1); the per-machine L2 SQLite index is
 *     populated on the consuming side when peers pull the cortex.
 *   - It does not resolve the proxy peer-id. Boot does that once via
 *     `getProxyPeerId(db, { override })` and passes the resolved value
 *     in here per call — matching the pattern documented in
 *     `serve/peer-id.ts:getProxyPeerId`.
 */

import type { DatabaseSync } from 'node:sqlite';
import { v7 as uuidv7 } from 'uuid';
import { enqueueL1Outbox } from '../lib/l1-page.js';
import { sanitizeName } from '../lib/paths.js';
import { getCortexDb } from '../db/engrams.js';
import { pushDebouncer } from '../daemon/push-debouncer.js';

/**
 * Subset of `EventInput` (from `serve/connectors/types.ts`, augmented in
 * AGT-381/382) that the writer actually consumes. Defined locally rather
 * than importing the canonical type so this module stays compilable on
 * branches where `EventInput` has not yet grown the `episodeKey` /
 * `terminal` fields — the wiring layer (AGT-386) bridges the canonical
 * type and this shape.
 */
export interface TerminalEventForWrite {
  /** Stable per-source event id (e.g. `github:org/repo#536`). */
  id: string;
  /**
   * Episode grouping key. Today this equals `id` in nearly all cases,
   * but it is kept as a separate field so future ingest paths (e.g.
   * meeting transcripts split across multiple uploads) can fan multiple
   * source events into one logical episode.
   */
  episodeKey: string;
}

/**
 * One memory produced by `runTerminalEventCuration` (AGT-383). Each
 * element becomes exactly one JSONL line in the team cortex.
 */
export interface CuratedMemory {
  content: string;
  topics: string[];
}

export interface WriteMemoriesForEventOptions {
  event: TerminalEventForWrite;
  memories: readonly CuratedMemory[];
  /**
   * Team cortex name (e.g. `anglepoint-team`). Validated via
   * `sanitizeName` — only `[A-Za-z0-9_-]` is accepted, matching the
   * existing daemon write paths.
   */
  cortexName: string;
  /**
   * Resolved proxy peer-id. Boot resolves this once via
   * `getProxyPeerId(db, ...)` and threads it through to every write site
   * — see the docstring on `getProxyPeerId` for the rationale (sqlite
   * read-per-write is correct but wasteful).
   */
  peerId: string;
  /**
   * Source artifact's real settle time (ISO-8601) — the PR merge/close,
   * release publish, or Slack thread time the connector supplied via
   * `EventInput.occurredAt`. When set, it becomes every written memory's
   * `ts`, so a historical backfill lands at each item's real chronological
   * position (recall weights recency by `ts`-derived sequence). When unset,
   * `ts` falls back to `now()` — the default for live ingestion and for any
   * event whose connector couldn't determine a clean date.
   */
  occurredAt?: string;
  /**
   * Test seam: override the timestamp on the written entries. Production
   * callers leave this unset and get `new Date().toISOString()`. Tests
   * use it to assert exact field values without relying on clock
   * proximity. NOTE: `occurredAt` takes precedence over this for the
   * memory `ts`; `now` is the fallback clock.
   */
  now?: () => string;
  /**
   * Test seam: override the JSONL sink. Production callers leave this unset
   * and each memory is enqueued to the cortex's `l1_outbox` for the push-
   * debouncer's plumbing drain (#70 Option B / AGT-458) — no worktree switch.
   * Unit tests pass a stub to capture the written objects without touching a
   * DB or the user's real `~/.think/repo`. When provided, this takes
   * precedence over the outbox enqueue.
   */
  appendFn?: (obj: Record<string, unknown>) => void;
  /**
   * Test seam: override the push-debouncer notify. Production callers
   * leave this unset and the module-level `pushDebouncer` singleton is
   * used. Tests use it to assert the debouncer was called without
   * spawning any real git subprocess.
   */
  notifyPush?: (cortex: string) => void;
}

/**
 * Shape of one JSONL line written to the team cortex. The field set is
 * exactly the AC #2 list from AGT-384 — no `kind`, no `decisions`, no
 * `deleted_at`. Downstream readers that need the v3 entry-model
 * placeholders (compaction, supersession) can default them at read time;
 * proxy-authored memories under the terminal-event model are immutable
 * by design and never participate in supersession chains.
 */
interface CortexJsonlLine {
  id: string;
  ts: string;
  author: 'proxy';
  origin_peer_id: string;
  episode_key: string;
  source_ids: string[];
  topics: string[];
  content: string;
  supersedes: never[];
  compacted_from: null;
}

/**
 * Result envelope: returns the ids of the written memories in the order
 * they were supplied. Useful for tests and for the AGT-386 wiring layer
 * if it ever wants to log which ids landed (e.g. for a per-event
 * ingest-receipt row).
 */
export interface WriteMemoriesResult {
  /** uuidv7 ids of the memories written, in input order. */
  ids: string[];
}

/**
 * Appends `memories` to the team cortex's active L1 page as one JSONL
 * line each, then notifies the push-debouncer.
 *
 * Behaviour:
 *   - One uuidv7 per memory; ids are guaranteed distinct (uuidv7 is
 *     monotonic per process).
 *   - All written entries share the same `ts` (the moment this function
 *     was called). Recall ordering within an episode falls back to the
 *     uuidv7 lexicographic order, which is also monotonic per process.
 *   - `episode_key = event.episodeKey` on every written line.
 *   - `source_ids = [event.id]` — a single-element array per the
 *     terminal-event model (one terminal event → N sibling memories all
 *     pointing back at the same event id).
 *   - `supersedes = []` and `compacted_from = null` — terminal-event
 *     memories are immutable siblings, never a chain.
 *   - The push-debouncer is notified exactly once per call regardless of
 *     how many memories were appended; debouncing coalesces bursts.
 *   - An empty `memories` array is a no-op (no writes, no notify, no
 *     throw). This keeps the wiring layer (AGT-386) free to call the
 *     writer unconditionally after curation without having to special-
 *     case zero-memory outputs.
 *
 * Validation:
 *   - `cortexName` is validated via `sanitizeName`. Invalid names throw
 *     synchronously (matching the rest of the daemon write paths).
 *   - `peerId` is rejected when empty/whitespace — a blank
 *     `origin_peer_id` would silently break audit and recall hits.
 *
 * Failure model:
 *   - The outbox enqueue for all memories runs in one SQLite transaction, so a
 *     throw mid-fan-out rolls back every row (no partial episode). DB errors
 *     propagate synchronously. A retried invocation produces *new* sibling
 *     memories (new uuidv7s) under the same `episode_key`, a harmless
 *     duplication the consuming side dedups on read.
 */
export function writeMemoriesForEvent(
  opts: WriteMemoriesForEventOptions,
): WriteMemoriesResult {
  const { event, memories, cortexName, peerId } = opts;

  // --- validation ---
  const trimmedPeerId = peerId?.trim() ?? '';
  if (trimmedPeerId.length === 0) {
    throw new Error('writeMemoriesForEvent: peerId must be a non-empty string');
  }
  // sanitizeName throws on path-traversal / disallowed chars.
  const safeCortex = sanitizeName(cortexName);

  // Empty input → no-op. See docstring under "Behaviour".
  if (memories.length === 0) {
    return { ids: [] };
  }

  // --- write ---
  // Memory `ts` = the source artifact's real settle time when the connector
  // supplied one (`occurredAt`), else wall-clock insertion time. This is the
  // default-now-with-override contract: live ingestion stamps "now"; a
  // historical backfill stamps each item's real date so it lands at its true
  // chronological position instead of flooding recall's recent window.
  // (Recall weights recency by a `ts`-derived sequence position — see
  // daemon/recall.ts.)
  const now = (opts.now ?? (() => new Date().toISOString()))();
  // Validate the override is a parseable date before trusting it as `ts`.
  // The contract asks connectors to leave `occurredAt` unset for
  // garbage/ambiguous dates, but this guard enforces it rather than relying
  // on caller discipline: a non-parseable value (e.g. a bare epoch string or
  // a locale-formatted date a future connector might pass) falls back to
  // insertion time instead of corrupting recall ordering with a bad `ts`.
  const ts =
    opts.occurredAt !== undefined && Number.isFinite(Date.parse(opts.occurredAt))
      ? opts.occurredAt
      : now;
  // Each curated memory becomes one JSONL line. Production enqueues the line
  // to the cortex's `l1_outbox`; the push-debouncer's serialized drain appends
  // it to the cortex branch via git plumbing — never switching the shared
  // worktree, so a write for team-beta lands on team-beta even while the tree
  // sits on team-alpha (#70 Option B / AGT-458). Unit tests pass `appendFn` to
  // capture the objects without a DB.
  //
  // Bind the seam to a local so the production-vs-test branch is a single
  // `appendFn === undefined` check that TypeScript narrows cleanly (no
  // non-null assertions): when it's undefined we open `db`; otherwise we use
  // the captured `appendFn`.
  const { appendFn } = opts;
  const db = appendFn === undefined ? getCortexDb(safeCortex) : null;

  const ids: string[] = [];
  // When enqueuing for real, do it in one transaction so a mid-loop throw
  // doesn't leave a partial fan-out of sibling memories in the outbox.
  if (db) db.exec('BEGIN');
  try {
    for (const memory of memories) {
      const id = uuidv7();
      const entry: CortexJsonlLine = {
        id,
        ts,
        author: 'proxy',
        origin_peer_id: trimmedPeerId,
        episode_key: event.episodeKey,
        source_ids: [event.id],
        topics: memory.topics,
        content: memory.content,
        supersedes: [],
        compacted_from: null,
      };
      if (appendFn === undefined) {
        // Production path: db is non-null exactly when appendFn is undefined.
        enqueueL1Outbox(db as DatabaseSync, id, JSON.stringify(entry), ts);
      } else {
        appendFn(entry as unknown as Record<string, unknown>);
      }
      ids.push(id);
    }
    if (db) db.exec('COMMIT');
  } catch (err) {
    if (db) {
      try { db.exec('ROLLBACK'); } catch { /* best effort */ }
    }
    throw err;
  }

  // --- notify push-debouncer ---
  // One notify() per call: the debouncer coalesces bursts on its own, so
  // calling per-memory would only inflate the pending counter without
  // changing the eventual push behaviour. We notify after all appends so
  // a mid-loop throw above does not enqueue a push for a partial write
  // — the next successful call will pick that up.
  const notify = opts.notifyPush ?? ((cortex: string) => pushDebouncer.notify(cortex));
  notify(safeCortex);

  return { ids };
}
