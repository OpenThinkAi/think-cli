/**
 * Check: a local cortex branch carries an unpushed salvage commit that deleted
 * whole L1 pages (AGT-1310 AC1).
 *
 * Before AGT-1299's guard, `salvageDirtyWorktree` on a plumbing-stale index
 * committed the daemon's own appends INVERTED — whole pages recorded as
 * deletions (think-cli#95: ~6,000 deleted lines). That commit cannot
 * fast-forward onto origin, so the branch wedges: every push after it is
 * rejected non-fast-forward and the cortex stops propagating without saying so.
 *
 * The verdict comes from `lib/salvage-repair.ts`'s read-only sweep, which is
 * offline (it judges "unpushed" against the remote-tracking ref as last
 * fetched) and never checks a branch out. `--fix` runs the repair half of the
 * same module, which re-queues every entry origin does not already hold before
 * it resets — report and repair therefore share one definition of the fault.
 *
 * A branch with no `origin/<branch>` ref in this clone reports as a WARN, not
 * a fail: the state is worth a human's eyes, but there is no tip to reset to
 * and nothing on the branch is known to exist anywhere else, so offering a
 * repair would be offering to delete the only copy.
 */

import fs from 'node:fs';
import path from 'node:path';
import { findSalvagedCortexBranches, type SalvageFinding } from '../salvage-repair.js';
import { getRepoPath } from '../paths.js';
import { result, plural, type CheckResult } from './types.js';

export const SALVAGE_COMMIT_CHECK_ID = 'cortex-salvage-commit';

export interface SalvageCommitOptions {
  /** The cortex repo to inspect. Defaults to `<THINK_HOME>/repo`. */
  repoPath?: string;
  /** Seam for the sweep. Production default is the read-only sweep. */
  scan?: () => SalvageFinding[];
}

export function checkSalvageCommits(options: SalvageCommitOptions = {}): CheckResult {
  const repoPath = options.repoPath ?? getRepoPath();
  const scan = options.scan ?? (() => findSalvagedCortexBranches({ repoPath }));

  // No clone (fs backend, or a home that has never synced) — no branch to be
  // wedged. Checked before the sweep, which would otherwise report the same
  // thing as an indistinguishable "nothing found".
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    return result(SALVAGE_COMMIT_CHECK_ID, 'pass', `No cortex repo at ${repoPath}.`);
  }

  let findings: SalvageFinding[];
  try {
    findings = scan();
  } catch (err) {
    // The sweep is read-only, so a throw means git itself could not be
    // questioned. "Could not look" is not "nothing is wrong", and it is
    // certainly not grounds for running the mutating half.
    return result(
      SALVAGE_COMMIT_CHECK_ID,
      'warn',
      `Could not inspect the cortex branches in ${repoPath}: ${err instanceof Error ? err.message : String(err)}.`,
      false,
    );
  }

  if (findings.length === 0) {
    return result(
      SALVAGE_COMMIT_CHECK_ID,
      'pass',
      'No cortex branch carries an unpushed salvage commit.',
    );
  }

  const repairable = findings.filter((finding) => finding.hasUpstream);
  const stranded = findings.filter((finding) => !finding.hasUpstream);

  if (repairable.length === 0) {
    return result(
      SALVAGE_COMMIT_CHECK_ID,
      'warn',
      `${describe(stranded)} — and no origin ref to reset to, so think will not touch ` +
        `${stranded.length === 1 ? 'it' : 'them'}. Fetch or push the branch, then re-run.`,
      false,
    );
  }

  const tail = stranded.length > 0
    ? ` Also, with no origin ref and so not repairable: ${stranded.map((f) => f.branch).join(', ')}.`
    : '';
  return result(
    SALVAGE_COMMIT_CHECK_ID,
    'fail',
    `${describe(repairable)} — the branch cannot fast-forward onto origin, so nothing ` +
      `written since is reaching it.${tail}`,
    true,
  );
}

/** `personal carries an unpushed salvage commit (a1b2c3d4) deleting 2 L1 pages` */
function describe(findings: SalvageFinding[]): string {
  return findings
    .map((finding) => {
      const shas = finding.commits.map((commit) => commit.sha.slice(0, 8)).join(', ');
      return (
        `${finding.branch} carries ${plural(finding.commits.length, 'unpushed salvage commit')} ` +
        `(${shas}) deleting ${plural(finding.deletedPages.length, 'L1 page')}`
      );
    })
    .join('; ');
}
