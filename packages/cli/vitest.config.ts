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
    // Cap concurrency so the merge harness reliably spawns its workers; the
    // modest wall-clock cost buys deterministic merges. Originally capped at
    // 2; dropped to 1 after the spawn timeout recurred (4 consecutive gate
    // failures under machine-wide process-launch stalls — with a single
    // worker, one spawn's stall can't queue behind another's and blow the
    // 60s worker-start budget).
    maxWorkers: 1,
    minWorkers: 1,
  },
});
