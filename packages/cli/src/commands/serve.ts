import path from 'node:path';
import { Command } from 'commander';

/**
 * `think serve` boots the proxy that fans external events into engrams.
 *
 * The serve module (hono / @hono/node-server / zod / scheduler / vault)
 * is **lazy-imported** from inside the action handler so users who never
 * run `serve` don't pay the cold-start cost on hot paths like `think log`
 * and `think recall`. Bundle size still grows by the proxy's deps; only
 * startup latency for non-serve commands is protected.
 *
 * All knobs are env-driven (`THINK_TOKEN`, `THINK_VAULT_KEY`, `PORT`,
 * `THINK_DB_PATH`, `THINK_POLL_INTERVAL_SECONDS`, `NODE_ENV`) — that's
 * load-bearing for Railway / docker-compose deployments where flags don't
 * survive container restarts. Defaults: PORT=4823, poll=600s.
 *
 * One exception: `--peer-id <value>` (AGT-385) is a flag rather than an
 * env var because (a) the value is persisted to sqlite on first
 * presentation, so subsequent restarts without the flag still pick it up,
 * and (b) operators only set it once for a "fixed name" deployment — a
 * persistent env-var in compose config would conflict with the persisted
 * value on every restart.
 */
export const serveCommand = new Command('serve')
  .description('Boot the open-think proxy server (env-driven; see `docs/serve.md`)')
  .option(
    '--peer-id <value>',
    'Override the persisted proxy peer-id (one-time setter; the value is persisted to sqlite). For ' +
      'fixed-name deployments such as `proxy-anglepoint`. Leave unset to reuse the persisted value or ' +
      'auto-generate on first boot.',
  )
  .action(async (opts: { peerId?: string }) => {
    const { runServe } = await import('../serve/boot-entry.js');
    await runServe({ peerIdOverride: opts.peerId });
  });

serveCommand
  .command('status')
  .description(
    'Print the persisted proxy state (peer-id, db path) without starting the server. Reads the same ' +
      'sqlite DB `think serve` writes to.',
  )
  .action(async () => {
    // Lazy-import to keep the hot CLI path free of the `node:sqlite` cost
    // for users who never run the proxy.
    const { openDb } = await import('../serve/db.js');
    const { readProxyPeerId } = await import('../serve/peer-id.js');

    const RAW_DB_PATH = process.env.THINK_DB_PATH ?? './open-think.sqlite';
    const DB_PATH = RAW_DB_PATH === ':memory:' ? RAW_DB_PATH : path.resolve(RAW_DB_PATH);

    const db = openDb(DB_PATH);
    try {
      const peerId = readProxyPeerId(db);
      console.log(`db path:        ${DB_PATH}`);
      // `(unset — will auto-generate on first boot)` rather than empty so a
      // sysadmin reading the output doesn't think the field is broken.
      console.log(`proxy peer-id:  ${peerId ?? '(unset — will auto-generate on first boot)'}`);
    } finally {
      db.close();
    }
  });
