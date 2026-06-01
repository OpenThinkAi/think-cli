import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 15000,
    pool: 'forks',
    // #67: the full suite is a required check on every `stamp merge`, and the
    // fork pool intermittently fails to spawn workers ("Failed to start forks
    // worker / Timeout waiting for worker to respond") under the merge runner's
    // load — every added test file made it worse, blocking merges of green code.
    // Cap concurrency to 2 so the merge harness reliably spawns its workers;
    // the modest wall-clock cost buys deterministic merges. Drop to 1 if the
    // spawn timeout ever recurs.
    maxWorkers: 2,
    minWorkers: 1,
  },
});
