/**
 * Cross-cortex L1 writes via git plumbing — #70 Option B / AGT-458.
 *
 * The daemon time-shares ONE working tree across every cortex branch. The
 * legacy write path checked the target cortex branch out (`git switch`) before
 * appending, committing, and pushing. With many cortices that switch is the
 * root of the #70/#65/#69 fragility class: a concurrent write to cortex-B
 * trips on cortex-A's mid-commit dirty tree ("local changes would be
 * overwritten by checkout").
 *
 * This module appends an L1 entry to a cortex branch WITHOUT touching the
 * shared worktree or HEAD, using git's plumbing:
 *
 *   1. Resolve the branch tip (`refs/heads/<cortex>`), optionally fast-
 *      forwarded to the fetched `origin/<cortex>` when the remote is ahead.
 *   2. Read the active L1 page's current content straight from the tip's tree
 *      (`git cat-file`/`ls-tree`), not the worktree — the worktree may be
 *      parked on a different cortex entirely.
 *   3. Concatenate the new lines, `git hash-object -w` the new blob, build the
 *      new tree in a SCRATCH index (`GIT_INDEX_FILE` → tmp) seeded from the
 *      tip tree via `read-tree` + `update-index --cacheinfo`, then `write-tree`.
 *   4. `git commit-tree` on top of the tip, and `git update-ref
 *      refs/heads/<cortex> <new> <oldTip>` (compare-and-swap on the old value
 *      so a concurrent ref move is detected rather than clobbered).
 *
 * The worktree and HEAD are never read or mutated, so any branch can stay
 * checked out while we write to any other.
 *
 * Page rotation mirrors `l1-page.ts`: pages are `NNNNNN.jsonl` under the
 * canonical `<cortex>/` subdir; the active page is the highest-numbered one,
 * rotating to the next number once it reaches `L1_PAGE_SIZE` non-empty lines.
 * Because the active page is computed from the branch TREE (not the worktree),
 * the rotation decision is consistent regardless of which branch is checked
 * out.
 *
 * Security posture matches `lib/git.ts`: callers pass a pre-validated branch
 * name (`assertSafeBranch`), and the git invocations carry the same hardened
 * flags the rest of the codebase uses (hooks/fsmonitor disabled via the
 * injected runner).
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { L1_PAGE_SIZE } from './l1-page.js';
import { GIT_FF_ONLY_NO_REMOTE_REF, GIT_FF_ONLY_NOT_MERGEABLE } from './git.js';

/**
 * Async git runner. Mirrors the `(args, cwd) => Promise<string>` shape the
 * push-debouncer already uses for its `_gitOverride` test seam, extended with
 * an optional `opts` carrying `stdin` (for `hash-object --stdin`) and `env`
 * extras (for the scratch `GIT_INDEX_FILE`, so building the tree never touches
 * the real index or worktree). The concrete runner (and the security flags) is
 * supplied by the caller so this module stays agnostic of the execution
 * mechanism and fully unit-testable.
 */
export type GitRunner = (
  args: string[],
  cwd: string,
  opts?: { stdin?: string; env?: NodeJS.ProcessEnv },
) => Promise<string>;

/** Reject branch names that could be misread as git flags (argv injection). */
function assertSafeBranch(branchName: string): void {
  if (!branchName) {
    throw new Error('Invalid branch name: empty or undefined.');
  }
  if (branchName.startsWith('-')) {
    throw new Error(
      `Invalid branch name: "${branchName}" starts with '-'. ` +
        `Values passed to git as positional arguments cannot begin with a hyphen.`,
    );
  }
}

/**
 * Resolve the active L1 page basename and its current content for `branchName`
 * by reading the branch's TREE at `tip` (not the worktree). Returns the
 * canonical staged path (`<branch>/<page>`) and the existing content (empty
 * string when the page does not exist yet).
 *
 * Rotation: if the highest-numbered page already holds >= L1_PAGE_SIZE
 * non-empty lines, the next page number is returned with empty content — a
 * fresh page, matching `l1-page.ts:getActivePage`.
 */
async function resolveActivePageFromTree(
  git: GitRunner,
  repoPath: string,
  branchName: string,
  tip: string | null,
): Promise<{ stagedPath: string; existing: string }> {
  const firstPage = `${branchName}/000001.jsonl`;
  if (tip === null) {
    // Unborn branch (no local ref yet): the very first write opens page 1.
    return { stagedPath: firstPage, existing: '' };
  }

  // Enumerate page basenames under the canonical subdir from the tip tree.
  let pages: string[] = [];
  try {
    const out = await git(
      ['ls-tree', '--name-only', `${tip}:${branchName}`],
      repoPath,
    );
    pages = out
      .split('\n')
      .map((l) => l.trim())
      .filter((f) => /^\d{6}\.jsonl$/.test(f))
      .sort();
  } catch {
    // Subdir absent on the branch (brand-new cortex, or pre-migrate-layout
    // flat layout). Treat as "no canonical pages yet" → open page 1.
    pages = [];
  }

  if (pages.length === 0) {
    return { stagedPath: firstPage, existing: '' };
  }

  const latest = pages[pages.length - 1];
  const latestStaged = `${branchName}/${latest}`;
  let content = '';
  try {
    content = await git(['cat-file', '-p', `${tip}:${latestStaged}`], repoPath);
  } catch {
    content = '';
  }

  const lineCount = content.split('\n').filter((l) => l.length > 0).length;
  if (lineCount >= L1_PAGE_SIZE) {
    const nextNum = parseInt(latest, 10) + 1;
    const nextPage = String(nextNum).padStart(6, '0') + '.jsonl';
    return { stagedPath: `${branchName}/${nextPage}`, existing: '' };
  }

  // `cat-file -p` of a blob returns the bytes verbatim but the trailing
  // newline handling differs from fs reads; normalise to a trailing newline
  // when non-empty so the append below produces well-formed JSONL.
  const normalised =
    content.length === 0 || content.endsWith('\n') ? content : content + '\n';
  return { stagedPath: latestStaged, existing: normalised };
}

/**
 * Resolve the tip commit to build on. Prefers the local `refs/heads/<branch>`
 * ref; fast-forwards toward `origin/<branch>` when the remote is strictly
 * ahead so the append rides on the latest shared history (the cortex branch is
 * a shared ref — other peers push to it). Returns `null` when neither a local
 * nor a remote ref exists (unborn branch / brand-new cortex).
 *
 * The fast-forward only advances the LOCAL ref via plumbing — it never touches
 * the worktree (no `merge`/`switch`). When histories have diverged (both sides
 * have unique commits), we keep the local tip and let the subsequent push
 * bounce; the caller's retry loop re-fetches and rebuilds on the newer tip,
 * mirroring the legacy pull-rebase-then-push behaviour without a checkout.
 */
async function resolveTip(
  git: GitRunner,
  repoPath: string,
  branchName: string,
): Promise<string | null> {
  const localTip = await git(
    ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`],
    repoPath,
  ).then(
    (out) => out.trim() || null,
    () => null,
  );

  const remoteTip = await git(
    ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branchName}`],
    repoPath,
  ).then(
    (out) => out.trim() || null,
    () => null,
  );

  if (localTip === null) return remoteTip; // may also be null (unborn)
  if (remoteTip === null || remoteTip === localTip) return localTip;

  // Is local an ancestor of remote? Then remote is strictly ahead → fast-
  // forward the local ref to it (plumbing-only, no worktree). `merge-base
  // --is-ancestor` exits 0 when the first arg is an ancestor of the second.
  const remoteAhead = await git(
    ['merge-base', '--is-ancestor', localTip, remoteTip],
    repoPath,
  ).then(
    () => true,
    () => false,
  );
  if (remoteAhead) {
    await git(['update-ref', `refs/heads/${branchName}`, remoteTip, localTip], repoPath);
    return remoteTip;
  }
  // Diverged (or local ahead) — keep local; the push retry loop reconciles.
  return localTip;
}

/**
 * Append `lines` to the active L1 page of `branchName` via git plumbing and
 * advance `refs/heads/<branchName>` to the new commit — without checking the
 * branch out into the shared worktree.
 *
 * Returns the new commit sha. Throws on any plumbing failure (the caller's
 * outer try/catch logs and leaves the outbox rows for the next cycle, so the
 * write is not lost). The compare-and-swap `update-ref` makes the ref advance
 * atomic with respect to a concurrent mover: if the tip changed underneath us
 * the update-ref fails and the error propagates to the retry loop.
 *
 * `fetchFirst` (default true) runs `git fetch origin <branch>` so `resolveTip`
 * can fast-forward to a remotely-advanced tip before building the commit. Pass
 * false to skip the network round-trip (offline / test).
 *
 * `forceResetToRemote` (default false): when true, after the fetch, the local
 * branch ref is unconditionally hard-reset to the freshly-fetched
 * `origin/<branch>` tip (an `update-ref` without the old-value CAS guard),
 * discarding any local-only commits. This is the recovery path used by the
 * push-debouncer after a non-fast-forward rejection — the outbox-row replay
 * model makes "discard local commits and re-append" lossless: outbox rows are
 * only deleted after a successful push, so resetting to remote and re-appending
 * recovers the pending entries on top of the current shared history. Ignored
 * when `fetchFirst` is false (no fetch → no remote tip to reset to).
 *
 * @returns `{ commit, stagedPath, parent }` — the new commit sha, the page it
 *          wrote, and the parent tip (null for the first commit on an unborn
 *          branch).
 */
export async function appendLinesViaPlumbing(
  git: GitRunner,
  repoPath: string,
  branchName: string,
  lines: string[],
  commitMessage: string,
  opts: { fetchFirst?: boolean; forceResetToRemote?: boolean } = {},
): Promise<{ commit: string; stagedPath: string; parent: string | null }> {
  assertSafeBranch(branchName);
  if (lines.length === 0) {
    throw new Error('appendLinesViaPlumbing: no lines to append');
  }

  if (opts.fetchFirst !== false) {
    // Best-effort fetch so resolveTip can fast-forward to a remotely-advanced
    // tip before building the commit. A failed fetch is non-fatal: we build on
    // the local tip and let the push surface any real auth/network error
    // (rather than spinning here). A brand-new cortex with no upstream ref is
    // the EXPECTED case; anything else we surface as a one-line warning so a
    // persistent fetch failure is visible to operators without aborting the
    // write.
    try {
      await git(['fetch', 'origin', '--', branchName], repoPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isExpected = [
        GIT_FF_ONLY_NO_REMOTE_REF,
        'Could not find remote ref',
        "couldn't find remote ref",
        'does not appear to be a git repository',
        'No remote configured',
      ].some((s) => msg.includes(s));
      if (!isExpected) {
        process.stderr.write(
          `[${new Date().toISOString()}] [git-plumbing] fetch warning for ` +
            `'${branchName}' (non-fatal, local write proceeds): ${msg}\n`,
        );
      }
    }

    // Recovery path: unconditionally hard-reset the local ref to the
    // freshly-fetched origin tip, discarding any stale local commits. This is
    // lossless when outbox rows are the source of truth — rows are only deleted
    // after a successful push, so resetting local to remote and re-appending
    // replays the pending entries on top of current shared history. Used by the
    // push-debouncer after a non-fast-forward rejection so a deeply stale clone
    // can self-heal in one retry rather than spinning forever on the same stale
    // base.
    if (opts.forceResetToRemote) {
      const remoteTip = await git(
        ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branchName}`],
        repoPath,
      ).then(
        (out) => out.trim() || null,
        () => null,
      );
      if (remoteTip !== null) {
        // Unconditional update-ref (no CAS old-value guard) — we intentionally
        // want to overwrite whatever stale local commit exists.
        await git(['update-ref', `refs/heads/${branchName}`, remoteTip], repoPath);
      }
    }
  }

  const tip = await resolveTip(git, repoPath, branchName);
  const { stagedPath, existing } = await resolveActivePageFromTree(
    git,
    repoPath,
    branchName,
    tip,
  );

  // New page content: existing bytes (already trailing-newline-normalised)
  // plus each new line terminated by a newline. Matches the byte layout of
  // the fs append path so a clone reading either way sees identical JSONL.
  const appended = lines.map((l) => l + '\n').join('');
  const newContent = existing + appended;

  // 1. Write the new page blob.
  const blob = (
    await git(['hash-object', '-w', '--stdin'], repoPath, { stdin: newContent })
  ).trim();
  if (!/^[0-9a-f]{40,64}$/.test(blob)) {
    throw new Error(`hash-object returned an unexpected blob id: "${blob}"`);
  }

  // 2. Build the new tree in a SCRATCH index so the real index / worktree are
  //    untouched. Seed from the tip tree (preserves .gitattributes + sibling
  //    pages), then overlay the one page we changed. The scratch index lives
  //    in a tmp file addressed via GIT_INDEX_FILE, passed per-call through the
  //    runner's `env` so we never mutate the shared process environment.
  const scratchIndex = path.join(
    os.tmpdir(),
    `think-plumb-${randomBytes(8).toString('hex')}.idx`,
  );
  const indexEnv = { GIT_INDEX_FILE: scratchIndex };
  try {
    if (tip !== null) {
      await git(['read-tree', `${tip}^{tree}`], repoPath, { env: indexEnv });
    } else {
      // Unborn branch — start from an empty index so the first commit's tree
      // contains only the page we add (plus nothing else). `read-tree --empty`
      // is explicit about the empty baseline.
      await git(['read-tree', '--empty'], repoPath, { env: indexEnv });
    }
    await git(
      ['update-index', '--add', '--cacheinfo', `100644,${blob},${stagedPath}`],
      repoPath,
      { env: indexEnv },
    );
    const tree = (await git(['write-tree'], repoPath, { env: indexEnv })).trim();
    if (!/^[0-9a-f]{40,64}$/.test(tree)) {
      throw new Error(`write-tree returned an unexpected tree id: "${tree}"`);
    }

    // 3. Commit on top of the tip (no parent for the first commit).
    const commitArgs = ['commit-tree', tree, '-m', commitMessage];
    if (tip !== null) {
      commitArgs.splice(2, 0, '-p', tip);
    }
    const commit = (await git(commitArgs, repoPath)).trim();
    if (!/^[0-9a-f]{40,64}$/.test(commit)) {
      throw new Error(`commit-tree returned an unexpected commit id: "${commit}"`);
    }

    // 4. Advance the branch ref with a compare-and-swap on the old tip so a
    //    concurrent mover is detected (update-ref fails) rather than clobbered.
    const updateArgs = ['update-ref', `refs/heads/${branchName}`, commit];
    if (tip !== null) {
      updateArgs.push(tip); // expected old value (CAS)
    } else {
      updateArgs.push(''); // expect the ref to not exist yet (unborn)
    }
    await git(updateArgs, repoPath);

    return { commit, stagedPath, parent: tip };
  } finally {
    try {
      fs.rmSync(scratchIndex, { force: true });
    } catch {
      /* best effort — tmp index file */
    }
  }
}
