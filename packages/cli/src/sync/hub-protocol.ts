/**
 * Cortex-sync hub wire protocol (think-cloud PSR-4).
 *
 * This module pins the **contract** for the authenticated `push`/`pull` wire
 * protocol between a `think` client (the future `hub` SyncAdapter, AGT-573) and
 * the hosted hub server (`think-hub`, AGT-571 store + AGT-572 routes). It is
 * deliberately implementation-free: no HTTP client, no server, no DB. It is the
 * single source of truth the three downstream tickets import and validate
 * against.
 *
 * See `docs/cortex-sync-protocol.md` for the prose spec and the rationale
 * behind every shape here. The narrative there is normative; this file is the
 * machine-checkable mirror of it.
 *
 * ---------------------------------------------------------------------------
 * Data-model invariants this protocol inherits from `types.ts`
 * ---------------------------------------------------------------------------
 *
 * - **Memory lines only.** The wire carries memory lines. Engrams never sync;
 *   long-term events and retros ride their own paths in the git/fs adapters and
 *   are out of scope for v1 of this hub protocol.
 * - **Content-derived ids → idempotent replay.** A memory's identity is
 *   `deterministicId(ts, author, content)`. Re-pushing an already-stored line
 *   is a no-op on the server (dedup via the content id), so a push is safely
 *   replayable. This is what makes AC4 (no duplicate / no reorder on replay)
 *   true by construction rather than by an at-most-once delivery guarantee.
 * - **Memories are immutable via sync.** No `deleted_at` is serialized or
 *   applied for memories. The wire line shape below therefore has no tombstone
 *   field — a deliberate omission, matching git/fs adapter serialization.
 * - **Two distinct cursors, do not conflate:**
 *     - `memories.sync_version` is the per-cortex **local push cursor**. It is
 *       NOT sent across the wire — the client uses it only to decide which
 *       local rows to include in the next push body.
 *     - `server_seq` is the **server-assigned, per-cortex pull cursor**. The
 *       server stamps every accepted line with a monotonic `server_seq`; the
 *       client persists the max it has consumed and sends it back as the pull
 *       cursor. See `docs/cortex-sync-protocol.md#server_seq`.
 *   Both cursors live client-side in `sync_cursors` keyed by `(backend,
 *   direction)` — the hub backend is just another `backend` value there.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Bearer auth (AC3)
// ---------------------------------------------------------------------------

/**
 * The HTTP header that carries the per-seat bearer token, matching the existing
 * single-tenant `think serve` convention (`THINK_TOKEN` + `bearerAuth()`
 * middleware). Every push/pull request MUST send `Authorization: Bearer
 * <token>`. The token is transport-level auth and is never part of the JSON
 * body — keep it out of request shapes so it can't accidentally be logged with
 * the payload.
 */
export const AUTH_HEADER = 'Authorization' as const;

/**
 * Guard a token against HTTP header injection. A CR or LF in a header value
 * lets a caller smuggle additional headers or split the response, so we reject
 * it at the point the header string is built rather than trusting callers.
 */
function assertHeaderSafeToken(token: string): void {
  if (/[\r\n]/.test(token)) {
    throw new Error('Bearer token must not contain CR or LF');
  }
}

/** Build the `Authorization` header value for a given bearer token. */
export function bearerHeader(token: string): string {
  assertHeaderSafeToken(token);
  return `Bearer ${token}`;
}

/**
 * Auth carried as a header pair. The wire contract models auth as a header, not
 * a body field — this type exists so the client adapter (AGT-573) and route
 * tests (AGT-572) share one representation of "the bearer header".
 */
export interface BearerAuthHeader {
  /** Always the literal `Authorization`. */
  readonly name: typeof AUTH_HEADER;
  /** The `Bearer <token>` value. */
  readonly value: `Bearer ${string}`;
}

/** Construct the typed {@link BearerAuthHeader} pair from a raw token. */
export function makeBearerAuthHeader(token: string): BearerAuthHeader {
  assertHeaderSafeToken(token);
  return { name: AUTH_HEADER, value: `Bearer ${token}` };
}

// ---------------------------------------------------------------------------
// Cortex name (matches the existing `sanitizeName` invariant)
// ---------------------------------------------------------------------------

/**
 * Cortex-name validation, kept in lock-step with `lib/paths.ts#sanitizeName`
 * (the on-disk DB-path sanitizer). Allowed: alphanumerics, `-`, `_`, and `/`
 * (the latter lets cortex names mirror namespaced git refs like
 * `cortex/engineering`). Forbidden: leading/trailing `/`, and any `..`, `//`,
 * or `\\` (path-traversal). Pinning the constraint at the contract layer means
 * a malformed name is a `400` from schema validation rather than a silently
 * broken route path in AGT-572.
 *
 * Note `/` is intentionally a *legal* cortex char, so AGT-572's routes must
 * carry the cortex in the body or a catch-all path segment, not a single
 * `:cortex` param.
 */
export const cortexNameSchema = z
  .string()
  .min(1)
  .refine(
    (name) =>
      !/[\/\\.]{2}/.test(name) &&
      !/[^a-zA-Z0-9_\-/]/.test(name) &&
      !name.startsWith('/') &&
      !name.endsWith('/'),
    {
      message:
        'invalid cortex name: use only alphanumerics, hyphens, underscores, and forward slashes; ' +
        "no leading/trailing slash and no '..', '//', or '\\\\'",
    },
  );
export type CortexName = z.infer<typeof cortexNameSchema>;

// ---------------------------------------------------------------------------
// The wire memory line (matches git/fs adapter serialization exactly)
// ---------------------------------------------------------------------------

/**
 * A single memory line as it travels over the wire. This shape is intentionally
 * identical to what `GitSyncAdapter` / `LocalFsSyncAdapter` already serialize
 * (and what `parseMemoriesJsonl` consumes), so the hub adapter (AGT-573) reuses
 * the existing serializer/parser rather than inventing a divergent shape.
 *
 * Required fields mirror the always-emitted keys; optional fields mirror the
 * adapters' conditional spread (`...(m.episode_key ? {...} : {})`, etc.).
 *
 * Notably ABSENT, by design:
 *   - `id` — recomputed by the server/client as `deterministicId(ts, author,
 *     content)`; never trusted from the wire for memories.
 *   - `deleted_at` — memories are immutable via sync; tombstones are never
 *     serialized for memories.
 *   - `server_seq` — assigned by the server on pull responses, not part of the
 *     pushed line (see {@link StoredLine}).
 */
export const wireMemoryLineSchema = z.object({
  /** ISO-8601 timestamp; part of the content-derived id. */
  ts: z.string().min(1),
  /** Authoring identity (cortex author), part of the content-derived id. */
  author: z.string().min(1),
  /** The memory body, part of the content-derived id. */
  content: z.string().min(1),
  /** Source engram ids that produced this memory. Always present (may be []). */
  source_ids: z.array(z.string()),
  /**
   * L1 entry-kind discriminator. For the hub protocol this is always
   * `'memory'` — engrams/retros/events do not ride this path in v1.
   */
  kind: z.literal('memory'),
  /** Optional episode grouping key. */
  episode_key: z.string().min(1).optional(),
  /** Optional decision strings attached to the memory. */
  decisions: z.array(z.string()).optional(),
  /** Originating peer id; preserves cross-device attribution. */
  origin_peer_id: z.string().min(1).optional(),
});

/** A memory line as pushed by a client. */
export type WireMemoryLine = z.infer<typeof wireMemoryLineSchema>;

/**
 * A line as stored and returned by the hub: the wire line plus the
 * server-assigned `server_seq` and the resolved content-derived `id`. Pull
 * responses return these so the client can (a) ingest via `INSERT OR IGNORE`
 * keyed on `id`, and (b) advance its pull cursor to the max `server_seq`.
 */
export const storedLineSchema = wireMemoryLineSchema.extend({
  /**
   * Content-derived id (`deterministicId(ts, author, content)`). Returned for
   * convenience/auditing; the client MAY recompute and verify it.
   */
  id: z.string().min(1),
  /**
   * The server-assigned, per-cortex, strictly monotonic sequence number for
   * this line. The client's pull cursor is the max `server_seq` it has seen.
   */
  server_seq: z.number().int().positive(),
});

/** A line stored on the hub, carrying its `server_seq` and resolved id. */
export type StoredLine = z.infer<typeof storedLineSchema>;

// ---------------------------------------------------------------------------
// Cursor type
// ---------------------------------------------------------------------------

/**
 * The pull cursor: the highest `server_seq` the client has consumed for a
 * cortex. `0` (the default) means "from the beginning". Always an integer >= 0.
 * This is the value the client persists in `sync_cursors(backend='hub',
 * direction='pull')` and echoes back on the next pull.
 */
export const pullCursorSchema = z.number().int().min(0);
export type PullCursor = z.infer<typeof pullCursorSchema>;

// ---------------------------------------------------------------------------
// Pull cap (N) — a server-side concern with a documented default + max
// ---------------------------------------------------------------------------

/**
 * Default page size when the client does not specify `limit`. Mirrors the
 * existing `/v1/events` route convention (`EVENTS_DEFAULT_LIMIT`).
 */
export const PULL_DEFAULT_LIMIT = 100;

/**
 * Hard server-side ceiling on a single pull page. A client `limit` above this
 * is **rejected with a validation error** (an explicit `400`, not a silent
 * clamp) so the client learns it over-asked rather than quietly getting fewer
 * rows than requested. Mirrors `EVENTS_MAX_LIMIT`.
 */
export const PULL_MAX_LIMIT = 1000;

// ---------------------------------------------------------------------------
// PUSH (AC1, AC4)
// ---------------------------------------------------------------------------

/**
 * Push request body: a batch of memory lines to append to a cortex. The cortex
 * is identified in the request body (the route, AGT-572, MAY also accept it as
 * a path segment — that's a routing detail, not a contract detail). The bearer
 * token rides the `Authorization` header, never the body.
 */
export const pushRequestSchema = z.object({
  /** Target cortex name (see {@link cortexNameSchema}). */
  cortex: cortexNameSchema,
  /** The memory lines to append. May be empty (a no-op push). */
  lines: z.array(wireMemoryLineSchema),
});
export type PushRequest = z.infer<typeof pushRequestSchema>;

/**
 * Per-line push outcome. `accepted` means the line was newly stored and
 * assigned `server_seq`; `duplicate` means a line with the same content-derived
 * id already existed (idempotent replay — AC4) and `server_seq` is the
 * already-assigned value. Either way the client learns the authoritative
 * `server_seq` for the line.
 */
export const pushedLineResultSchema = z.object({
  /** Content-derived id of the line. */
  id: z.string().min(1),
  /** Server-assigned sequence for this line (new or pre-existing). */
  server_seq: z.number().int().positive(),
  /** Whether this push call was the one that stored the line. */
  status: z.enum(['accepted', 'duplicate']),
});
export type PushedLineResult = z.infer<typeof pushedLineResultSchema>;

/**
 * Push response: the per-line results (in request order) plus the cortex's
 * current max `server_seq` after applying the batch. Clients do NOT advance
 * their pull cursor from a push response — pull is the only cursor authority —
 * but `maxServerSeq` is returned for observability/debugging.
 */
export const pushResponseSchema = z.object({
  /** One entry per pushed line, in the same order as the request. */
  results: z.array(pushedLineResultSchema),
  /** Count newly stored on this call (status === 'accepted'). */
  accepted: z.number().int().min(0),
  /** Count already present (status === 'duplicate'). */
  duplicates: z.number().int().min(0),
  /**
   * The cortex's highest `server_seq` after this push. `0` when the cortex has
   * no stored lines (including an empty / no-op push against an empty cortex) —
   * matching the `0` "from the beginning" sentinel used by the pull cursor.
   */
  maxServerSeq: z.number().int().min(0),
});
export type PushResponse = z.infer<typeof pushResponseSchema>;

// ---------------------------------------------------------------------------
// PULL (AC1, AC2)
// ---------------------------------------------------------------------------

/**
 * Pull request: return lines for `cortex` whose `server_seq > cursor`, ordered
 * by `server_seq` ascending, capped at `limit`. `cursor` defaults to 0 (from
 * the beginning); `limit` defaults to {@link PULL_DEFAULT_LIMIT} and is capped
 * at {@link PULL_MAX_LIMIT}.
 *
 * In the HTTP routes these map to query params (`?cortex=&cursor=&limit=`),
 * matching the `/v1/events` precedent. `z.coerce.number()` lets the route parse
 * string query values directly against this schema.
 */
export const pullRequestSchema = z.object({
  /** Target cortex name (see {@link cortexNameSchema}). */
  cortex: cortexNameSchema,
  /** Return lines with `server_seq` strictly greater than this. Default 0. */
  cursor: z.coerce.number().int().min(0).default(0),
  /** Max lines to return this page. Default 100, hard max 1000. */
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PULL_MAX_LIMIT)
    .default(PULL_DEFAULT_LIMIT),
});
export type PullRequest = z.infer<typeof pullRequestSchema>;

/**
 * Pull response: the page of stored lines plus pagination metadata.
 *
 * Pagination contract (chosen deliberately — see
 * `docs/cortex-sync-protocol.md#pagination`):
 *   - `lines` are ordered by `server_seq` ASC.
 *   - `nextCursor` is the max `server_seq` in this page, or the request cursor
 *     unchanged when the page is empty. The client persists this and sends it
 *     as `cursor` on the next pull. Because `server_seq` is strictly monotonic
 *     and the query is `server_seq > cursor`, this can never re-deliver a line.
 *   - `hasMore` is true iff the page was full (`lines.length === limit`), i.e.
 *     there may be more lines past `nextCursor`. It is an explicit flag rather
 *     than forcing every caller to re-derive `count === limit`; the server is
 *     the authority on whether a fuller scan would have returned more.
 */
export const pullResponseSchema = z.object({
  /** The page of stored lines, ordered by `server_seq` ascending. */
  lines: z.array(storedLineSchema),
  /** The cursor to send on the next pull (max server_seq in page, or unchanged). */
  nextCursor: z.number().int().min(0),
  /** True iff this page was full and more lines may exist past `nextCursor`. */
  hasMore: z.boolean(),
});
export type PullResponse = z.infer<typeof pullResponseSchema>;
