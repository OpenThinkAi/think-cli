import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  banner: {
    js: '#!/usr/bin/env node',
  },
  // tsup defaults `removeNodeProtocol` to true, which strips the `node:`
  // prefix from every builtin import. That's harmless for `node:path` (the
  // bare `path` import still resolves at runtime), but `node:sqlite` has no
  // bare alias — it lives only behind the `node:` prefix. Stripping it
  // produces `import { DatabaseSync } from "sqlite"`, which crashes at boot
  // with `Cannot find package 'sqlite'`. Keep the prefix on every builtin so
  // newer ones like `node:sqlite` survive the bundle.
  removeNodeProtocol: false,
  clean: true,
});
