import { readPackageVersion } from '../lib/version.js';

// Re-export of the shared version-reader so `serve` can stamp `/v1/health`
// and the startup banner without a second copy of the file-resolve logic.
export const VERSION = readPackageVersion();
