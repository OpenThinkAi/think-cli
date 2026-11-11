# open-think-server (deprecated)

The proxy server folded into the [open-think](https://www.npmjs.com/package/open-think) CLI in v0.5.0. There is no separate `open-think-server` package anymore — running this binary prints a migration message and exits non-zero.

## Migration

Replace any deployment that ran `npx open-think-server` with:

```sh
npx open-think serve
```

or, after `npm install -g open-think@>=0.5.0`:

```sh
think serve
```

All env vars (`THINK_TOKEN`, `THINK_VAULT_KEY`, `PORT`, `THINK_DB_PATH`,
`THINK_POLL_INTERVAL_SECONDS`, `NODE_ENV`) carry over verbatim. The default
port changed from `3000` to `4823`; pass `PORT=3000` to keep the old
binding.

The Dockerfile moved from `packages/server/Dockerfile` to the repo root and
runs `node packages/cli/dist/index.js serve`. If you build images directly,
update the build context accordingly.

## Why is this still on npm?

So `npx open-think-server` doesn't silently fall through to a bygone
0.4.x copy and so a stale Railway/Render template fails loudly with the
correct migration pointer rather than running a months-old binary.

## Republishing this shim

This source lives in the `open-think` repo at
`scripts/deprecation-shim/open-think-server/`. To republish:

```sh
cd scripts/deprecation-shim/open-think-server
npm publish
npm deprecate open-think-server "Use 'open-think serve' from the open-think package instead"
```

The directory is intentionally outside the workspaces glob so the main
build doesn't pick it up.
