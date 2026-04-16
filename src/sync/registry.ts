import { getConfig } from '../lib/config.js';
import { GitSyncAdapter } from './git-adapter.js';
import type { SyncAdapter } from './types.js';

export function getSyncAdapter(): SyncAdapter | null {
  const config = getConfig();

  // Default to git if a repo is configured
  if (config.cortex?.repo) {
    return new GitSyncAdapter();
  }

  return null;
}
