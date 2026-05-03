# open-think-server

HTTP backend for the open-think CLI. Stores **events** fanned out from external sources (GitHub, Linear, Slack, ...) plus the **subscriptions** that describe what each local think install is watching. The CLI polls `/v1/events` to feed those events into its local engram pipeline; connectors (not in scope for this version) populate the `events` table.

This is the proxy-role rewrite the [think-cli v2 pivot](https://openthink.dev) called for. v0.2.0 retired the cortex storage role; **v0.3.0 lands the events + subscriptions surface**. The CLI-side connector glue and the per-source connectors themselves land in follow-up tickets (AGT-028+).

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/v1/health` | — | Liveness probe. Returns `{ "status": "ok", "version": "0.3.0" }`. **Process-reachable only**, no DB probe. |
| `GET` | `/v1/events` | Bearer | Read events for a subscription. Required `?subscription=<id>`; optional `?since=<server_seq>` (default `0`) and `?limit=<n>` (default `100`, max `1000`). Returns `{ events: [...], next_since }`. Updates `subscriptions.last_polled_at` as a side effect. |
| `POST` | `/v1/subscriptions` | Bearer | Create a subscription. Body `{ kind, pattern }`. Returns `201` with the assigned id. |
| `GET` | `/v1/subscriptions` | Bearer | List all subscriptions, ordered by `created_at`. |
| `GET` | `/v1/subscriptions/:id` | Bearer | Fetch one. `404` if unknown. |
| `DELETE` | `/v1/subscriptions/:id` | Bearer | Remove. Cascades to events for that subscription. `404` if unknown. |

Any other path returns a JSON 404 naming the served endpoints — operators upgrading from 0.1.x or 0.2.x get a clear pointer.

## Auth

`/v1/health` is unauthenticated so load-balancer probes work without credentials. Everything else requires `Authorization: Bearer <THINK_TOKEN>`. The server **fails to boot** if `THINK_TOKEN` is not set.

Comparison is constant-time (`crypto.timingSafeEqual`) — pick a long random token (32+ bytes recommended).

## Storage

Single SQLite file. Path configurable via `OPEN_THINK_DB_PATH` (default: `./open-think.sqlite` relative to the working directory). The file is created on first boot. Schema:

- `subscriptions(id TEXT PK, kind, pattern, created_at, last_polled_at)`
- `events(id, subscription_id, payload_json, server_seq INTEGER PK AUTOINCREMENT, created_at)` with `FOREIGN KEY (subscription_id) → subscriptions(id) ON DELETE CASCADE`

Cursor pagination uses `server_seq` as the monotonic cursor. Single-process / single-writer is by design (matches the v2 single-tenant decision); a multi-writer setup would need a separate sequence source.

## Running

```sh
THINK_TOKEN=<long-random-token> PORT=3000 npx open-think-server
```

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
