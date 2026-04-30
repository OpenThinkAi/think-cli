import { getConfig } from '../lib/config.js';
import { GitSyncAdapter } from './git-adapter.js';
import { HttpSyncAdapter } from './http-adapter.js';
import type { SyncAdapter } from './types.js';

export function getSyncAdapter(): SyncAdapter | null {
  const config = getConfig();

  // server takes precedence over repo when both are present — the http
  // backend is the more deliberate choice (you opted into a deployed
  // server) and `repo` is more likely to be stale legacy config.
  if (config.cortex?.server?.url && config.cortex.server.token) {
    return new HttpSyncAdapter();
  }
  if (config.cortex?.repo) {
    return new GitSyncAdapter();
  }
  return null;
}
