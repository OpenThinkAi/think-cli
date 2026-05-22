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
    // `env -S` is required so the kernel passes `node` and
    // `--no-warnings=ExperimentalWarning` as separate args to env (which
    // then splits them on its own). Without `-S`, the kernel hands env a
    // single literal arg "node --no-warnings=ExperimentalWarning"; GNU env
    // (Debian 12 / coreutils 9.1, used on every common Linux container
    // base) can't find a binary by that exact name and falls back to
    // exec'ing the next arg — which is the script itself — re-triggering
    // the shebang dispatch and producing an infinite re-exec loop. macOS
    // BSD env silently tolerates the missing `-S`, which is why the bug
    // hides on dev laptops.
    js: '#!/usr/bin/env -S node --no-warnings=ExperimentalWarning',
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
