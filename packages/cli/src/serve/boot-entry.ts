import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { BootGuardError, runBootGuards } from './boot.js';
import { buildDefaultRegistry } from './connectors/registry.js';
import { openDb } from './db.js';
import { createScheduler } from './scheduler/index.js';
import { createVault } from './vault/index.js';
import { loadVaultKey } from './vault/key.js';
import { VERSION } from './version.js';

/**
 * Boot entrypoint for the proxy. Imported lazily from the `think serve`
 * command handler so users who never run `serve` don't pay the hono /
 * @hono/node-server / zod cold-start cost on `think log`/`think recall`.
 *
 * Pre-AGT-030 this file was the server's `bin` entry and ran `main()` on
 * import. v0.5.0 wraps the same logic in `runServe()` so the CLI command
 * controls the boot lifecycle.
 */
export async function runServe(): Promise<void> {
  const RAW_DB_PATH = process.env.THINK_DB_PATH ?? './open-think.sqlite';
  // `:memory:` is a SQLite sentinel, not a filesystem path — leave it alone.
  const DB_PATH = RAW_DB_PATH === ':memory:' ? RAW_DB_PATH : path.resolve(RAW_DB_PATH);

  let cfg;
  try {
    cfg = runBootGuards(process.env);
  } catch (err) {
    if (err instanceof BootGuardError) {
      console.error(`boot failed: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const vaultKey = loadVaultKey();
  const vault = createVault(vaultKey);

  const db = openDb(DB_PATH);
  const registry = buildDefaultRegistry();
  const app = createApp({ db, vault, registry });
  const server = serve({ fetch: app.fetch, port: cfg.port });
  console.log(`open-think serve v${VERSION} listening on :${cfg.port}`);
  console.log(`[open-think serve] sqlite at ${DB_PATH}`);

  const scheduler = createScheduler({
    db,
    registry,
    vault,
    intervalMs: cfg.pollIntervalSeconds * 1000,
  });
  scheduler.start();
  console.log(`[open-think serve] scheduler tick every ${cfg.pollIntervalSeconds}s`);

  const shutdown = (signal: string) => {
    console.log(`[open-think serve] ${signal} received, shutting down`);
    scheduler.stop();
    server.close();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
