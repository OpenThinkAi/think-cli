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

**v1 carries memory lines only.** There is no separate write-tier kind to carry —
that write tier was removed in `3.0.0`, and even before that, its entries never
synced (enforced contract). Long-term events and retros ride their own push/pull paths
in the git/fs adapters and are explicitly out of scope here; they can be added
as parallel line-kinds in a later revision without changing the cursor
mechanics below.

## Invariants inherited from the data model

- **Memory ids are content-derived.** `id = deterministicId(ts, author,
  content)`. There is no last-writer-wins; dedup is `INSERT OR IGNORE` on `id`.
- **Memory lines are immutable via sync.** A line's fields never change and
  the push/pull line shape has no `deleted_at`. Removal travels separately, as
  a memory tombstone on its own route pair — see [Tombstones](#tombstones).
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

**`author` is not authenticated.** Each line's `author` field is supplied by the
pushing client and the single-tenant `think serve` hub stores it as given: any
holder of the shared token can push lines under any author name. Treat
`author` as a label, not an identity, on a single-tenant hub. A multi-tenant hub
must bind `author` to the seat the bearer token resolves to (reject or overwrite
a mismatching value) rather than trusting the client.

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
(removal is a [tombstone](#tombstones), not a line field), no `server_seq`
(server assigns it).

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

## Tombstones

> Added in 3.3.0 (AGT-2331). An optional, additive extension: a hub or client
> without it keeps working against one that has it.

`think forget <id>` removes a memory everywhere it is indexed. Over the hub it
travels as a **memory tombstone** on its own route, `/v1/cortex-sync/tombstones`
(`TOMBSTONES_ROUTE`), never inside push/pull `lines`:

**Push** — `POST /v1/cortex-sync/tombstones`, bearer auth as above:

```jsonc
{
  "cortex": "team-shared",
  "tombstones": [
    {
      "ids": ["0193…local-id", "5f1c…content-derived-id"],
      "ts": "2026-11-19T12:00:00Z",       // forget time
      "author": "matt",                    // optional, label only
      "origin_peer_id": "peer-1"           // optional
    }
  ]
}
```

Response: `{ "accepted": 1, "duplicates": 0, "removedLines": 1 }`.

`ids` lists every id the memory may be stored under (1–16 entries): the
forgetting peer's own row id and the content-derived
`deterministicId(ts, author, content)` that the hub and the git/fs adapters key
on. A tombstone carries no content. The hub:

1. deletes every stored line in the cortex whose id is listed;
2. records the ids, so a later push of the same line returns `duplicate` and
   stores nothing;
3. stamps the tombstone with the next `server_seq`. Lines and tombstones share
   one per-cortex sequence space, so deleting the newest line can never let a
   later line reuse a `server_seq` that a client has already advanced past.

A tombstone whose ids are all already recorded is a `duplicate` and changes
nothing, so pushes stay replay-safe.

**Pull** — `GET /v1/cortex-sync/tombstones?cortex=&cursor=&limit=`, the same
query rules and pagination as line pull, returning
`{ "tombstones": [{ "ids", "ts", "author"?, "origin_peer_id"?, "server_seq" }], "nextCursor", "hasMore" }`.
The client keeps a separate cursor, `sync_cursors(backend='hub',
direction='pull_tombstones')`, pulls tombstones before lines, and applies each
one by deleting the matching local rows and recording the ids so no sync path
re-ingests them.

**Compatibility.**

- An older client never calls the tombstone routes, so its strict line schema
  never meets an unknown shape. It keeps any copy it already pulled; a fresh
  pull no longer returns the deleted line.
- A newer client against an older hub (a `think serve` before 3.3.0, or the
  hosted think-hub until it adds these routes) gets `404`/`405`. Pull skips
  tombstones silently. Push reports `hub does not support memory tombstones
  yet` in the sync errors and leaves the tombstone queued (its push cursor,
  `direction='push_tombstones'`, does not advance), so it goes out once the hub
  is upgraded.

### Tombstones in L1 and the git/fs adapters

Outside the hub, a tombstone is a JSONL line of `kind: "tombstone"` in the same
files memories live in: the daemon writes it to L1 through the outbox (so it
reaches the git remote and survives `think reindex`), and the local-fs adapter
appends it to the peer's bucket file.

```jsonc
{"kind":"tombstone","id":"<own id>","ids":["<own id>","<content-derived id>"],
 "ts":"…","author":"matt","origin_peer_id":"peer-1",
 "content":"[forgotten]","deleted_at":"…","tombstone_reason":"forget",
 "source_ids":[],"topics":[],"supersedes":[],"compacted_from":null}
```

The fixed `content` placeholder and `deleted_at` are there for peers older than
3.3.0, which don't know the kind: their daemon treats the line as a soft-delete
of `id` and hides the row from recall, and their adapters, reindex and
compaction backfill skip any line with `deleted_at`. Nothing errors. Such a peer
keeps the text in its index until it upgrades and runs `think reindex`.

Peers on 3.3.0 or later apply the line wherever they read it (daemon pull loop,
`think reindex`, git and local-fs adapter pull): delete the rows, their
embeddings and search-index entries, and record the ids in `memory_tombstones`.

Trust: a tombstone is accepted from anyone who can write to the sync surface,
the same as the existing soft-delete line.

### Forgetting a memory

`think forget <id>` (daemon required, like `think delete`):

- removes the entry's row from the local index: text, embedding, full-text
  index entry and compaction links (SQLite `secure_delete` is on for the
  delete; the WAL may hold old pages until its next checkpoint);
- drops the entry's line from the outbox if it was never pushed, so it never
  leaves the machine;
- queues the tombstone for every sync surface above;
- lists any compacted entries that summarise the forgotten one. Those are
  separate memories with their own text; forget them too if needed.

It does **not** rewrite history. The original line stays in the cortex's L1
JSONL files, in the git remote's history and in every clone, and in fs-synced
folders, until someone rewrites them by hand. To purge it from git, rewrite
the cortex branch (for example with `git filter-repo`, or by squashing the
branch into one fresh commit after removing the line), force-push, and have
every peer re-clone. Backups need the same treatment.

`think delete` is different: it is a soft delete (the row is hidden, not
removed) and its tombstone line repeats the entry's content. Use `think forget`
when the text itself must go.

## What this contract does NOT specify

These are downstream / server concerns intentionally left open so the contract
doesn't over-constrain the implementations:

- HTTP method/path shapes (AGT-572 owns routing; this doc only fixes the
  request/response *bodies*, the bearer header, and the cursor semantics).
- The storage schema and how `server_seq` is allocated in Postgres (AGT-571).
- Tenancy/authorization mapping from token → seat → cortex (think-hub).
- Long-term-event / retro line kinds over the hub (future revision).
- History purge on the hub's own backups or on git remotes (see
  [Forgetting a memory](#forgetting-a-memory)).
