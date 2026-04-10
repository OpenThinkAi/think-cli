import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  external: ['better-sqlite3', '@vlcn.io/crsqlite-allinone', '@vlcn.io/crsqlite', '@anthropic-ai/claude-agent-sdk'],
  banner: {
    js: '#!/Users/mattpardini/.nvm/versions/node/v20.20.2/bin/node',
  },
  clean: true,
});
