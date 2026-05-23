/**
 * Terminal-event curation pipeline — AGT-386, think-proxy-events PE-06.
 *
 * Wires the Phase 1 foundation together end-to-end:
 *
 *     events row ─► bridge to TerminalEventInput
 *                  ─► runTerminalEventCuration (LLM segmentation)
 *                  ─► writeMemoriesForEvent (JSONL append + push-debouncer)
 *                  ─► UPDATE events.curated_at
 *
 * This module is the single seam that connects the segmentation curator
 * (`lib/curator.ts`) and the cortex-writer (`serve/cortex-writer.ts`) so
 * neither has to know about the other or about the events table. A future
 * orchestrator (the eventual "ingest worker" or a scheduler post-step)
 * will iterate uncurated events from the events table and call
 * `processTerminalEvent` per row.
 *
 * Dedup model:
 *   Re-emitting the same `(connector, event.id)` from the source side is
 *   already absorbed by the events table's `UNIQUE(subscription_id, id)`
 *   index — the second emission `INSERT OR IGNORE`s into the existing row.
 *   This module's job is the SECOND tier of dedup: a single events row
 *   must only be curated once. We use `events.curated_at` as the flag —
 *   `NULL` means uncurated, an ISO timestamp means already processed.
 *   Re-invoking `processTerminalEvent` on a row that has already been
 *   curated is a no-op (status `"already-curated"`, no LLM call, no
 *   cortex write, no push notify).
 *
 * Failure model:
 *   `runTerminalEventCuration` already retries malformed LLM output once
 *   before throwing. If it ultimately throws, we propagate — the caller
 *   logs and the curated_at column stays NULL so the next pass retries.
 *   `writeMemoriesForEvent` is synchronous and throws on filesystem
 *   errors; we let those propagate too for the same reason.
 *
 *   IMPORTANT: we mark `curated_at` only AFTER the cortex-writer succeeds.
 *   A throw between the curator call and the cortex write means we'll
 *   re-curate on the next pass — burning one additional LLM call. This
 *   is acceptable for v1; a future optimization could log the curator
 *   output to a "pending writes" table and resume from there. For now,
 *   the simpler at-most-once-curation discipline is to atomically
 *   bracket "curator succeeded AND writer succeeded" with the mark.
 */

import type { Database } from './db.js';
import { runTerminalEventCuration, type TerminalEventInput } from '../lib/curator.js';
import {
  writeMemoriesForEvent,
  type WriteMemoriesForEventOptions,
} from './cortex-writer.js';

/**
 * Shape of an `events` row as it sits in the proxy database. Mirrors the
 * columns the scheduler writes (see `serve/db/schema.ts`). Defined locally
 * rather than imported from a shared types module because this is the
 * first consumer that reads the row holistically — other read paths today
 * pick out specific columns (e.g. `GET /v1/events` projects payload_json
 * out of the row).
 */
export interface EventRow {
  id: string;
  subscription_id: string;
  payload_json: string;
  episode_key: string;
  created_at: string;
  curated_at: string | null;
  /**
   * Source artifact's real settle time (PR merge/close, release publish,
   * Slack thread root), as supplied by the connector. `null` when the
   * connector couldn't determine a clean date — the cortex-writer then
   * falls back to wall-clock time. Becomes the curated memory's `ts`.
   */
  occurred_at: string | null;
}

export interface ProcessTerminalEventOptions {
  db: Database;
  /**
   * The event row to curate. The caller is responsible for fetching this
   * — typically by querying `events WHERE curated_at IS NULL` in the
   * scheduler post-step or via a dedicated worker loop.
   */
  event: EventRow;
  /**
   * Resolved proxy peer-id (from `getProxyPeerId`). Threaded through to
   * the cortex-writer's `peerId` field so every memory written under this
   * event carries the proxy's stable identity. Boot resolves this once
   * and the same string flows through every call.
   */
  peerId: string;
  /**
   * Team cortex name (e.g. `anglepoint-team`). Decision PE-00 hasn't
   * landed yet, so for Phase 1 the caller supplies it directly — the
   * smoke test passes a fixed `anglepoint-team`. Once PE-00 lands this
   * will read from a config/kv source instead.
   */
  cortexName: string;
  /**
   * Source-tag seed for the curator's prompt (e.g. `["github", "pull-request"]`).
   * Defaults to `[<connector kind from subscription>]` if the caller doesn't
   * pass one; the wiring layer can't know richer tags without reading the
   * subscription row, which we leave as a refinement for the GitHub/Linear
   * connector tickets (PE-07+).
   */
  sourceTags?: string[];
  /**
   * Test seam: override `runTerminalEventCuration` so tests can return
   * deterministic memories without hitting the SDK. Production callers
   * leave this unset.
   */
  curate?: typeof runTerminalEventCuration;
  /**
   * Test seam: override `writeMemoriesForEvent`. Tests typically don't
   * use this — they prefer the existing `appendFn`/`notifyPush` seams on
   * the cortex-writer call — but it's available for tests that want to
   * skip the writer entirely.
   */
  writeMemories?: typeof writeMemoriesForEvent;
  /**
   * Test seams forwarded to `writeMemoriesForEvent`. Production callers
   * leave both unset. The cortex-writer has its own seams (`appendFn`,
   * `notifyPush`); we surface them here so the smoke test can avoid
   * touching the real filesystem and skip the push-debouncer.
   */
  appendFn?: WriteMemoriesForEventOptions['appendFn'];
  notifyPush?: WriteMemoriesForEventOptions['notifyPush'];
  /**
   * Test seam: override the timestamp persisted to `events.curated_at`.
   * Production callers leave this unset and get `new Date().toISOString()`.
   */
  now?: () => string;
}

export type ProcessTerminalEventOutcome =
  | { status: 'already-curated'; ids: never[] }
  | { status: 'curated'; ids: string[] };

/**
 * Best-effort title extraction from the events table's payload_json.
 *
 * The mock connector stores a plain object `{ seq, subscription_id }`;
 * real connectors will store richer structured fields (PR title, ticket
 * title, meeting subject). We probe a small set of common field names
 * — `title`, `subject`, `name` — and surface the first one that exists
 * and is a non-empty string. Anything else returns `undefined`, and the
 * curator prompt simply omits the title line.
 *
 * Kept lenient on purpose: a malformed payload, an unexpected JSON shape,
 * or a non-string title field shouldn't break the pipeline. The payload
 * itself is the curator's primary input; the title is a framing nicety.
 */
function extractTitle(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const obj = payload as Record<string, unknown>;
  for (const key of ['title', 'subject', 'name'] as const) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim().length > 0) {
      return v;
    }
  }
  return undefined;
}

/**
 * Flatten the events row's payload_json into the string the curator will
 * segment. The shape varies per connector, so we do the safest thing: if
 * the JSON parses, JSON.stringify it back with 2-space indent for
 * readability inside the LLM prompt; if it doesn't parse (corrupted row
 * or a connector that stored a raw string), surface the raw text.
 *
 * The curator wraps this in `<data>` tags in its prompt assembly, so it
 * doesn't matter whether the payload looks like JSON or prose — the
 * curator treats it as opaque source material either way.
 */
function flattenPayload(payloadJson: string): { payload: string; parsed: unknown } {
  try {
    const parsed = JSON.parse(payloadJson);
    return { payload: JSON.stringify(parsed, null, 2), parsed };
  } catch {
    return { payload: payloadJson, parsed: null };
  }
}

/**
 * Look up the connector kind for an event's subscription, used to seed
 * `sourceTags` when the caller doesn't supply one. A missing row returns
 * `null` — this only happens if the subscription was deleted after the
 * event was emitted, which the FK cascade should prevent but we guard
 * anyway.
 */
function lookupConnectorKind(db: Database, subscriptionId: string): string | null {
  const row = db
    .prepare('SELECT kind FROM subscriptions WHERE id = ?')
    .get(subscriptionId) as { kind: string } | undefined;
  return row?.kind ?? null;
}

/**
 * Mark an event as curated. Uses a guarded UPDATE so a concurrent caller
 * (e.g. two pipeline passes racing on the same row) can't both succeed —
 * the second `UPDATE ... WHERE curated_at IS NULL` matches zero rows and
 * the caller backs out.
 *
 * Returns true on success (the calling pass owns the curation), false
 * if another pass got there first. The first-line dedup check earlier
 * in `processTerminalEvent` catches the common case; this is the
 * defense-in-depth check at the moment of write.
 */
function markCurated(db: Database, eventRowKey: { id: string; subscription_id: string }, ts: string): boolean {
  const r = db
    .prepare(
      'UPDATE events SET curated_at = ? WHERE id = ? AND subscription_id = ? AND curated_at IS NULL',
    )
    .run(ts, eventRowKey.id, eventRowKey.subscription_id);
  return r.changes > 0;
}

/**
 * Run the full curate→write→mark pipeline for one terminal event.
 *
 * Returns:
 *   - `{ status: 'already-curated', ids: [] }` when `event.curated_at`
 *     is already set on input. No LLM call, no cortex write, no notify.
 *   - `{ status: 'curated', ids: [...] }` on success. `ids` are the uuidv7
 *     ids of the memories written, in order.
 *
 * Throws on curator error, cortex-writer error, or invalid input. The
 * caller is responsible for catching and logging — keeping the throw at
 * the boundary lets the scheduler post-step record it as a per-event
 * failure without changing the function's success contract.
 */
export async function processTerminalEvent(
  opts: ProcessTerminalEventOptions,
): Promise<ProcessTerminalEventOutcome> {
  const { db, event, peerId, cortexName } = opts;

  // Fast-path dedup: input row already has curated_at set. Skip every
  // downstream step. Callers usually filter at the SQL level (`WHERE
  // curated_at IS NULL`) but a stale read or a programmatic re-pass
  // could still land here, so we guard.
  if (event.curated_at !== null) {
    return { status: 'already-curated', ids: [] };
  }

  // Bridge: events row → TerminalEventInput.
  const { payload, parsed } = flattenPayload(event.payload_json);
  const title = extractTitle(parsed);
  const terminalInput: TerminalEventInput = {
    id: event.id,
    payload,
  };
  if (title !== undefined) {
    terminalInput.title = title;
  }

  const sourceTags =
    opts.sourceTags ?? (() => {
      const kind = lookupConnectorKind(db, event.subscription_id);
      return kind ? [kind] : undefined;
    })();

  // Curate.
  const curate = opts.curate ?? runTerminalEventCuration;
  const result = await curate({
    event: terminalInput,
    episodeKey: event.episode_key,
    sourceTags,
  });

  // Write to cortex JSONL + notify push-debouncer.
  const write = opts.writeMemories ?? writeMemoriesForEvent;
  const writeResult = write({
    event: { id: event.id, episodeKey: event.episode_key },
    memories: result.memories,
    cortexName,
    peerId,
    // Source settle time → memory `ts` (recall recency). `null`/undefined
    // makes the writer fall back to wall-clock insertion time.
    occurredAt: event.occurred_at ?? undefined,
    appendFn: opts.appendFn,
    notifyPush: opts.notifyPush,
  });

  // Mark curated. If the guarded UPDATE matches zero rows, a parallel
  // pass beat us to it — the memories have just been double-written.
  // This is a harmless duplication under the JSONL append-only model
  // (consumers dedup on read) but worth surfacing in logs. We don't
  // make it a hard error because the writes already happened; backing
  // out would require deleting JSONL lines we just appended, which we
  // can't do safely.
  const ts = (opts.now ?? (() => new Date().toISOString()))();
  const won = markCurated(
    db,
    { id: event.id, subscription_id: event.subscription_id },
    ts,
  );
  if (!won) {
    console.warn(
      `[open-think serve] processTerminalEvent: events.curated_at was already set on event_id=${event.id} subscription_id=${event.subscription_id} between dedup check and mark — duplicate memories may have been written`,
    );
  }

  return { status: 'curated', ids: writeResult.ids };
}

/**
 * Convenience helper: select all uncurated events for a subscription (or
 * across the whole table when omitted), ordered by `server_seq` so the
 * pipeline processes them in emission order. Exposed for the smoke test
 * and the future scheduler post-step; production callers may want a more
 * targeted query (e.g. limit + offset for batching).
 */
export function selectUncuratedEvents(
  db: Database,
  opts: { subscriptionId?: string; limit?: number } = {},
): EventRow[] {
  const limitClause = opts.limit !== undefined ? ` LIMIT ${Math.max(1, opts.limit | 0)}` : '';
  if (opts.subscriptionId !== undefined) {
    return db
      .prepare(
        `SELECT id, subscription_id, payload_json, episode_key, created_at, curated_at, occurred_at
           FROM events
          WHERE curated_at IS NULL AND subscription_id = ?
          ORDER BY server_seq ASC${limitClause}`,
      )
      .all(opts.subscriptionId) as unknown as EventRow[];
  }
  return db
    .prepare(
      `SELECT id, subscription_id, payload_json, episode_key, created_at, curated_at, occurred_at
         FROM events
        WHERE curated_at IS NULL
        ORDER BY server_seq ASC${limitClause}`,
    )
    .all() as unknown as EventRow[];
}
