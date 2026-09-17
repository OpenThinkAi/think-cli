/**
 * Check: `~/.think/repo`'s git index is stale vs HEAD (AGT-1308 AC1).
 *
 * The daemon's L1 writer advances `refs/heads/<cortex>` with
 * `commit-tree` + `update-ref` and never touches the index or the worktree.
 * When that branch is the checked-out one, HEAD moves out from under a
 * now-stale index and `git status` reports the daemon's own appends INVERTED
 * — appended lines look like staged deletions. think-cli#95 saw ~6,000
 * deleted lines from exactly this.
 *
 * The verdict comes from AGT-1299's `planStaleIndexReconcile`, which is
 * read-only by construction and proves stale-ness from blob content rather
 * than from `git status` (which cannot tell "stale" from "edited"). `--fix`
 * runs `reconcilePlumbingStaleIndex`, whose rule stands: it never discards a
 * genuine edit.
 */

import fs from 'node:fs';
import path from 'node:path';
import { planStaleIndexReconcile } from '../git.js';
import { getRepoPath } from '../paths.js';
import { result, plural, type CheckResult } from './types.js';

export const REPO_INDEX_CHECK_ID = 'repo-index';

/** What `planStaleIndexReconcile` returns: the worktree files to rewrite
 *  after the reset, or null when the state is not provably stale. */
export type StaleIndexPlan = Array<{ absPath: string; content: Buffer }> | null;

export interface RepoIndexOptions {
  /** The cortex repo to inspect. Defaults to `<THINK_HOME>/repo`. */
  repoPath?: string;
  /** Seam for the planner. Production default is AGT-1299's function. */
  plan?: () => StaleIndexPlan;
}

export function checkRepoIndex(options: RepoIndexOptions = {}): CheckResult {
  const repoPath = options.repoPath ?? getRepoPath();
  const plan = options.plan ?? planStaleIndexReconcile;

  // No clone (fs backend, or a home that has never synced) — nothing to be
  // stale against. Checked before calling the planner, which would otherwise
  // report the same thing as an opaque "not provably stale".
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    return result(REPO_INDEX_CHECK_ID, 'pass', `No cortex repo at ${repoPath}.`);
  }

  let restores: StaleIndexPlan;
  try {
    restores = plan();
  } catch (err) {
    // The planner is read-only, so a throw here means git itself could not be
    // questioned (unreadable object, unmerged index). Not something `--fix`
    // should paper over by running the mutating half.
    return result(
      REPO_INDEX_CHECK_ID,
      'warn',
      `Could not inspect the index in ${repoPath}: ${err instanceof Error ? err.message : String(err)}.`,
      false,
    );
  }

  if (restores === null) {
    return result(
      REPO_INDEX_CHECK_ID,
      'pass',
      `Index in ${repoPath} is not behind HEAD.`,
    );
  }

  const appendNote = restores.length > 0
    ? ` ${plural(restores.length, 'in-flight worktree append')} would be preserved`
    : ' No in-flight worktree changes';
  return result(
    REPO_INDEX_CHECK_ID,
    'fail',
    `Index in ${repoPath} is stale behind a plumbing-advanced HEAD — ` +
      `git status inverts the daemon's appends into deletions.${appendNote}.`,
    true,
  );
}
