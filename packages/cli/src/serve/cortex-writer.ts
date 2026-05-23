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

import path from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { appendToL1Page } from '../lib/l1-page.js';
import { getRepoPath, sanitizeName } from '../lib/paths.js';
import { ensureBranchCheckedOut } from '../lib/git.js';
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
   * Test seam: override the JSONL appender. Production callers leave
   * this unset and get `appendToL1Page`. Tests use it to redirect writes
   * to a tmp directory without touching the user's real `~/.think/repo`.
   */
  appendFn?: (cortexDir: string, obj: Record<string, unknown>) => void;
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
 *   - File-system I/O errors from `appendToL1Page` propagate up
 *     synchronously. There is no partial-write recovery: if the writer
 *     throws after appending memory[0] but before memory[1], the first
 *     line is persisted and the caller sees the throw. This matches the
 *     existing daemon sync handler's behaviour and is acceptable because
 *     the JSONL is append-only — a second invocation with the same
 *     event would produce *new* sibling memories (new uuidv7s) under the
 *     same `episode_key`, which is a harmless duplication that the
 *     consuming side dedups on read.
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
  const append = opts.appendFn ?? appendToL1Page;
  const cortexDir = path.join(getRepoPath(), safeCortex);
  // Switch the working tree to the team cortex's branch before appending.
  // The proxy serves multiple team cortices and may have written to a
  // different one earlier in the process lifetime; without this switch,
  // the lines would land on the previous cortex's branch.
  //
  // Skipped when callers inject an `appendFn` (the test seam). The seam
  // is the explicit opt-out from real-fs writes, and most callers passing
  // `appendFn` do not set THINK_HOME — they would otherwise reach into the
  // operator's real `~/.think/repo` looking for the cortex branch.
  if (opts.appendFn === undefined) {
    ensureBranchCheckedOut(safeCortex);
  }

  const ids: string[] = [];
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
    append(cortexDir, entry as unknown as Record<string, unknown>);
    ids.push(id);
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
