# open-think-server

HTTP backend for the open-think CLI. Stores **events** fanned out from external sources (GitHub, Linear, Slack, ...) plus the **subscriptions** that describe what each local think install is watching. The CLI polls `/v1/events` to feed those events into its local engram pipeline; in-process connectors (driven by a per-subscription scheduler) populate the `events` table.

This is the proxy-role rewrite the [think-cli v2 pivot](https://openthink.dev) called for. v0.2.0 retired the cortex storage role; v0.3.0 landed the events + subscriptions surface; v0.4.0 landed the poll-worker framework; **v0.5.0 lands the credential vault** (encrypted-at-rest source credentials, write-and-test surface only, never returned). The CLI-side connector glue and the per-source connectors beyond `mock` land in follow-up tickets.

## Endpoints

All success responses wrap the resource in an envelope (`{ subscription }`, `{ subscriptions }`, `{ events, next_since }`) so future metadata can land without breaking consumers. All error responses are `{ error: string, detail?: ... }`.

| Method | Path | Auth | Purpose | Success | Errors |
|---|---|---|---|---|---|
| `GET` | `/v1/health` | — | Liveness probe. **Process-reachable only**, no DB probe. | `200 { status, version }` | — |
| `GET` | `/v1/events` | Bearer | Read events for a subscription. Required `?subscription_id=<id>`; optional `?since=<server_seq>` (default `0`) and `?limit=<n>` (default `100`, max `1000`). Updates `subscriptions.last_polled_at` as a side effect. | `200 { events: [{ id, subscription_id, payload, server_seq, created_at }], next_since }`. **`next_since` is `null` when the page is empty** — retain your prior cursor and re-poll. | `400` invalid query (missing/invalid `subscription_id`, `since`, or `limit` over 1000); `404` unknown `subscription_id` (deliberate — saves you from polling a typo'd id forever) |
| `POST` | `/v1/subscriptions` | Bearer | Create a subscription. Body `{ kind, pattern }` — both trimmed, must be non-empty after trimming; **`kind` is not validated against an allowlist** (connectors define their own kinds, e.g. `github`, `linear`, `slack`). **No dedup** — POSTing the same `(kind, pattern)` twice yields two distinct subscriptions, each with its own cursor. Intentional for the fan-out model where each consumer owns its own poll position. Sets a `Location: /v1/subscriptions/{id}` header on the 201. | `201 { subscription: { id, kind, pattern, created_at, last_polled_at } }` | `400` with `error: "invalid json body"` (malformed/missing JSON) or `error: "invalid body"` (schema validation failed; `detail` carries Zod issues) |
| `GET` | `/v1/subscriptions` | Bearer | List all subscriptions, ordered by `created_at`. | `200 { subscriptions: [{ id, kind, pattern, created_at, last_polled_at }] }` | — |
| `GET` | `/v1/subscriptions/:id` | Bearer | Fetch one. | `200 { subscription: {...} }` | `404` unknown id |
| `DELETE` | `/v1/subscriptions/:id` | Bearer | Remove. Cascades to events **and stored credentials** for that subscription. | `204` | `404` unknown id |
| `PUT` | `/v1/subscriptions/:id/credential` | Bearer | Store (or rotate) the encrypted credential for a subscription. Body `{ credential: string }` (must be non-empty). Encrypted with AES-256-GCM and persisted to `source_credentials`. **Returns `204` with no body** so the response leaks nothing about whether this was a create vs update. | `204` | `400` invalid/empty body; `404` unknown subscription |
| `POST` | `/v1/subscriptions/:id/credential/test` | Bearer | Verify the stored credential by calling the connector's `verifyCredential`. Connector throws are caught and surfaced as `{ ok: false, detail: 'verify failed: ...' }` — the credential never escapes into a response or log. | `200 { ok: boolean, detail?: string }` | `404` unknown subscription **or** no credential stored (`{ error: 'no credential stored' }`); `501` connector has no `verifyCredential` |

Two non-route status codes are reachable:

- **`410 Gone`** for any `/v1/cortexes/*` path — the retired 0.1.x cortex storage routes. Returned **without auth** so operators upgrading from 0.1.x can see the migration pointer without configuring a token first. Body: `{ error: "cortex storage retired", detail: "..." }`.
- **`404 Not Found`** for any other unknown path on an authed call. Body lists the served endpoints. Unauthed callers hit the bearer middleware first and get `401` — set `THINK_TOKEN` if you're diagnosing.

## Auth

`/v1/health` is unauthenticated so load-balancer probes work without credentials. Everything else requires `Authorization: Bearer <THINK_TOKEN>`. The server **fails to boot** if `THINK_TOKEN` is not set.

Comparison is constant-time (`crypto.timingSafeEqual`) — pick a long random token (32+ bytes recommended).

## Storage

Single SQLite file. Path configurable via `THINK_DB_PATH` (default: `./open-think.sqlite` relative to the working directory). The file is created on first boot. Schema:

- `subscriptions(id TEXT PK, kind, pattern, created_at, last_polled_at, cursor)` — `cursor` is opaque per-connector JSON (TEXT) the framework persists verbatim; each connector picks its own shape.
- `events(id, subscription_id, payload_json, server_seq INTEGER PK AUTOINCREMENT, created_at)` with `FOREIGN KEY (subscription_id) → subscriptions(id) ON DELETE CASCADE` and `UNIQUE(subscription_id, id)` so `INSERT OR IGNORE` safely tolerates a connector replaying ids on transient errors.
- `source_credentials(subscription_id TEXT PK, ciphertext BLOB, nonce BLOB, created_at)` with the same FK cascade off `subscriptions(id)`. AES-256-GCM (12-byte nonce, 16-byte auth tag appended to `ciphertext`). One row per subscription; `PUT /v1/subscriptions/:id/credential` upserts.

Cursor pagination uses `server_seq` as the monotonic cursor. Single-process / single-writer is by design (matches the v2 single-tenant decision); a multi-writer setup would need a separate sequence source.

Event `payload` is **connector-defined** — the server stores `payload_json` opaquely and parses it back to JSON on read. No schema is enforced server-side; that responsibility lands with the connectors.

`subscriptions.last_polled_at` has two writers: the `GET /v1/events` read endpoint (so the connector knows someone is consuming) and the scheduler on every successful poll (so operators can see the source side is healthy too). Whichever is more recent wins — both are truthful "most recent activity" signals.

`subscriptions.cursor` was added in 0.4.0; existing 0.3.x DBs are migrated via an idempotent `ALTER TABLE ... ADD COLUMN` on first boot. The same boot also creates `events_sub_id_unique` via `CREATE UNIQUE INDEX IF NOT EXISTS` — this could in principle fail if a 0.3.x DB already contains duplicate `(subscription_id, id)` rows, but in practice 0.3.0 had no event-write path at all (events were only ever inserted by the tests' `:memory:` fixture), so any deployed 0.3.x DB has an empty `events` table and the index always lands cleanly.

`source_credentials` is new in 0.5.0; the table is created via `CREATE TABLE IF NOT EXISTS` on first boot, so the upgrade is silent for existing DBs.

## Running

```sh
THINK_TOKEN=<long-random-token> \
THINK_VAULT_KEY=<base64-32-byte-key> \
NODE_ENV=production \
PORT=3000 \
THINK_DB_PATH=./open-think.sqlite \
THINK_POLL_INTERVAL_SECONDS=600 \
  npx open-think-server
```

`THINK_TOKEN` is required; `THINK_VAULT_KEY` is required when `NODE_ENV=production` (see Credentials); `PORT` defaults to `3000`; `THINK_DB_PATH` defaults to `./open-think.sqlite` relative to the working directory; `THINK_POLL_INTERVAL_SECONDS` defaults to `600` (10 minutes). All `THINK_*` knobs share the `THINK_` prefix; `NODE_ENV` follows the standard Node convention.

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

## Polling

The server runs a per-subscription scheduler in-process. Every `THINK_POLL_INTERVAL_SECONDS` (default `600`) it iterates active subscriptions, looks up the registered connector for each `kind`, calls `connector.poll({ subscription, credential, cursor })`, and persists the returned events plus the new cursor in a single transaction. `last_polled_at` is bumped on success only — failures leave it untouched so it stays a truthful "last successful contact" signal.

Polls within a tick run **serially**: `node:sqlite` is `DatabaseSync` so JS-level parallelism doesn't help the writes, and per-source rate limits are per-credential so it doesn't help the source either. A wedged connector is bounded by a 60s per-poll timeout; failures are logged, recorded in the tick report, and don't propagate — the next tick retries the failed sub. A tick will not start while the previous tick is still running (overlap guard via `setTimeout`-recurse).

`subscriptions.last_polled_at` is bumped on poll success **and** on every `GET /v1/events` read (see Storage), so it's a "most recent activity" signal rather than a "last successful poll" signal — a recent CLI read keeps the timestamp fresh even if the scheduler-side poll has been failing. Failure-only diagnosis should consult the per-tick scheduler logs (and, eventually, a tick-report endpoint when one lands).

Registered connector kinds in 0.5.0:

- **`mock`** — synthetic event generator used by the e2e test. Pattern `"N"` where N is an integer ≥ 1 emits N events per poll with monotonic ids; anything else (non-integer, `"0"`, negatives, empty string) emits 1. Cursor is `{ count: number }`. Implements `verifyCredential` as a non-empty-string check so the credential-test endpoint has a kind to exercise without needing a live source.

The GitHub connector — first real-world target after `mock` — has a forward-looking design sketch at [`docs/design/connectors-github.md`](./docs/design/connectors-github.md), covering per-endpoint cursors, conditional-GET headers, rate-limit handling, and multi-endpoint fan-out. The live implementation lands in AGT-029+ alongside credential storage; until then `mock` is the only registered kind.

Read endpoints (`GET /v1/events`, `GET /v1/subscriptions/...`) are unchanged and unaware of the scheduler — connectors and consumers stay decoupled through the events table.

## Credentials

Connectors that hit external sources need credentials (GitHub PAT, Linear API key, etc.). 0.5.0 introduces a write-and-test surface for storing them encrypted at rest:

```sh
# Store (or rotate) a credential for a subscription.
curl -XPUT http://localhost:3000/v1/subscriptions/$SUB/credential \
  -H "Authorization: Bearer $THINK_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"credential":"ghp_..."}'
# → 204 No Content (no body, by design — leaks nothing about create vs update)

# Verify the stored credential against the source.
curl -XPOST http://localhost:3000/v1/subscriptions/$SUB/credential/test \
  -H "Authorization: Bearer $THINK_TOKEN"
# → 200 { "ok": true }   or  200 { "ok": false, "detail": "..." }
```

**No GET / list / read route exists.** Once stored, plaintext is reachable only inside the server process via the scheduler's per-poll lookup.

### Vault key

Encryption uses AES-256-GCM with a 32-byte key. Sourcing rules:

- **Production** (`NODE_ENV=production`): `THINK_VAULT_KEY` env var, base64-encoded 32-byte key. The server **refuses to boot** if the env var is unset under `NODE_ENV=production`.
- **Development** (`NODE_ENV` unset/`development`/`test`): the server generates a random 32-byte key on first boot and persists it to `~/.openthink/vault.key` with mode `0600`. Subsequent boots read the same file. Set `THINK_VAULT_KEY` only in production — setting it locally with the wrong shape will surface the env-path validation error rather than fall through to the dev file.

Generate a production key with:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

If the dev key file gets corrupted or rotates accidentally: delete `~/.openthink/vault.key` and restart — the server regenerates and re-`PUT` of every subscription's credential brings the DB back in sync.

For the threat model, key rotation story, and recovery story, see [`SECURITY.md`](./SECURITY.md) in this package.

## Testing

```sh
npm test -w open-think-server
```

No external dependencies — the suite stands up the Hono app in-process against a `:memory:` SQLite DB.
