# `think serve` — security model

This document covers concerns specific to the `think serve` proxy subsystem (folded into the `open-think` CLI in v0.5.0; previously shipped as the standalone `open-think-server` package). The CLI's threat model lives at [`/SECURITY.md`](../../SECURITY.md) at the repo root; the two are intentionally separate as the proxy role grows.

For vulnerability disclosure, follow the root [`SECURITY.md`](../../SECURITY.md) — reports go to the same place regardless of which component is affected.

## Source credentials at rest (0.5.0)

`open-think-server` stores per-subscription credentials (GitHub PATs, Linear keys, etc.) so connectors can authenticate against external sources from the proxy. This is the new highest-value attack surface in v2 and is implemented deliberately.

### Storage shape

- One row per subscription in `source_credentials(subscription_id PRIMARY KEY, ciphertext BLOB, nonce BLOB, created_at)`.
- `ON DELETE CASCADE` from `subscriptions(id)` — credentials cannot outlive their subscription.
- Encryption: AES-256-GCM with a 12-byte nonce and the standard 16-byte authentication tag. The auth tag is appended to the ciphertext (so the column list matches `(ciphertext, nonce)` literally).
- A fresh nonce is generated per `encrypt` call. Nonce reuse under a single key would compromise confidentiality and integrity; the implementation derives every nonce from `crypto.randomBytes(12)`.

### What's protected

- **Confidentiality at rest.** A read-only attacker with the SQLite file but not the vault key cannot recover stored credentials.
- **Integrity at rest.** GCM's auth tag makes any tampering with the stored bytes detectable on the next decrypt — the row is rejected rather than silently producing a corrupted plaintext.

### What's not protected

- **An attacker with the vault key + the DB recovers everything.** This is unavoidable — they're the inputs to decrypt. The defense-in-depth is keeping the two on separate axes (env var on a managed host vs. SQLite on disk).
- **In-process state.** The server holds decrypted credentials briefly during each scheduler poll. An attacker with code execution inside the server process can read them out of memory. Out of scope; mitigated by treating the process as a hard trust boundary.
- **Logs and process listing.** Implementation never logs decrypted credentials, never echoes them in error messages, and never returns them on any HTTP route (write-and-test surface only — no GET, no list). This is enforced by the `tests/no-credential-leak.test.ts` route audit, which plants a known marker via `PUT` and asserts no response body across the route surface contains it.

### Threat model — endpoints

The credential surface is intentionally minimal:

- `PUT /v1/subscriptions/:id/credential` — accepts a plaintext credential, encrypts, upserts. Returns `204` with **no response body** so the response shape leaks nothing about whether the credential was newly created or rotated.
- `POST /v1/subscriptions/:id/credential/test` — invokes the connector's `verifyCredential` against the stored credential and returns `{ ok, detail? }`. Connector errors are caught at the route boundary and surfaced as `{ ok: false, detail: 'verify failed: <message>' }` — `verifyCredential` implementations are contractually forbidden from including the credential in `Error.message`, and the no-leak audit asserts the contract.
- **No `GET`, no list, no debug route.** Once stored, plaintext is reachable only from inside the server process via `vault.load()`.

Both routes require `Authorization: Bearer <THINK_TOKEN>` like the rest of the authed surface.

## Vault key

### Sourcing

- **Production**: `THINK_VAULT_KEY` env var, base64-encoded 32-byte key. The boot guard refuses to start with `NODE_ENV=production` if the env var is unset, so a misconfigured production deploy fails closed rather than silently using the dev path.
- **Development**: if the env var is unset and `NODE_ENV` is anything but `production`, the server generates a random 32-byte key on first boot and writes it to `~/.openthink/vault.key` with mode `0600`. Subsequent boots read the same file. This keeps a dev DB decryptable across restarts without forcing every contributor to mint a key.

To generate a production key:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

### Rotation

There is **no in-band key rotation in 0.5.0.** Stored credentials are encrypted under a single key; rotating that key requires re-encrypting every row. A `THINK_VAULT_KEY_NEXT` rolling-rotation flow is a future-ticket concern — it doesn't block any 0.5.0 use case because credentials are cheap to re-issue from the source.

If you need to rotate today: provision a new key, point `THINK_VAULT_KEY` at it, restart, and re-`PUT` every subscription's credential. Existing rows under the old key will fail to decrypt and the corresponding subscription's polls will surface a per-tick error (`vault.load` throws, scheduler isolates as a normal poll failure) until they're re-stored.

### Recovery — what happens if the key is lost

**The stored credentials are unrecoverable.** This is by design: an attacker with disk access and no key learns nothing.

**The user re-issues credentials at the source.** The proxy is a cache of credentials, not the source of truth — GitHub, Linear, etc. still hold the canonical token. Generating a fresh PAT and `PUT`-ing it to the new server is the standard recovery path, and it's the same path you'd take to rotate a leaked credential.

The takeaway: the vault key has the same recovery profile as a session secret, not a database backup. Treat it like a deployment secret, not a long-lived archive.

## Third-party content data flow (CLI-side redact)

The proxy server stores connector event payloads opaquely (`payload_json` in the `events` table) — it does not parse, validate, or redact them. **Redaction runs on the CLI side**, during `think subscribe poll`, before the payload lands as engram content (AGT-066). Two layers, in order:

1. **Baseline PII strip** (always on) — recursive walk that drops any field whose key matches the baseline patterns (`email`, `*_email`, `email_*`, `gpg`, `gpg_*`, `*_gpg`, `ip`, `*_ip`, `ip_*`, `x-real-ip`, `x-forwarded-for`, `client-ip`, `phone`, `*_phone`, `phone_*`). Case-insensitive on the standard hyphenated form for headers. Each PII category uses three suffix shapes (bare, `_x` suffix, `x_` prefix) — symmetry matters because the prefix shape (e.g. `phone_number`) is often the canonical field name in real payloads.

2. **Per-subscription redact selectors** (opt-in) — JSONPath-subset (`$.a.b.c` form only, no array indices/wildcards/filters/recursive descent). Configured via `think subscribe redact-set <id> <selector...>`; stored at `subscriptions.redact[<id>]` in `~/.config/think/config.json`.

The CLI also runs `validateEngramContent` inside `insertEngram` itself (AGT-059), so prompt-injection-pattern warnings and length-cap truncation apply to redacted-but-still-untrusted payloads. See [`docs/serve.md`](docs/serve.md#third-party-content-data-flow--redact-agt-066) for the full envelope and selector syntax.

**Caveat: redact runs CLI-side, not server-side.** If you operate a multi-tenant `think serve` proxy and don't trust that every CLI consumer enforces redaction, you should add connector-side egress filtering before the payload lands in the proxy's events table. The current architecture treats the proxy as a single-tenant deployment under the CLI operator's control.

## Scope of this document

This file covers the server's source-credential surface and the CLI-side redact layer that depends on it. Other server-side concerns (auth token comparison, SQLite file permissions, `/v1/cortexes/*` retirement semantics) are documented in code comments and [`packages/cli/docs/serve.md`](docs/serve.md). CLI threats (cortex sync, untrusted peer engrams, config tampering) live at the root [`SECURITY.md`](../../SECURITY.md).

Vulnerability disclosure: follow the root [`SECURITY.md`](../../SECURITY.md) reporting flow.
