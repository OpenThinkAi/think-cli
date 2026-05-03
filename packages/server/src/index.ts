import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { openDb } from './db.js';
import { VERSION } from './version.js';

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = path.resolve(
  process.env.OPEN_THINK_DB_PATH ?? './open-think.sqlite',
);

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

  const db = openDb(DB_PATH);
  const app = createApp({ db });
  serve({ fetch: app.fetch, port: PORT });
  console.log(`open-think-server v${VERSION} listening on :${PORT}`);
  console.log(`[open-think-server] sqlite at ${DB_PATH}`);
}

main().catch((err) => {
  console.error('boot failed:', err);
  process.exit(1);
});
