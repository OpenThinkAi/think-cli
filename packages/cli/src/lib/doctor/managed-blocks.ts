/**
 * Check: registered managed blocks out of date (AGT-1308 AC1).
 *
 * `think init` records every file it writes a managed block into (AGT-1305),
 * and `think update` refreshes them from the newly installed template
 * (AGT-1306). A machine that upgraded with a bare `npm install -g`, or whose
 * refresh failed, keeps serving agents an old work-logging block.
 *
 * "Out of date" is defined as "a real refresh would rewrite it" — computed by
 * running AGT-1306's own refresh in dry-run mode (AC4), not by a separate
 * fingerprint that would drift from the template on its next edit.
 */

import {
  refreshRegisteredBlocks,
  type BlockRefreshResult,
  type RefreshBlocksOptions,
} from '../block-refresh.js';
import { result, plural, type CheckResult } from './types.js';

export const MANAGED_BLOCKS_CHECK_ID = 'managed-blocks';

export interface ManagedBlocksOptions {
  /** Seam for the refresher. Production default is AGT-1306's function. */
  refresh?: (options: RefreshBlocksOptions) => BlockRefreshResult;
}

export function checkManagedBlocks(options: ManagedBlocksOptions = {}): CheckResult {
  const refresh = options.refresh ?? refreshRegisteredBlocks;
  const { refreshed, failures } = refresh({ dryRun: true });

  // A failure is not staleness — the entry could not be evaluated at all
  // (permissions, a vanished file, marker drift). `--fix` cannot clear it
  // either, since the real refresh would hit the same wall, so it is reported
  // as a warn a human has to act on rather than a fixable fail.
  if (failures.length > 0) {
    const detail = failures
      .map((failure) => `${failure.path} (${failure.reason})`)
      .join('; ');
    const stalePart = refreshed.length > 0
      ? ` ${plural(refreshed.length, 'other registered block')} also out of date.`
      : '';
    return result(
      MANAGED_BLOCKS_CHECK_ID,
      'warn',
      `Could not evaluate ${plural(failures.length, 'registered block')}: ${detail}.${stalePart}`,
      false,
    );
  }

  if (refreshed.length === 0) {
    return result(
      MANAGED_BLOCKS_CHECK_ID,
      'pass',
      'Every registered managed block matches the installed template.',
    );
  }

  // Warn rather than fail: a stale block is out-of-date guidance, not a broken
  // install, and `--fix` (or the next `think update`) rewrites it.
  return result(
    MANAGED_BLOCKS_CHECK_ID,
    'warn',
    `${plural(refreshed.length, 'managed block')} out of date: ${refreshed.join(', ')}.`,
    true,
  );
}
