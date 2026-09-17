/**
 * Check: unmigrated engram rows (AGT-1308 AC1).
 *
 * Rows with `evaluated_at IS NULL AND deleted_at IS NULL` were written but
 * never evaluated, so nothing in think ever surfaced them: they are notes the
 * user believes they saved and cannot recall. The one-shot rescue is
 * AGT-1302's `migrateStrandedEngrams`; this reports through its `--dry-run`
 * path, which counts from a READ-ONLY database connection and writes nothing
 * — the same function `--fix` then runs for real (AC4).
 */

import {
  migrateStrandedEngrams,
  type EngramMigrationSummary,
  type MigrateEngramsOptions,
} from '../engram-migration.js';
import { result, plural, type CheckResult } from './types.js';

export const ENGRAM_ROWS_CHECK_ID = 'unmigrated-engrams';

export interface EngramRowsOptions {
  /** Seam for the migration. Production default is AGT-1302's function. */
  migrate?: (options: MigrateEngramsOptions) => Promise<EngramMigrationSummary>;
  /** Cortexes to sweep. Defaults to every cortex under the index dir. */
  cortexes?: string[];
}

export async function checkUnmigratedEngrams(
  options: EngramRowsOptions = {},
): Promise<CheckResult> {
  const migrate = options.migrate ?? migrateStrandedEngrams;
  const summary = await migrate({ dryRun: true, cortexes: options.cortexes });

  // A cortex that could not be opened read-only is reported, not silently
  // counted as zero — "no stranded rows" and "could not look" are different
  // answers and only one of them is reassuring.
  const unreadable = summary.cortexes.filter((cortex) => cortex.error !== undefined);
  const rescuable = summary.totals.events + summary.totals.memories;

  if (rescuable === 0 && unreadable.length === 0) {
    return result(
      ENGRAM_ROWS_CHECK_ID,
      'pass',
      'No unmigrated engram rows.',
    );
  }

  const parts: string[] = [];
  if (rescuable > 0) {
    const perCortex = summary.cortexes
      .filter((cortex) => cortex.events + cortex.memories > 0)
      .map((cortex) => `${cortex.cortex}: ${cortex.events + cortex.memories}`)
      .join(', ');
    parts.push(`${plural(rescuable, 'stranded engram row')} never evaluated (${perCortex})`);
  }
  if (unreadable.length > 0) {
    const names = unreadable.map((cortex) => `${cortex.cortex} (${cortex.error})`).join('; ');
    parts.push(`could not read ${plural(unreadable.length, 'cortex', 'cortexes')}: ${names}`);
  }

  // Fail: the rows hold content the user wrote and cannot reach. `--fix`
  // re-submits them through the normal write path, preserving `created_at`.
  // Still fixable when only some cortexes were unreadable — the real pass
  // opens read-write and rescues whatever it can reach, and is idempotent.
  return result(
    ENGRAM_ROWS_CHECK_ID,
    'fail',
    `${parts.join('; ')}.`,
    rescuable > 0 || unreadable.length > 0,
  );
}
