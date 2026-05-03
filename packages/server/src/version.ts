// Single source of truth for the version string used in startup logs,
// the /v1/health response body, and the THINK_TOKEN boot-error message.
// Bump in lockstep with packages/server/package.json `version`.
export const VERSION = '0.2.0';
