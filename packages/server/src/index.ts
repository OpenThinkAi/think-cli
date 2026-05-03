import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { VERSION } from './version.js';

const PORT = Number(process.env.PORT ?? 3000);

async function main(): Promise<void> {
  // THINK_TOKEN is intentionally not validated at boot in 0.2.x — there are
  // no authed routes to gate. AGT-027 re-introduces both the auth seam and
  // the boot check at the same time.

  const app = createApp();
  serve({ fetch: app.fetch, port: PORT });
  console.log(`open-think-server v${VERSION} listening on :${PORT}`);
  console.log(
    `[open-think-server] cortex storage routes retired in ${VERSION} (AGT-026); ` +
      'only /v1/health is served until the proxy role lands in AGT-027.',
  );
}

main().catch(err => {
  console.error('boot failed:', err);
  process.exit(1);
});
