import { serve } from '@hono/node-server';
import { createApp } from './app.js';

const PORT = Number(process.env.PORT ?? 3000);

async function main(): Promise<void> {
  if (!process.env.THINK_TOKEN) {
    console.error('THINK_TOKEN is required (a long random string the CLI will present as `Bearer <token>`)');
    process.exit(1);
  }

  const app = createApp();
  serve({ fetch: app.fetch, port: PORT });
  console.log(`open-think-server listening on :${PORT}`);
}

main().catch(err => {
  console.error('boot failed:', err);
  process.exit(1);
});
