# open-think-server

HTTP backend for the [open-think](https://www.npmjs.com/package/open-think) CLI. Run this when you have agents on deployed services that need to sync cortex memories without git credentials or a working tree — they hold a single URL and a bearer token instead.

## What it stores

One Postgres table of memories, scoped by cortex name. **No engrams** — those are local-only on the developer machine and never sync. The server is intentionally minimal: bulk upserts in, paginated reads out, dedup by client-computed `id`.

## Quick start (local Docker)

```sh
docker compose up -d postgres
docker compose up server
# server listens on http://localhost:3000
```

The default `THINK_TOKEN` in `docker-compose.yml` is `dev-token-change-me`. Replace it before exposing the server to anything beyond your laptop.

## Running standalone

```sh
DATABASE_URL=postgres://user:pass@host:5432/db \
THINK_TOKEN=$(openssl rand -hex 32) \
PORT=3000 \
npx open-think-server
```

`DATABASE_URL` and `THINK_TOKEN` are required; the server exits on boot if either is missing. Schema is bootstrapped idempotently on each start.

## Endpoints

All endpoints except `/v1/health` require `Authorization: Bearer <THINK_TOKEN>`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/health` | Liveness probe (checks Postgres reachable). Unauthenticated. |
| `GET` | `/v1/cortex` | List all cortexes. |
| `POST` | `/v1/cortex` | Create a cortex. Idempotent. Body: `{ "name": "engineering" }`. |
| `POST` | `/v1/cortex/:name/memories` | Bulk-upsert memories. Idempotent on `(cortex, id)`; existing rows are never overwritten (memories are immutable per the SyncAdapter contract). Body: `{ "memories": [{ id, ts, author, content, source_ids, episode_key?, decisions? }] }`. Max 500 per request. |
| `GET` | `/v1/cortex/:name/memories?since=<server_seq>&limit=<n>` | Paginated pull. Returns memories with `server_seq > since`, ascending. Response includes `next_since` for the cursor. `limit` defaults to 500, max 1000. |

### Cursor format

`server_seq` is a non-negative integer encoded as a string (Postgres BIGSERIAL — the JSON-string encoding preserves precision past 2^53). Pass it back verbatim as `since=`. The wire format is stable for the v1 routes; a future cursor change would require a new route version.

## Deploying

### Railway

Railway has a Postgres add-on and reads `DATABASE_URL` automatically. After adding the Postgres plugin, set `THINK_TOKEN` in the service environment, point the build at this Dockerfile, and `npm start` is the run command. (Railway template config is on the roadmap.)

### Anywhere with Docker

Build:

```sh
docker build -f packages/server/Dockerfile -t open-think-server .
docker run -p 3000:3000 \
  -e DATABASE_URL=postgres://… \
  -e THINK_TOKEN=… \
  open-think-server
```

## Configuring the CLI to use it

This is the BLOOM-124 work (HttpSyncAdapter), not yet shipped. When it lands the flow will be:

```sh
think cortex setup --server https://think.mycorp.com --token <THINK_TOKEN> engineering
think sync "shipped the auth fix"
think cortex push
```

Until then, the server is reachable directly via `curl` for testing.

## Testing locally

```sh
docker compose up -d postgres
TEST_DATABASE_URL=postgres://think:think@localhost:5434/think npm test -w open-think-server
```

Port 5434 is the docker-compose default (chosen to avoid collisions with common dev Postgres setups on 5432 and 5433). Override with `THINK_PG_PORT=<port> docker compose up -d postgres` and matching `TEST_DATABASE_URL`.

Each test suite gets an isolated Postgres schema (`test_<random>`) that's dropped on teardown.
