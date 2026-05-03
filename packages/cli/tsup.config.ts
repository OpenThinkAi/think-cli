import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  external: ['@anthropic-ai/claude-agent-sdk'],
  banner: {
    js: '#!/usr/bin/env node --no-warnings=ExperimentalWarning',
  },
  // tsup defaults `removeNodeProtocol` to true, which strips the `node:`
  // prefix from every builtin import. That's harmless for `node:path` (the
  // bare `path` import still resolves), but `node:sqlite` has no bare alias
  // — it lives only behind the `node:` prefix, so stripping it produces
  // `import { DatabaseSync } from "sqlite"` and crashes at boot. Keep the
  // prefix on every builtin so newer ones like `node:sqlite` survive the
  // bundle.
  removeNodeProtocol: false,
  clean: true,
});
