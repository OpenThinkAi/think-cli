#!/usr/bin/env node
// open-think-server is deprecated. The proxy was folded into the open-think
// CLI in v0.5.0 — there is no separate package anymore. Print a clear
// migration message and exit non-zero so misconfigured deploys (Railway,
// docker, CI) fail fast instead of silently doing nothing.
console.error('open-think-server is deprecated.');
console.error('The proxy folded into the open-think CLI in v0.5.0.');
console.error('Run `npx open-think serve` (or `npm install -g open-think && think serve`) instead.');
console.error('See https://github.com/OpenThinkAi/think-cli/blob/main/packages/cli/docs/serve.md for details.');
process.exit(1);
