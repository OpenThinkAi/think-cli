/**
 * AGT-1310 — find, and undo, an unpushed salvage commit that deleted L1 pages.
 *
 * The failure this repairs (think-cli#95): on a machine that ran `think curate`
 * before AGT-1299's guard, `salvageDirtyWorktree` committed a plumbing-stale
 * index, recording the daemon's own appends as deletions of whole L1 pages.
 * That commit cannot fast-forward onto origin, so every subsequent push is
 * rejected non-fast-forward and the cortex silently stops propagating — while
 * new writes keep piling up behind it.
 *
 * The cure is the one the README's operator runbook already documents for the
 * proxy's large-behind clone: hard-reset the local branch to the freshly
 * fetched remote tip and let the outbox replay what had not reached origin
 * yet. The runbook can lean on "the outbox rows are only deleted after a
 * successful push" because the entries it discards were never anywhere else.
 * Here they were: the salvage commit is itself a local commit, so entries can
 * be sitting in local history with no outbox row behind them. So this module
 * re-establishes the runbook's precondition before it takes the runbook's
 * action — it re-queues to `l1_outbox` every entry that local-only history
 * holds and origin does not, and only then resets.
 *
 * The invariant, in one line: for every branch this touches, every entry id
 * reachable before the repair is present at `origin/<branch>` or in
 * `l1_outbox` after it. `planLocalOnlyEntries` (lib/git.ts) is the proof; this
 * module is the bookkeeping around it, and it refuses rather than resets
 * whenever the proof cannot be built.
 *
 * Read-only detection (`findSalvagedCortexBranches`) is what `think doctor`
 * reports; the repair (`repairSalvagedCortexBranches`) is what `--fix` runs.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  fetchBranch,
  localBranchExists,
  planLocalOnlyEntries,
  planSalvageCommitRepair,
  resetCortexBranchToOrigin,
  type SalvageCommitFinding,
} from './git.js';
import { enqueueL1Outbox } from './l1-page.js';
import { getRepoPath, sanitizeName } from './paths.js';
import { closeCortexDb, getCortexDb, listKnownCortexes } from '../db/engrams.js';

/** One local cortex branch carrying at least one page-deleting salvage commit. */
export interface SalvageFinding {
  /** Cortex name, which is also its branch name. */
  branch: string;
  commits: SalvageCommitFinding[];
  /** Whole pages the salvage commits delete, deduped across them. */
  deletedPages: string[];
  /**
   * False when this clone has no `refs/remotes/origin/<branch>`. Such a branch
   * is reported but never repaired: there is no tip to reset to, and nothing
   * on it is known to exist anywhere else.
   */
  hasUpstream: boolean;
}

export interface SalvageSweepOptions {
  /** Cortexes to inspect. Defaults to every cortex under the index dir. */
  cortexes?: string[];
  /** The cortex repo. Defaults to `<THINK_HOME>/repo`. */
  repoPath?: string;
}

/**
 * Read-only sweep: which local cortex branches carry an unpushed, page-deleting
 * salvage commit.
 *
 * The cortex list comes from `listKnownCortexes()` — the same enumeration the
 * daemon's boot-time outbox replay and the embedding-prune loop use, which
 * walks the index directory recursively and therefore sees slash-named
 * cortexes (#78). A bare `readdirSync` of either the index dir or the repo
 * would miss them. A cortex with no local branch ref is skipped; a branch with
 * no cortex DB is out of scope, because the repair's re-queue target is that
 * DB's `l1_outbox`.
 *
 * Makes no network call: "unpushed" is judged against the remote-tracking ref
 * as last fetched, so a stale ref can only make this under-report. The repair
 * fetches before it decides anything.
 */
export function findSalvagedCortexBranches(options: SalvageSweepOptions = {}): SalvageFinding[] {
  const repoPath = options.repoPath ?? getRepoPath();
  if (!fs.existsSync(path.join(repoPath, '.git'))) return [];

  const findings: SalvageFinding[] = [];
  for (const cortex of options.cortexes ?? listKnownCortexes()) {
    if (!localBranchExists(cortex)) continue;
    const plan = planSalvageCommitRepair(cortex);
    if (plan === null || plan.salvageCommits.length === 0) continue;
    findings.push({
      branch: cortex,
      commits: plan.salvageCommits,
      deletedPages: [...new Set(plan.salvageCommits.flatMap((c) => c.deletedPages))],
      hasUpstream: plan.originTip !== null,
    });
  }
  return findings;
}

/** What the repair did to one branch. */
export interface BranchRepair {
  branch: string;
  /** True only when the branch now sits at `origin/<branch>`. */
  ok: boolean;
  /** Entry ids re-queued to `l1_outbox` before the reset, oldest first. */
  requeued: string[];
  /** Local entry ids origin already held — nothing to re-queue for these. */
  presentOnOrigin: number;
  /** Why the branch was left exactly as found. Set iff `ok` is false. */
  reason?: string;
}

export interface SalvageRepairOptions extends SalvageSweepOptions {
  /** Seam for the fetch. Production default is `fetchBranch` from lib/git.ts. */
  fetch?: (branchName: string) => void;
}

/**
 * Repair every branch `findSalvagedCortexBranches` reports, in order.
 *
 * Per branch, and in this order, because the order is the safety property:
 *
 *  1. Refuse outright when there is no upstream — there is no tip to reset to.
 *  2. Fetch `origin/<branch>`. A failure here is a refusal, not a warning:
 *     resetting to a remote-tracking ref we could not confirm would discard
 *     local commits against a tip that may no longer exist.
 *  3. Re-plan against the freshly fetched tip, then prove what would be lost
 *     (`planLocalOnlyEntries`). Any doubt is a refusal.
 *  4. Re-queue, to the cortex's `l1_outbox`, every proven-local entry that is
 *     not already on origin AND not already queued — with its original line
 *     bytes and `ts`, so the daemon's drain replays exactly what was written.
 *  5. Only then reset the branch ref.
 *
 * Steps 4 and 5 are deliberately NOT atomic, and deliberately in that order: a
 * crash between them leaves rows queued for entries still present in local
 * history, which the next drain may append to origin a second time. That is the
 * survivable failure. The reverse order's failure is the unsurvivable one.
 */
export function repairSalvagedCortexBranches(
  options: SalvageRepairOptions = {},
): BranchRepair[] {
  const fetch = options.fetch ?? fetchBranch;
  const repairs: BranchRepair[] = [];

  for (const finding of findSalvagedCortexBranches(options)) {
    repairs.push(repairOneBranch(finding, fetch));
  }
  return repairs;
}

function repairOneBranch(
  finding: SalvageFinding,
  fetch: (branchName: string) => void,
): BranchRepair {
  const branch = finding.branch;
  const refuse = (reason: string): BranchRepair =>
    ({ branch, ok: false, requeued: [], presentOnOrigin: 0, reason });

  if (!finding.hasUpstream) {
    return refuse(
      `no origin/${branch} in this clone — nothing to reset to, and nothing on the ` +
        `branch is known to be on origin. Push or fetch the branch first.`,
    );
  }

  // Path-traversal / illegal-character gate before the name reaches the index
  // directory, the same one every daemon write path applies.
  let safeCortex: string;
  try {
    safeCortex = sanitizeName(branch);
  } catch (err) {
    return refuse(`invalid cortex name: ${message(err)}`);
  }

  try {
    fetch(branch);
  } catch (err) {
    return refuse(`could not reach origin: ${message(err)}`);
  }

  // Re-plan AFTER the fetch: the tip we reset to, and the entries we call
  // "already on origin", must both come from the same post-fetch state.
  const plan = planSalvageCommitRepair(branch);
  if (plan === null) return refuse(`the local ref for ${branch} disappeared mid-repair`);
  if (plan.salvageCommits.length === 0) {
    // The fetch brought the salvage commit down from origin (someone pushed it
    // by force) or the branch was repaired in the meantime. Either way it is no
    // longer an unpushed local commit and this repair does not apply.
    return refuse(`no unpushed salvage commit on ${branch} after fetching origin`);
  }

  const entryPlan = planLocalOnlyEntries(branch);
  if (!entryPlan.ok) return refuse(entryPlan.reason);

  let requeued: string[];
  try {
    requeued = requeueToOutbox(safeCortex, entryPlan.entries);
  } catch (err) {
    return refuse(`could not re-queue ${entryPlan.entries.length} entries: ${message(err)}`);
  }

  try {
    resetCortexBranchToOrigin(branch);
  } catch (err) {
    // The re-queued rows stay: they are the only copy of those entries that is
    // not inside the local-only commits we just failed to discard, and the
    // daemon's drain is idempotent enough to replay them onto whichever tip
    // wins. Leaving them is strictly safer than deleting them.
    return {
      branch,
      ok: false,
      requeued,
      presentOnOrigin: entryPlan.presentOnOrigin,
      reason: `re-queued ${requeued.length} entries but could not reset the branch: ${message(err)}`,
    };
  }

  return { branch, ok: true, requeued, presentOnOrigin: entryPlan.presentOnOrigin };
}

/**
 * Append the entries origin does not have to the cortex's `l1_outbox`, skipping
 * any whose id is already queued, in one transaction. Returns the ids written.
 *
 * `line` goes in verbatim — the exact bytes the page held — so the drain's
 * `appendRawLineToL1Page` re-writes the original entry rather than a
 * re-serialized approximation of it, and `created_at` is the entry's own `ts`,
 * so ordering in the replayed page matches when it was written.
 *
 * The handle is closed afterwards for the same reason `lib/l1-fallback.ts`
 * closes it: this is a short-lived CLI process, and the daemon that will drain
 * these rows has to see the WAL contents.
 */
function requeueToOutbox(
  safeCortex: string,
  entries: Array<{ id: string; line: string; ts: string }>,
): string[] {
  const db: DatabaseSync = getCortexDb(safeCortex);
  try {
    const queued = new Set(
      (db.prepare('SELECT entry_id FROM l1_outbox').all() as Array<{ entry_id: string }>).map(
        (row) => row.entry_id,
      ),
    );
    const pending = entries.filter((entry) => !queued.has(entry.id));
    if (pending.length === 0) return [];

    db.exec('BEGIN');
    try {
      for (const entry of pending) enqueueL1Outbox(db, entry.id, entry.line, entry.ts);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return pending.map((entry) => entry.id);
  } finally {
    closeCortexDb(safeCortex);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
