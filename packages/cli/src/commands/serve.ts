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
 */
export const serveCommand = new Command('serve')
  .description('Boot the open-think proxy server (env-driven; see `docs/serve.md`)')
  .action(async () => {
    const { runServe } = await import('../serve/boot-entry.js');
    await runServe();
  });
