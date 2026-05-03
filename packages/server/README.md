# open-think-server

HTTP backend for the open-think CLI. Stores **events** fanned out from external sources (GitHub, Linear, Slack, ...) plus the **subscriptions** that describe what each local think install is watching. The CLI polls `/v1/events` to feed those events into its local engram pipeline; connectors (not in scope for this version) populate the `events` table.

This is the proxy-role rewrite the [think-cli v2 pivot](https://openthink.dev) called for. v0.2.0 retired the cortex storage role; **v0.3.0 lands the events + subscriptions surface**. The CLI-side connector glue and the per-source connectors themselves land in follow-up tickets (AGT-028+).

## Endpoints

All success responses wrap the resource in an envelope (`{ subscription }`, `{ subscriptions }`, `{ events, next_since }`) so future metadata can land without breaking consumers. All error responses are `{ error: string, detail?: ... }`.

| Method | Path | Auth | Purpose | Success | Errors |
|---|---|---|---|---|---|
| `GET` | `/v1/health` | — | Liveness probe. **Process-reachable only**, no DB probe. | `200 { status, version }` | — |
| `GET` | `/v1/events` | Bearer | Read events for a subscription. Required `?subscription_id=<id>`; optional `?since=<server_seq>` (default `0`) and `?limit=<n>` (default `100`, max `1000`). Updates `subscriptions.last_polled_at` as a side effect. | `200 { events: [{ id, subscription_id, payload, server_seq, created_at }], next_since }`. **`next_since` is `null` when the page is empty** — retain your prior cursor and re-poll. | `400` invalid query (missing/invalid `subscription_id`, `since`, or `limit` over 1000); `404` unknown `subscription_id` (deliberate — saves you from polling a typo'd id forever) |
| `POST` | `/v1/subscriptions` | Bearer | Create a subscription. Body `{ kind, pattern }` — both trimmed, must be non-empty after trimming; **`kind` is not validated against an allowlist** (connectors define their own kinds, e.g. `github`, `linear`, `slack`). **No dedup** — POSTing the same `(kind, pattern)` twice yields two distinct subscriptions, each with its own cursor. Intentional for the fan-out model where each consumer owns its own poll position. Sets a `Location: /v1/subscriptions/{id}` header on the 201. | `201 { subscription: { id, kind, pattern, created_at, last_polled_at } }` | `400` with `error: "invalid json body"` (malformed/missing JSON) or `error: "invalid body"` (schema validation failed; `detail` carries Zod issues) |
| `GET` | `/v1/subscriptions` | Bearer | List all subscriptions, ordered by `created_at`. | `200 { subscriptions: [{ id, kind, pattern, created_at, last_polled_at }] }` | — |
| `GET` | `/v1/subscriptions/:id` | Bearer | Fetch one. | `200 { subscription: {...} }` | `404` unknown id |
| `DELETE` | `/v1/subscriptions/:id` | Bearer | Remove. Cascades to events for that subscription. | `204` | `404` unknown id |

Two non-route status codes are reachable:

- **`410 Gone`** for any `/v1/cortexes/*` path — the retired 0.1.x cortex storage routes. Returned **without auth** so operators upgrading from 0.1.x can see the migration pointer without configuring a token first. Body: `{ error: "cortex storage retired", detail: "..." }`.
- **`404 Not Found`** for any other unknown path on an authed call. Body lists the served endpoints. Unauthed callers hit the bearer middleware first and get `401` — set `THINK_TOKEN` if you're diagnosing.

## Auth

`/v1/health` is unauthenticated so load-balancer probes work without credentials. Everything else requires `Authorization: Bearer <THINK_TOKEN>`. The server **fails to boot** if `THINK_TOKEN` is not set.

Comparison is constant-time (`crypto.timingSafeEqual`) — pick a long random token (32+ bytes recommended).

## Storage

Single SQLite file. Path configurable via `THINK_DB_PATH` (default: `./open-think.sqlite` relative to the working directory). The file is created on first boot. Schema:

- `subscriptions(id TEXT PK, kind, pattern, created_at, last_polled_at)`
- `events(id, subscription_id, payload_json, server_seq INTEGER PK AUTOINCREMENT, created_at)` with `FOREIGN KEY (subscription_id) → subscriptions(id) ON DELETE CASCADE`

Cursor pagination uses `server_seq` as the monotonic cursor. Single-process / single-writer is by design (matches the v2 single-tenant decision); a multi-writer setup would need a separate sequence source.

Event `payload` is **connector-defined** — the server stores `payload_json` opaquely and parses it back to JSON on read. No schema is enforced server-side in 0.3.x; that responsibility lands with the connectors when they ship.

## Running

```sh
THINK_TOKEN=<long-random-token> \
PORT=3000 \
THINK_DB_PATH=./open-think.sqlite \
  npx open-think-server
```

`THINK_TOKEN` is required; `PORT` defaults to `3000`; `THINK_DB_PATH` defaults to `./open-think.sqlite` relative to the working directory. All env vars share the `THINK_` prefix.

Or via `docker-compose` at the repo root (set `THINK_TOKEN` in the environment first):

```sh
THINK_TOKEN=<...> docker compose up server
```

## If you ran a previous version

`open-think-server@0.1.x` exposed `/v1/cortexes/...` against a Postgres backing store. Those endpoints retired in 0.2.0 (AGT-026); they return 404 in 0.3.0. The migration path for any 0.1.x data is documented in the 0.2.0 README — keep 0.1.x running, run `think cortex migrate --to fs --path <folder>` on each peer, then retire the 0.1.x server. There is no first-class import from a `pg_dump` — file a `gh issue` against `OpenThinkAi/think-cli` if you need one.

The `pgdata` Docker volume from the 0.1.x `docker-compose.yml` is orphaned; clean it up with:

```sh
docker volume ls | grep pgdata
docker volume rm <project>_pgdata
```

## Testing

```sh
npm test -w open-think-server
```

No external dependencies — the suite stands up the Hono app in-process against a `:memory:` SQLite DB.
