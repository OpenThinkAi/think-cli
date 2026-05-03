# open-think-server

> **Paused.** The cortex storage role retired in AGT-026 as part of the [think-cli v2 pivot](https://openthink.dev) to a brain/nervous-system model where memories live in a local folder (see the local-fs adapter). The HTTP server's role is being rewritten as a **proxy for external event sources** (GitHub, Linear, Slack, etc.) rather than a memory backend. That work lands in AGT-027 (events + subscriptions surface) and AGT-030 (folds this package into `packages/cli/src/serve/` with a full README rewrite).

## What this version (0.2.0) actually does

The server boots, listens on `PORT` (default 3000), and exposes one endpoint:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/health` | Liveness probe. Always returns `{ "status": "ok" }` with HTTP 200 if the process is up. **No backing-store probe** — load balancers wired to this endpoint should know that "200 OK" now only means "the process is reachable", not "the data path is healthy". |

There is no bearer-auth middleware in 0.2.x — it retired alongside the routes it was protecting. AGT-027 lands the auth seam back when it adds events/subscriptions routes that need it. **`THINK_TOKEN` is no longer required at boot** in 0.2.x; if you had it set in your deployment environment from 0.1.x, you can remove it now or leave it in place (it is ignored).

Any request to a path other than `GET /v1/health` returns a JSON 404 naming the retired role and pointing at the migration path:

```json
{
  "error": "endpoint not found",
  "detail": "open-think-server 0.2.0 retired the cortex storage role (AGT-026); …"
}
```

## If you ran a previous version

`open-think-server@0.1.x` exposed `/v1/cortexes`, `/v1/cortexes/:name/memories`, and `/v1/cortexes/:name/long-term-events` against a Postgres backing store. **Every one of those endpoints returns 404 in 0.2.0.** There is no migration script — by design, since the v2 pivot moves cortex storage to a local folder on each peer rather than a shared server.

If you have data in a Postgres deployment you still need:

1. Keep the server pinned to `open-think-server@0.1.x` and running. **Do not upgrade it** until every peer has migrated — the migration tool pulls live from the running 0.1.x server.
2. On each peer, with `think cortex setup --server …` still configured, run `think cortex migrate --to fs --path <folder>`. The command pulls the latest from the live HttpSyncAdapter into local SQLite, then exports to the local folder and rewrites config to the fs backend.
3. Once every peer has migrated, retire the 0.1.x server.

If your 0.1.x server is already gone and you only have a `pg_dump` left, there's no first-class import path in the CLI today — file a `gh issue` against `OpenThinkAi/think-cli` describing your situation.

After upgrading, the `pgdata` Docker volume from the prior `docker-compose.yml` is orphaned. Clean it up with:

```sh
docker volume ls | grep pgdata
docker volume rm <project>_pgdata
```

## CLI compatibility

The CLI's `think cortex setup --server <url> --token <token>` flow targets the now-removed cortex-storage endpoints and **will fail with 404s** against any 0.2.x server. AGT-025 retires the `--server`/`--token` flags and the `HttpSyncAdapter` on the CLI side; until that lands, use the local-fs backend (`think cortex setup --fs <path>`) or a git remote (`think cortex setup <repo>`).

## Running

```sh
PORT=3000 npx open-think-server
```

Or via docker-compose at the repo root:

```sh
docker compose up server
```

## Testing

```sh
npm test -w open-think-server
```

No external dependencies — the test suite stands up the Hono app in-process and exercises the `/v1/health` response and the catch-all 404 body.
