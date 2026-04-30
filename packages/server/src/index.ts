import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { getPool } from './db/pool.js';
import { ensureSchema } from './db/schema.js';

const PORT = Number(process.env.PORT ?? 3000);

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  if (!process.env.THINK_TOKEN) {
    console.error('THINK_TOKEN is required (a long random string the CLI will present as `Bearer <token>`)');
    process.exit(1);
  }

  await ensureSchema(getPool());

  const app = createApp();
  serve({ fetch: app.fetch, port: PORT });
  console.log(`open-think-server listening on :${PORT}`);
}

main().catch(err => {
  console.error('boot failed:', err);
  process.exit(1);
});
