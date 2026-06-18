# Cortex-sync hub wire protocol

> Status: contract pinned (AGT-570). Implementation-free. The typed mirror of
> this spec lives in `packages/cli/src/sync/hub-protocol.ts`; that file and this
> doc move together. Downstream tickets — AGT-571 (hub store), AGT-572 (hub
> routes), AGT-573 (`hub` SyncAdapter client) — build against this contract.
>
> Lineage: think-cloud **PSR-4** ("No authenticated client sync path"). The hub
> adapter stays OSS (MIT) so BYO-hub works free; the proprietary hub server
> lives in the separate (private) `think-hub` repo, where the think-cloud
> project brief and Problem Statement Registry are maintained.

## Scope

This protocol defines the authenticated `push` and `pull` wire format between a
`think` client and a cortex hub. It is the third sync surface alongside the
git adapter (`git-adapter.ts`) and the local-fs adapter (`local-fs-adapter.ts`),
and it respects the same data-model invariants documented in
`packages/cli/src/sync/types.ts`.

**v1 carries memory lines only.** Engrams never sync (enforced contract).
Long-term events and retros ride their own push/pull paths in the git/fs
adapters and are explicitly out of scope here; they can be added as parallel
line-kinds in a later revision without changing the cursor mechanics below.

## Invariants inherited from the data model

- **Memory ids are content-derived.** `id = deterministicId(ts, author,
  content)`. There is no last-writer-wins; dedup is `INSERT OR IGNORE` on `id`.
- **Memories are immutable via sync.** `deleted_at` is never serialized or
  applied for memories — the wire line has no tombstone field.
- **`memories.sync_version` ≠ `server_seq`.** They are different cursors with
  different owners. See [Two cursors](#two-cursors).

## Auth

Every push and pull request carries a per-seat **bearer token** in the
`Authorization` header:

```
Authorization: Bearer <token>
```

This matches the existing single-tenant `think serve` convention: the server
reads a configured token and compares it (constant-time) against the presented
`Bearer <token>` value (`packages/cli/src/serve/middleware/auth.ts`,
`THINK_TOKEN`). The token is **transport-level** auth and is never part of the
JSON body, so it cannot be accidentally logged alongside a payload. In the
multi-tenant hub (AGT-572) the token resolves to a seat/membership; that
resolution is a server concern and does not change the wire shape.

A missing or malformed header → `401`. A well-formed but unauthorized token →
`401`/`403` (server's choice; not part of this contract).

## Two cursors

There are two monotonic counters in play. Conflating them is the most likely
implementation error, so they are spelled out:

| Cursor                  | Owner  | Scope          | On the wire? | Purpose                                              |
| ----------------------- | ------ | -------------- | ------------ | ---------------------------------------------------- |
| `memories.sync_version` | client | per-cortex     | **No**       | Local push cursor: which local rows to send next.    |
| `server_seq`            | server | per-cortex     | **Yes**      | Pull cursor: which stored lines the client has seen. |

The client persists both in its own `sync_cursors` table keyed by `(backend,
direction)` — the hub is just another `backend` value (e.g. `'hub'`), with
`direction` `'push'` (holds the local `sync_version` high-water mark) and
`'pull'` (holds the `server_seq` high-water mark).

## `server_seq` semantics

`server_seq` is a **strictly monotonic, per-cortex, server-assigned** integer.

- **Per-cortex.** Each cortex has its own independent sequence space. Sequences
  are not comparable across cortexes.
- **Server-assigned.** The client never sends `server_seq` on a pushed line; the
  server stamps it at store time. The client only ever *reads* `server_seq`
  (from pull responses, and informationally from push responses).
- **Strictly monotonic, assigned at accept time.** Each newly accepted line gets
  a `server_seq` strictly greater than every previously assigned one for that
  cortex. The ordering reflects the order the server accepted lines, which is
  the durable, total order all clients converge on.
- **Gap behavior.** `server_seq` is an ordering token, **not** a dense counter.
  Clients MUST NOT assume sequences are contiguous (no "I have 5, next must be
  6"). Gaps are permitted and expected (e.g. a rolled-back transaction may burn
  a value, or the server may allocate from a shared sequence). The only
  guarantees a client may rely on are: (a) strictly increasing, and (b) stable
  once assigned — a line's `server_seq` never changes. Therefore the correct
  cursor logic is always "give me everything with `server_seq > myCursor`",
  never arithmetic on the cursor value.

## Cortex names

The `cortex` field in both requests is validated by the same rules as the
on-disk path sanitizer (`lib/paths.ts#sanitizeName`): alphanumerics, `-`, `_`,
and `/` are allowed (`/` lets names mirror namespaced git refs such as
`cortex/engineering`); leading/trailing `/`, and any `..`, `//`, or `\\`
(path-traversal) are rejected with a `400`. Because `/` is legal, AGT-572's
routes must carry the cortex in the request body or a **catch-all** path segment
— not a single `:cortex` param that stops at the first slash.

## Push

Append a batch of memory lines to a cortex.

**Request** (`PushRequest`):

```jsonc
{
  "cortex": "team-shared",
  "lines": [
    {
      "ts": "2026-06-18T12:00:00Z",
      "author": "matt",
      "content": "Decided to ship the hub adapter as OSS.",
      "source_ids": ["eng_abc", "eng_def"],
      "kind": "memory",
      "episode_key": "think-cloud-psr4",   // optional
      "decisions": ["hub adapter stays MIT"], // optional
      "origin_peer_id": "peer-1"            // optional
    }
  ]
}
```

The line shape is **identical** to what the git/fs adapters already serialize
and what `parseMemoriesJsonl` consumes — the client reuses that serializer. Note
the deliberate omissions: no `id` (server derives it), no `deleted_at`
(memories are immutable via sync), no `server_seq` (server assigns it).

**Response** (`PushResponse`):

```jsonc
{
  "results": [
    { "id": "mem_…", "server_seq": 41, "status": "accepted" }
  ],
  "accepted": 1,
  "duplicates": 0,
  "maxServerSeq": 41
}
```

`results` is in request order. `status` is `"accepted"` if this call stored the
line, `"duplicate"` if a line with the same content-derived id already existed.
`maxServerSeq` is the cortex's high-water mark after the batch — returned for
observability only; clients **do not** advance their pull cursor from a push
response (pull is the sole cursor authority). For an empty / no-op push, or a
push against a cortex with no stored lines, `maxServerSeq` is `0` (matching the
`0` "from the beginning" sentinel the pull cursor uses).

## Pull

Return the next page of lines a client hasn't seen.

**Request** (`PullRequest`) — in the HTTP route these map to query params
(`?cortex=&cursor=&limit=`), matching the `/v1/events` precedent:

```
cortex   required   cortex name
cursor   optional   default 0; return lines with server_seq > cursor
limit    optional   default 100; hard max 1000 (a larger value is rejected)
```

**Response** (`PullResponse`):

```jsonc
{
  "lines": [
    {
      "id": "mem_…",
      "server_seq": 7,
      "ts": "2026-06-18T11:00:00Z",
      "author": "matt",
      "content": "…",
      "source_ids": [],
      "kind": "memory"
    }
  ],
  "nextCursor": 7,
  "hasMore": false
}
```

- `lines` are ordered by `server_seq` **ascending**, filtered to `server_seq >
  cursor`, capped at `limit`.
- The client ingests each line via `INSERT OR IGNORE` keyed on the
  content-derived `id` and advances its pull cursor to `nextCursor`.

### Pagination — `nextCursor` / `hasMore` <a id="pagination"></a>

The "next cursor / more remain" representation was chosen deliberately:

- **`nextCursor` = the max `server_seq` in the page**, or the request `cursor`
  unchanged when the page is empty. Because `server_seq` is strictly monotonic
  and the query is strictly `server_seq > cursor`, echoing `nextCursor` back can
  never re-deliver or skip a line — this is the whole reason the cursor is a
  `server_seq` and not an offset/page-number.
- **`hasMore` = `lines.length === limit`.** It is returned as an explicit
  boolean rather than forcing every client to re-derive `count === limit`. A
  full page means "there may be more past `nextCursor`; pull again." An empty or
  short page means "you are caught up." (`hasMore` may be a benign false
  positive when the total happens to be an exact multiple of `limit`: the next
  pull returns an empty page and resolves it. This is the standard limit-based
  pagination trade-off; the alternative — an extra count query per page — isn't
  worth it.)

### The cap `N` <a id="cap"></a>

`N` (the page cap) is a **server-side concern**:

- Default page size: **100** (`PULL_DEFAULT_LIMIT`), matching `/v1/events`.
- Hard maximum: **1000** (`PULL_MAX_LIMIT`). A client `limit` above the max is
  rejected by the request schema (an explicit `400`, not a silent clamp), so
  clients learn they over-asked rather than silently getting fewer rows than
  requested.

## Idempotency & ordering guarantees (AC4)

- **Replay-safe pushes.** Because a line's identity is content-derived
  (`deterministicId(ts, author, content)`), re-pushing an already-stored line is
  a no-op: the server returns `status: "duplicate"` with the line's existing
  `server_seq` and stores nothing new. A client that times out mid-push and
  retries the same batch therefore **cannot create duplicates** — there is no
  at-least-once vs at-most-once subtlety to reason about, the content id makes
  the operation idempotent at the data level.
- **No reordering on replay.** A line's `server_seq` is assigned **once**, at
  first accept, and never changes. Replaying a push does not re-stamp or move a
  line in the sequence. Consequently the pull order is stable across replays:
  two clients that pull the same cortex see the same lines in the same
  `server_seq` order regardless of who pushed (or re-pushed) what.
- **Convergence.** All peers ingest the same content-keyed rows via `INSERT OR
  IGNORE`; local insertion order doesn't matter because there is no LWW and no
  mutable memory state. Every peer's local cortex converges to the same memory
  set.

## What this contract does NOT specify

These are downstream / server concerns intentionally left open so the contract
doesn't over-constrain the implementations:

- HTTP method/path shapes (AGT-572 owns routing; this doc only fixes the
  request/response *bodies*, the bearer header, and the cursor semantics).
- The storage schema and how `server_seq` is allocated in Postgres (AGT-571).
- Tenancy/authorization mapping from token → seat → cortex (think-hub).
- Long-term-event / retro line kinds over the hub (future revision).
