/**
 * Check: stale `ai.openthink.curate.*` / `ai.openthink.sync.*` LaunchAgents
 * (AGT-1308 AC1).
 *
 * `think curate` and the daemon-down sync bypass are gone, so every plist
 * still on disk fires a nonexistent command on a timer, forever, once per
 * THINK_HOME the machine has ever pointed at. The matcher that decides which
 * plists are ours is AGT-1301's `reapStaleLaunchAgents` — this calls it in
 * dry-run mode rather than re-deriving the rule, so the report and the repair
 * cannot disagree (AC4).
 */

import { reapStaleLaunchAgents, type ReapLaunchAgentsOptions } from '../launch-agent.js';
import { result, plural, type CheckResult } from './types.js';

export const STALE_LAUNCH_AGENTS_CHECK_ID = 'stale-launch-agents';

export interface StaleLaunchAgentsOptions {
  /**
   * Passed straight through to the reaper. Tests MUST inject
   * `launchAgentsDir` (a temp fixture) and `platform` here — never let this
   * resolve the real `~/Library/LaunchAgents`.
   */
  reapOptions?: ReapLaunchAgentsOptions;
  /** Seam for the reaper itself, so a test can assert the dry run is used. */
  reap?: (options: ReapLaunchAgentsOptions) => ReturnType<typeof reapStaleLaunchAgents>;
}

/**
 * Non-darwin platforms have no LaunchAgents at all, and the reaper is a no-op
 * there — which reads as "nothing stale", the correct answer. The detail line
 * says so rather than claiming a directory was scanned.
 */
export function checkStaleLaunchAgents(options: StaleLaunchAgentsOptions = {}): CheckResult {
  const reap = options.reap ?? reapStaleLaunchAgents;
  const reapOptions = options.reapOptions ?? {};
  const platform = reapOptions.platform ?? process.platform;

  if (platform !== 'darwin') {
    return result(
      STALE_LAUNCH_AGENTS_CHECK_ID,
      'pass',
      'No LaunchAgents on this platform.',
    );
  }

  const stale = reap({ ...reapOptions, dryRun: true });
  if (stale.length === 0) {
    return result(
      STALE_LAUNCH_AGENTS_CHECK_ID,
      'pass',
      'No stale curate/sync LaunchAgents.',
    );
  }

  // Fail, not warn: these are loaded jobs invoking a command this version no
  // longer has. They will keep waking up and failing until they are removed.
  const labels = stale.map((agent) => agent.label).sort().join(', ');
  return result(
    STALE_LAUNCH_AGENTS_CHECK_ID,
    'fail',
    `${plural(stale.length, 'stale LaunchAgent')} still installed: ${labels}. ` +
      'They run a command think no longer has.',
    true,
  );
}
