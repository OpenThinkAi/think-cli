import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    pool: 'forks',
    // Per-file isolation; each test file gets a fresh schema (see tests/fixtures/db.ts).
    // Required because the singleton pool in src/db/pool.ts and the env-var-based
    // DATABASE_URL switching in fixtures cannot safely interleave across files in
    // one process. If/when pool.ts grows a per-app pool (e.g. created inside
    // createApp()), this can be relaxed.
    fileParallelism: false,
  },
});
