import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    pool: 'forks',
    // Per-file isolation; each test file gets a fresh schema (see tests/setup.ts).
    fileParallelism: false,
  },
});
