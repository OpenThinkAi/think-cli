/**
 * Check: `~/.think/repo`'s git index is stale vs HEAD (AGT-1308 AC1, severity
 * fixed by AGT-1326).
 *
 * The daemon's L1 writer advances `refs/heads/<cortex>` with
 * `commit-tree` + `update-ref` and — by design — never touches the index or
 * the worktree. On a machine with the daemon running, that happens every few
 * seconds, so the index is *routinely* behind HEAD; that alone is expected,
 * not broken, on 3.0 and later. `think curate` and its salvage commit are
 * gone, so nothing walks the stale index and commits it as a tree anymore,
 * and AGT-1299's `reconcilePlumbingStaleIndex` resets it to HEAD automatically
 * the moment `ensureOnBranch` needs a checkout. A bare lag is therefore inert:
 * it costs nothing to leave alone, and it clears itself on the next checkout
 * without anyone running `--fix`.
 *
 * AGT-1326: this check used to `fail` on every lag, including that inert one
 * — on a machine running many agents that meant permanent, unfixable-by-
 * design red, because the very next daemon append re-stales the index a few
 * seconds after `--fix` reconciles it (observed on the work Mac: `--fix`
 * passed once, then failed again at the next append). The severity now
 * tracks what is actually at risk, using the SAME verdict
 * `planStaleIndexReconcile` already computes (AGT-1308's "report and repair
 * share one definition of stale" invariant is unchanged):
 *
 *  - stale with an EMPTY restore list — nothing in the worktree extends past
 *    the index, i.e. pure plumbing lag — is `pass`. There is no edit at risk,
 *    so there is nothing to fix, and `--fix` running here would just do
 *    `reset --hard HEAD` for no reason before the daemon re-stales it anyway.
 *  - stale with one or more restores — a real in-flight worktree append is
 *    sitting on a stale index — is `warn`, `fixable: true`. Something is
 *    genuinely at risk of `git status` reporting it backwards, and `--fix`
 *    (still `reconcilePlumbingStaleIndex`, unchanged) is worth running.
 *
 * Do NOT "fix" the permanent lag by making the daemon's plumbing writer touch
 * the index on every append. The writer runs on every `think sync`/`think
 * event` from every agent on the box — a hot path — and index writes are not
 * safe to interleave with an agent mid-append into a worktree file (that
 * collision is exactly what `planStaleIndexReconcile`'s two proofs exist to
 * detect after the fact). Keeping the index and the worktree/HEAD decoupled
 * on the plumbing path is the design, not a gap this check should paper over.
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

  // Pure lag — no genuine in-flight edit is at risk (AGT-1326). Expected on
  // 3.0: the plumbing writer never touches the index, and AGT-1299's guard
  // reconciles it the next time a checkout needs the tree clean. Nothing to
  // fix, so this is a pass like any other check that found nothing wrong.
  if (restores.length === 0) {
    return result(
      REPO_INDEX_CHECK_ID,
      'pass',
      `Index in ${repoPath} lags the daemon's appends (expected on 3.0 — the ` +
        `plumbing writer never touches the index; it is reconciled ` +
        `automatically when a checkout is needed).`,
    );
  }

  // Stale AND a genuine in-flight append sits on top of it — this is the case
  // `--fix` exists for: `git status` would report the append backwards until
  // reconciled.
  return result(
    REPO_INDEX_CHECK_ID,
    'warn',
    `${plural(restores.length, 'in-flight worktree append')} sit on a stale ` +
      `index — \`think doctor --fix\` reconciles them and preserves every append.`,
    true,
  );
}
