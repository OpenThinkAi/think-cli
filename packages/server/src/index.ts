import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { buildDefaultRegistry } from './connectors/registry.js';
import { openDb } from './db.js';
import { createScheduler } from './scheduler/index.js';
import { VERSION } from './version.js';

const PORT = Number(process.env.PORT ?? 3000);
const RAW_DB_PATH = process.env.THINK_DB_PATH ?? './open-think.sqlite';
// `:memory:` is a SQLite sentinel, not a filesystem path — leave it alone.
const DB_PATH = RAW_DB_PATH === ':memory:' ? RAW_DB_PATH : path.resolve(RAW_DB_PATH);
const DEFAULT_POLL_INTERVAL_SECONDS = 600;

function resolvePollIntervalSeconds(): number {
  const raw = process.env.THINK_POLL_INTERVAL_SECONDS;
  if (raw === undefined || raw === '') return DEFAULT_POLL_INTERVAL_SECONDS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    console.error(
      `boot failed: THINK_POLL_INTERVAL_SECONDS must be a positive integer, got ${JSON.stringify(raw)}`,
    );
    process.exit(1);
  }
  return n;
}

async function main(): Promise<void> {
  if (!process.env.THINK_TOKEN) {
    console.error(
      'boot failed: THINK_TOKEN env var is required (gates /v1/events and /v1/subscriptions)',
    );
    process.exit(1);
  }
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    console.error(
      `boot failed: PORT must be an integer 1–65535, got ${JSON.stringify(process.env.PORT)}`,
    );
    process.exit(1);
  }

  const pollIntervalSeconds = resolvePollIntervalSeconds();

  const db = openDb(DB_PATH);
  const app = createApp({ db });
  const server = serve({ fetch: app.fetch, port: PORT });
  console.log(`open-think-server v${VERSION} listening on :${PORT}`);
  console.log(`[open-think-server] sqlite at ${DB_PATH}`);

  const scheduler = createScheduler({
    db,
    registry: buildDefaultRegistry(),
    intervalMs: pollIntervalSeconds * 1000,
  });
  scheduler.start();
  console.log(`[open-think-server] scheduler tick every ${pollIntervalSeconds}s`);

  const shutdown = (signal: string) => {
    console.log(`[open-think-server] ${signal} received, shutting down`);
    scheduler.stop();
    server.close();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('boot failed:', err);
  process.exit(1);
});
