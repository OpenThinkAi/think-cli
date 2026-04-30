import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  banner: {
    js: '#!/usr/bin/env node',
  },
  clean: true,
});
