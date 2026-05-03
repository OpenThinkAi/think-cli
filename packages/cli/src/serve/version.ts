// Single source of truth for the version string used in startup logs and
// the /v1/health response body. Bump in lockstep with
// packages/cli/package.json `version` (the proxy ships inside the CLI
// package post-AGT-030).
export const VERSION = '0.5.0';
