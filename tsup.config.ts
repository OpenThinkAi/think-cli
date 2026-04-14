import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  external: ['@anthropic-ai/claude-agent-sdk'],
  banner: {
    js: '#!/usr/bin/env node --no-warnings=ExperimentalWarning',
  },
  clean: true,
});
