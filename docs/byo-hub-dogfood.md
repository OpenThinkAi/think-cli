# BYO-hub dogfood check (AGT-574)

> Status: validation-plan step 1 for think-cloud — dogfood, not survey. Proves
> the OSS cortex-sync skeleton (AGT-570 protocol → AGT-571 store → AGT-572
> routes → AGT-573 hub adapter) end-to-end: two real peers converge a shared
> cortex through one self-hosted `think serve` hub, using only OSS think-cli
> and a static token. No think-hub, no Postgres.

## The repeatable check

The automated form lives at `packages/cli/scripts/e2e-byo-hub.ts` and runs
against the **built artifact** (`dist/index.js`), spawning real processes and
real HTTP:

```sh
cd packages/cli
bun run build     # or: npm run build
bun run e2e:hub   # or: npm run e2e:hub / npx tsx scripts/e2e-byo-hub.ts
```

What it does (and asserts):

1. Boots one self-hosted hub — `think serve` on a random localhost port with a
   static `THINK_TOKEN` and a throwaway sqlite (`THINK_DB_PATH`).
2. Creates two isolated peers: separate `THINK_HOME` dirs with distinct
   `peerId`s, each with `cortex.hub.url` + `cortex.hub.token` pointed at the
   hub (the AGT-573 adapter is selected only when BOTH are set).
3. Peer A `think memory add`s a sentinel memory and `think cortex sync`s it up;
   peer B syncs (pulls A's memory, pushes its own); peer A syncs again —
   convergence.
4. Asserts both peers `think recall` **both** memories (FTS path via
   `THINK_NO_EMBED=1`), and that the content-derived id of A's memory is
   identical on both peers (same memory, not a lookalike).
5. Asserts the hub actually mediated: an authenticated wire-level pull returns
   exactly the two lines, and a token-less pull is rejected `401`.

Exit 0 = pass. On failure the temp dir (hub sqlite + both peer homes) is kept
and its path printed.

## Running it across two real machines / accounts

The script's two `THINK_HOME`s simulate two accounts. To do it for real (e.g.
two Claude accounts on two machines, each with its own stamp/config keys), the
manual steps are the same flow:

1. **Host:** pick a static token and start the hub —
   `THINK_TOKEN=<token> THINK_DB_PATH=~/hub.sqlite PORT=4823 think serve`
   (set `THINK_VAULT_KEY` to a base64 32-byte key on a production host; expose
   the port however you like — LAN, Tailscale, a reverse proxy).
2. **Each peer:** in `~/.config/think/config.json` (or `$THINK_HOME/config/
   config.json`), set the hub backend on the shared cortex:

   ```json
   {
     "cortex": {
       "active": "<shared-cortex>",
       "author": "<who-you-are>",
       "hub": { "url": "http://<host>:4823", "token": "<token>" }
     }
   }
   ```

   Leave `cortex.fs` / `cortex.repo` unset — the registry prefers local
   backends over the hub, so a leftover fs/repo block would silently win.
3. **Peer A:** `think memory add "hello from A"` (auto-pushes) or
   `think cortex sync`.
4. **Peer B:** `think cortex sync`, then `think recall "hello from A"` — the
   memory synced by A is recallable on B. Reverse direction works the same.

The single `THINK_TOKEN` is transport auth for the whole (single-tenant) hub —
both peers share it. Per-seat tokens/tenancy are think-hub concerns, out of
scope for BYO-hub.
