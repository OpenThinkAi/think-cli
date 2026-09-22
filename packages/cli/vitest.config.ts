import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // AGT-1322: HOME / THINK_HOME isolation. `globalSetup` runs once in the
    // main process (creating the per-run root the forked workers inherit and
    // the sentinel LaunchAgents directory); `setupFiles` runs inside every
    // worker before any test module is imported and does the actual env
    // repointing. Both are required — the workers must not depend on env
    // inheritance alone, and the run-scoped sentinel check has nowhere else
    // to live. See tests/setup/home-isolation.ts for the full rationale.
    globalSetup: ['./tests/setup/global-home-isolation.ts'],
    // #96: color-env.ts pins FORCE_COLOR=0 before chalk loads so exact-string
    // output assertions hold whatever colour env the caller's shell exports.
    setupFiles: ['./tests/setup/color-env.ts', './tests/setup/home-isolation.ts'],
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
