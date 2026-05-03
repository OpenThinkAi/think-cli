import { getConfig } from '../lib/config.js';
import { GitSyncAdapter } from './git-adapter.js';
import { LocalFsSyncAdapter } from './local-fs-adapter.js';
import type { SyncAdapter } from './types.js';

export function getSyncAdapter(): SyncAdapter | null {
  const config = getConfig();

  // Priority: fs > repo. fs is the canonical v2 backend; the
  // `cortex setup --fs` and `cortex migrate --to fs` paths both clear
  // the prior backend symmetrically, so a coexisting config is only
  // possible via hand edits — and there, fs winning matches v2 intent.
  if (config.cortex?.fs?.path) {
    return new LocalFsSyncAdapter();
  }
  if (config.cortex?.repo) {
    return new GitSyncAdapter();
  }
  return null;
}
