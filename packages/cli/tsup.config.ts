import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/daemon/index.ts', 'src/hooks/user-prompt-submit.ts', 'src/mcp/server.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  // `@huggingface/transformers` is `external` because tsup bundles it into a
  // single chunk that strips the native `onnxruntime-node` backend bindings,
  // producing a broken bundle that throws `listSupportedBackends is not a
  // function` at runtime. Leaving it as a runtime import lets Node's resolver
  // pick up the installed copy from node_modules with its native binary
  // siblings intact. Same reason `@anthropic-ai/claude-agent-sdk` is external.
  external: ['@anthropic-ai/claude-agent-sdk', '@huggingface/transformers'],
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
