import { getConfig } from '../lib/config.js';
import { GitSyncAdapter } from './git-adapter.js';
import { LocalFsSyncAdapter } from './local-fs-adapter.js';
import { HubSyncAdapter } from './hub-adapter.js';
import type { SyncAdapter } from './types.js';

export function getSyncAdapter(): SyncAdapter | null {
  const config = getConfig();

  // Priority: fs > repo > hub. fs is the canonical v2 backend; the
  // `cortex setup --fs` and `cortex migrate --to fs` paths both clear
  // the prior backend symmetrically, so a coexisting config is only
  // possible via hand edits — and there, fs winning matches v2 intent.
  //
  // hub (AGT-573) is the authenticated HTTP backend. It sits LAST so that
  // adding a `cortex.hub` block can never silently demote a working fs/repo
  // setup — the established local backends keep priority. Each of fs/repo/hub
  // is configured by its own setup path, so all three coexisting is a
  // hand-edit edge case; when it happens, the local backend that the user
  // already had is preserved rather than yanked out from under them.
  if (config.cortex?.fs?.path) {
    return new LocalFsSyncAdapter();
  }
  if (config.cortex?.repo) {
    return new GitSyncAdapter();
  }
  // Require BOTH url and token, matching HubSyncAdapter.isAvailable() / its
  // internal getHub() guard. Selecting on url alone would pick the adapter for
  // a token-less config that then soft-errors on every sync — selection must
  // never be weaker than the operation guard.
  if (config.cortex?.hub?.url && config.cortex.hub.token) {
    return new HubSyncAdapter();
  }
  return null;
}
