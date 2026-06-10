/**
 * Push debouncer — AGT-309
 *
 * After any L1 write in a cortex, waits 500ms (debounced per cortex) then
 * runs `git add <cortex dir> && git commit && git push origin <cortex>`.
 *
 * Design choices:
 * - Per-cortex debounce: each cortex has an independent timer so a burst on
 *   cortex-A doesn't delay cortex-B.
 * - Pending-entry counting: every `notify()` increments the pending count;
 *   the push sequence reads and resets it to build the commit message
 *   "auto: N entries via daemon <ISO>".
 * - Off-loop execution: the git operations are deferred via `setImmediate`
 *   so the sync handler's hot path returns immediately without waiting for
 *   the first I/O syscall to dispatch.
 * - No infinite retry: on push failure the error is logged and the counter
 *   is reset. The next `notify()` call (triggered by the next write) will
 *   fire a fresh debounce cycle.
 * - skipPush flag (AGT-293): callers can suppress the push for this
 *   cortex on the current cycle (e.g., during offline operation).
 *   Note: when multiple `notify()` calls arrive within the debounce window
 *   the last call's `skipPush` value wins, since each call cancels and
 *   re-creates the timer with a fresh closure.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getRepoPath, sanitizeName } from '../lib/paths.js';
import { safeGitEnv, withUnionMergeAttribute, ensureLocalUnionMergeAttribute, GIT_FF_ONLY_NO_REMOTE_REF, GIT_FF_ONLY_NOT_MERGEABLE } from '../lib/git.js';
import { appendLinesViaPlumbing } from '../lib/git-plumbing.js';
import { appendRawLineToL1Page } from '../lib/l1-page.js';
import { getCortexDb } from '../db/engrams.js';
import { getConfig } from '../lib/config.js';
import { daemonLog } from './log.js';

// ---------------------------------------------------------------------------
// Push-debouncer metrics (process-lifetime counters, reset on restart)
// ---------------------------------------------------------------------------

export interface PushDebouncerMetrics {
  /** Total successful pushes across all cortices since daemon start. */
  pushSuccesses: number;
  /**
   * Total cycles where all MAX_PUSH_ATTEMPTS were exhausted with a
   * non-fast-forward rejection still outstanding. The proxy curates but curated
   * entries stop reaching origin until the next successful push cycle.
   */
  pushFailuresNonFastForward: number;
  /**
   * ISO timestamp of the last permanent non-FF push failure, or null when none
   * has occurred since daemon start. Operators can compare against now() to
   * assess staleness.
   */
  lastPushErrorAt: string | null;
}

/** Internal mutable counters — exported only for tests. */
export const _pushMetrics: PushDebouncerMetrics = {
  pushSuccesses: 0,
  pushFailuresNonFastForward: 0,
  lastPushErrorAt: null,
};

/**
 * Returns a snapshot of process-lifetime push-debouncer metrics. Counters
 * reset on daemon restart. Mirrors the `compactionQueue.getStats()` pattern
 * (see `daemon/compaction/queue.ts`).
 */
export function getPushDebouncerMetrics(): PushDebouncerMetrics {
  return { ..._pushMetrics };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Milliseconds to wait after the last write before firing the push. */
export const DEBOUNCE_MS = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CortexState {
  /** Timeout handle for the pending debounce. */
  timer: ReturnType<typeof setTimeout> | null;
  /** Number of writes that have arrived since the last push attempt. */
  pendingCount: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a git subcommand asynchronously in the given directory.
 *
 * `opts.stdin` feeds bytes to the child's stdin (used by the plumbing path's
 * `git hash-object --stdin`). `opts.env` layers extra environment on top of
 * the hardened `safeGitEnv()` base (used to thread a scratch `GIT_INDEX_FILE`
 * so plumbing tree-builds never touch the shared index/worktree).
 */
function runGitAsync(
  args: string[],
  cwd: string,
  opts?: { stdin?: string; env?: NodeJS.ProcessEnv },
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Apply the canonical security posture from lib/git.ts: disable hooks,
    // fsmonitor, and use the shared env-strip helper.
    const fullArgs = [
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.fsmonitor=',
      ...args,
    ];

    const env = opts?.env ? { ...safeGitEnv(), ...opts.env } : safeGitEnv();
    const child = execFile(
      'git',
      fullArgs,
      { cwd, encoding: 'utf-8', env, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const message = (err instanceof Error ? err.message : String(err)) +
            (stderr ? `\n${stderr}` : '');
          reject(new Error(message));
        } else {
          resolve((stdout ?? '').trim());
        }
      },
    );
    if (opts?.stdin !== undefined) {
      child.stdin?.end(opts.stdin);
    }
  });
}

/** Write a timestamped push-debouncer line to both stderr and daemon.log. */
function log(msg: string): void {
  daemonLog('push-debouncer', msg);
}

// ---------------------------------------------------------------------------
// PushDebouncer
// ---------------------------------------------------------------------------

export class PushDebouncer {
  private readonly states = new Map<string, CortexState>();
  private readonly debounceMs: number;

  /**
   * Global async mutex serializing `_executePush` across all cortices.
   *
   * Reason: the cortex repo at `<repoPath>` is a shared working tree — only
   * one branch is checked out at a time, and every push cycle does
   * `git switch <branch> + git add + git commit + git pull --rebase + git push`.
   * Two concurrent `_executePush` calls for different cortices would race on
   * the working tree: the second cortex's `git switch` runs while the first
   * cortex's tree is still dirty (mid-commit or mid-pull-rebase), producing
   * the original AGT-437 / #65 error:
   *   "Your local changes to the following files would be overwritten by
   *    checkout: <other-cortex>/000001.jsonl"
   *
   * The promise chain pattern below preserves FIFO ordering of acquirers
   * without any external dependency. Each `_withExecuteLock` call awaits the
   * previous holder's release before running its callback.
   */
  private _executeLock: Promise<void> = Promise.resolve();

  /**
   * Optional git-execution override for testing. When set, this function is
   * called instead of `runGitAsync` so unit tests can mock git commands
   * without spawning real subprocesses.
   *
   * @internal Not part of the public API.
   */
  _gitOverride?: (
    args: string[],
    cwd: string,
    opts?: { stdin?: string; env?: NodeJS.ProcessEnv },
  ) => Promise<string>;

  /**
   * @param debounceMs  Override debounce delay in milliseconds. Defaults to
   *                    DEBOUNCE_MS (500ms). Pass a smaller value in unit tests
   *                    so tests complete quickly without fake timers.
   *
   * @internal The `debounceMs` parameter is not part of the public API.
   */
  constructor(debounceMs: number = DEBOUNCE_MS) {
    this.debounceMs = debounceMs;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Notify the debouncer that a write occurred for the given cortex.
   * Each call resets the debounce timer and increments the pending-entry
   * counter. When the timer fires, one `git add + commit + push` sequence
   * is executed for all writes accumulated in the window.
   *
   * @param cortex    Cortex name (validated via sanitizeName).
   * @param skipPush  When true, skip the remote push (local commit still fires).
   *                  Used by AGT-293 offline mode. In a burst where multiple
   *                  calls arrive within the debounce window, the last call's
   *                  `skipPush` value takes effect (last-write-wins).
   */
  notify(cortex: string, skipPush = false): void {
    let safeCortex: string;
    try {
      safeCortex = sanitizeName(cortex);
    } catch (err) {
      log(`notify skipped — invalid cortex name "${cortex}": ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    let state = this.states.get(safeCortex);
    if (state === undefined) {
      state = { timer: null, pendingCount: 0 };
      this.states.set(safeCortex, state);
    }

    state.pendingCount += 1;

    // Cancel any existing timer so the burst coalesces into one push.
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    state.timer = setTimeout(() => {
      state!.timer = null;

      // Take the current count and reset it so overlapping `notify()` calls
      // that land while the push is in-flight create a fresh pending batch.
      const count = state!.pendingCount;
      state!.pendingCount = 0;

      // Defer execution so the sync handler's return path is not blocked by
      // the first git I/O syscall dispatch.
      setImmediate(() => {
        void this._executePush(safeCortex, count, skipPush);
      });
    }, this.debounceMs);
  }

  /**
   * Flush any pending writes for `cortex` immediately, bypassing the debounce
   * timer. Returns when the push cycle has completed (or failed and logged).
   *
   * Test seam: handleSync no longer writes L1 directly — it inserts into
   * `l1_outbox` and notifies this debouncer. Tests that previously asserted
   * "L1 page contains the entry right after handleSync returns" can call
   * `await pushDebouncer.flush(cortex)` to deterministically drain the queue.
   *
   * Production callers can also use this for synchronous semantics when the
   * debounce window is too long for the operation in flight (e.g. a CLI
   * command that wants the write durable in L1 before returning to the user).
   */
  async flush(cortex: string, skipPush = false): Promise<void> {
    let safeCortex: string;
    try {
      safeCortex = sanitizeName(cortex);
    } catch (err) {
      log(`flush skipped — invalid cortex name "${cortex}": ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const state = this.states.get(safeCortex);
    if (state?.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    const count = state?.pendingCount ?? 0;
    if (state) state.pendingCount = 0;

    await this._executePush(safeCortex, count, skipPush);
  }

  // ---------------------------------------------------------------------------
  // Internal push execution
  // ---------------------------------------------------------------------------

  /**
   * Acquire the global execute lock, run `fn`, release. FIFO ordering is
   * preserved by chaining each acquirer onto the prior holder's promise.
   *
   * Why a single mutex across all cortices: see `_executeLock` field comment.
   * Briefly — the shared working tree at `<repoPath>` can only have one
   * branch checked out at a time, so two cortices' push cycles must not
   * interleave or the second's `git switch` will trip on the first's dirty
   * tree.
   */
  private async _withExecuteLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this._executeLock;
    let release!: () => void;
    this._executeLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Run the git add → commit → push sequence for a single cortex.
   * Logs the full error on any failure; does NOT retry (the next `notify()`
   * triggers a fresh cycle — event-driven, no background retry loop).
   *
   * Serialized globally via `_withExecuteLock` — two cortices' executions
   * never interleave on the shared working tree.
   *
   * As of the outbox refactor, the L1 file append happens here (not in
   * handleSync). After switching to the cortex branch, we drain pending
   * `l1_outbox` rows for the cortex, append each row's serialized JSONL
   * line to the active L1 page, stage + commit, then `DELETE` the rows.
   * If anything throws before the DELETE the rows survive and a later cycle
   * picks them up — provides durability against daemon crashes.
   */
  private async _executePush(
    safeCortex: string,
    count: number,
    skipPush: boolean,
  ): Promise<void> {
    return this._withExecuteLock(() => this._executePushLocked(safeCortex, count, skipPush));
  }

  /**
   * Delete the named outbox rows for a cortex. Errors are logged but not
   * re-thrown — we've already committed locally, so a failed DELETE is
   * cosmetic (next cycle would re-append, producing duplicate lines in L1).
   * L2's `INSERT OR IGNORE` and downstream sync's deduplication absorb any
   * resulting JSONL duplicates without corrupting recall results.
   */
  private _deleteOutboxRows(safeCortex: string, ids: number[]): void {
    if (ids.length === 0) return;
    try {
      const db = getCortexDb(safeCortex);
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`DELETE FROM l1_outbox WHERE id IN (${placeholders})`).run(...ids);
    } catch (err) {
      log(
        `failed to delete ${ids.length} outbox row(s) for cortex '${safeCortex}' ` +
          `(rows will be retried — may produce duplicate L1 lines): ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  /**
   * Maximum push attempts before giving up for this cycle. The next `notify()`
   * (triggered by the next write) fires a fresh cycle.
   */
  private static readonly MAX_PUSH_ATTEMPTS = 3;

  private async _executePushLocked(
    safeCortex: string,
    count: number,
    skipPush: boolean,
  ): Promise<void> {
    const usePlumbing = getConfig().cortex?.plumbingWrites !== false;
    if (usePlumbing) {
      return this._executePlumbingLocked(safeCortex, count, skipPush);
    }
    return this._executeLegacyLocked(safeCortex, count, skipPush);
  }

  /**
   * Plumbing write path (#70 Option B / AGT-458). Appends drained outbox rows
   * to the cortex branch via git plumbing (`hash-object`/`read-tree`/
   * `commit-tree`/`update-ref`) WITHOUT a `git switch` on the shared worktree,
   * then pushes the branch ref. Because the worktree is never touched, a
   * concurrent write to a different cortex can never trip on this cortex's
   * dirty tree — the #70/#65/#69 switch-race class is structurally gone.
   *
   * On a non-fast-forward push rejection the local ref is hard-reset to the
   * freshly-fetched remote tip (`forceResetToRemote`) before re-appending and
   * retrying. This makes the local ref a guaranteed descendant of origin at push
   * time, breaking the permanent non-FF loop (AGT-478 root cause: prior path
   * reset to `parent` — the same stale tip — so the push was always non-FF).
   *
   * A large-behind short-circuit: if `behind >= LARGE_BEHIND_THRESHOLD` before
   * the first append attempt, take the force-reset path immediately (attempt 1)
   * rather than waiting for the push to bounce, so deeply stale clones
   * self-heal in one retry cycle. Configurable via
   * `cortex.largeBehindThreshold` (default 10).
   *
   * Outbox rows are deleted only after a successful push (or, with `skipPush`,
   * after the local ref advance) so a crash mid-cycle leaves them for the next
   * drain.
   */
  private async _executePlumbingLocked(
    safeCortex: string,
    count: number,
    skipPush: boolean,
  ): Promise<void> {
    const repoPath = getRepoPath();
    const git = this._gitOverride ?? runGitAsync;
    const hasRealGit = fs.existsSync(path.join(repoPath, '.git'));

    try {
      // Ensure the union merge driver is active in `.git/info/attributes` BEFORE
      // any rebase that touches `.jsonl` files. Mirrors the legacy path; idempotent.
      // Guard on a real `.git` so unit tests (mocked git, no repo on disk) skip it.
      if (hasRealGit) {
        ensureLocalUnionMergeAttribute();
      }

      // --- read l1_outbox (FIFO) ---
      let rows: { id: number; line: string }[] = [];
      try {
        const db = getCortexDb(safeCortex);
        rows = db.prepare('SELECT id, line FROM l1_outbox ORDER BY id ASC').all() as
          { id: number; line: string }[];
      } catch (drainErr) {
        throw new Error(
          `outbox read failed for cortex '${safeCortex}': ` +
            (drainErr instanceof Error ? drainErr.message : String(drainErr)),
        );
      }

      if (rows.length === 0) {
        // Pre-outbox direct writers (event-curator, scheduler) previously
        // dirtied the worktree and relied on this cycle's `git add`. With the
        // plumbing path every writer enqueues to the outbox instead, so an
        // empty outbox genuinely means nothing to do — even when the legacy
        // `count` is non-zero (a notify() with no enqueued row).
        log(`nothing to commit for cortex '${safeCortex}' (outbox empty)`);
        return;
      }

      const drainedIds = rows.map((r) => r.id);
      const lines = rows.map((r) => r.line);
      const effectiveCount = Math.max(lines.length, count);
      const commitMsg = `auto: ${effectiveCount} ${effectiveCount === 1 ? 'entry' : 'entries'} via daemon ${new Date().toISOString()}`;

      // Large-behind short-circuit (AC #3). Compute how many commits behind
      // origin we are AFTER the fetch inside the first appendLinesViaPlumbing
      // call would run. We do a lightweight pre-fetch here only when in a real
      // repo so the test seam (no real git) skips this check cleanly. The
      // `behind` count determines whether attempt 1 should immediately use
      // forceResetToRemote instead of first trying the normal append.
      const LARGE_BEHIND_THRESHOLD =
        getConfig().cortex?.largeBehindThreshold ?? 10;
      let startWithReset = false;
      if (hasRealGit) {
        try {
          await git(['fetch', 'origin', '--', safeCortex], repoPath);
          const behindOut = await git(
            [
              'rev-list', '--count',
              `refs/heads/${safeCortex}..refs/remotes/origin/${safeCortex}`,
            ],
            repoPath,
          );
          const behind = parseInt(behindOut.trim(), 10);
          if (!isNaN(behind) && LARGE_BEHIND_THRESHOLD > 0 && behind >= LARGE_BEHIND_THRESHOLD) {
            startWithReset = true;
            log(
              `cortex '${safeCortex}' is ${behind} commits behind origin ` +
                `(threshold=${LARGE_BEHIND_THRESHOLD}) — taking force-reset path on attempt 1`,
            );
          }
        } catch {
          // Pre-flight fetch/rev-list failed (new cortex, offline, etc.) —
          // proceed with the normal path; the push will surface real errors.
        }
      }

      // Append + advance the branch ref via plumbing, retrying on a non-FF
      // push by hard-resetting the local ref to the re-fetched remote tip and
      // rebuilding on top of it. `forceResetToRemote` ensures the local ref is
      // always a descendant of origin at push time (fixes AGT-478 root cause).
      const MAX = PushDebouncer.MAX_PUSH_ATTEMPTS;
      let lastErr: unknown;
      let lastErrIsNonFF = false;
      for (let attempt = 1; attempt <= MAX; attempt++) {
        // On attempt 1 use forceResetToRemote when the clone was already far
        // behind. On subsequent attempts (after a push rejection), always use
        // forceResetToRemote so the retry never builds on the same stale base.
        const forceResetToRemote = startWithReset || attempt > 1;
        const { commit } = await appendLinesViaPlumbing(
          git,
          repoPath,
          safeCortex,
          lines,
          commitMsg,
          // fetchFirst: skip the network round-trip when no real repo (mocked git
          // seam). When forceResetToRemote is true the fetch is internal to
          // appendLinesViaPlumbing (it needs the remote tip before resetting);
          // the pre-flight fetch above already ran, but a re-fetch inside is
          // cheap (git deduplicates) and ensures the tip is fresh at reset time.
          { fetchFirst: hasRealGit && !this._gitOverride, forceResetToRemote },
        );
        log(`appended ${lines.length} ${lines.length === 1 ? 'entry' : 'entries'} to '${safeCortex}' via plumbing (commit ${commit.slice(0, 12)})`);

        if (skipPush) {
          log(`push suppressed for cortex '${safeCortex}' (skipPush=true)`);
          this._deleteOutboxRows(safeCortex, drainedIds);
          return;
        }

        try {
          await git(['push', 'origin', `refs/heads/${safeCortex}:refs/heads/${safeCortex}`], repoPath);
          log(`pushed cortex '${safeCortex}' to origin`);
          _pushMetrics.pushSuccesses++;
          this._deleteOutboxRows(safeCortex, drainedIds);
          return;
        } catch (pushErr) {
          lastErr = pushErr;
          const pmsg = pushErr instanceof Error ? pushErr.message : String(pushErr);
          const isNonFastForward = /rejected|fetch first|non-fast-forward|stale info/i.test(pmsg);
          if (!isNonFastForward) {
            // Auth/network/other — surface immediately, don't spin.
            throw pushErr;
          }
          lastErrIsNonFF = true;
          log(
            `push rejected for cortex '${safeCortex}' (attempt ${attempt}/${MAX}, ` +
              `non-fast-forward) — will force-reset to remote tip on next attempt`,
          );
          // forceResetToRemote=true on next loop iteration ensures the local ref
          // is hard-reset to the freshly-fetched origin tip before re-appending.
          // (No explicit update-ref here — the reset happens inside
          // appendLinesViaPlumbing at the top of the next iteration.)
        }
      }

      // All attempts exhausted with a non-FF still outstanding: surface in
      // metrics so operators can observe without scraping daemon.log (AC #5).
      if (lastErrIsNonFF) {
        _pushMetrics.pushFailuresNonFastForward++;
        _pushMetrics.lastPushErrorAt = new Date().toISOString();
      }

      throw (
        lastErr ??
        new Error(`push failed for cortex '${safeCortex}' after ${MAX} attempts`)
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`push failed for cortex '${safeCortex}' (will retry on next write): ${msg}`);
    }
  }

  /**
   * Legacy worktree write path (pre-AGT-458). Kept behind
   * `cortex.plumbingWrites: false` as a reversible escape hatch while the
   * plumbing path soaks. Switches the shared worktree to the cortex branch,
   * drains the outbox by appending to the worktree page file, then
   * `git add`/`commit`/`pull --rebase`/`push`. This path carries the #69
   * dirty-worktree self-heal because the switch can be wedged by a leftover.
   */
  private async _executeLegacyLocked(
    safeCortex: string,
    count: number,
    skipPush: boolean,
  ): Promise<void> {
    const repoPath = getRepoPath();

    const git = this._gitOverride ?? runGitAsync;

    try {
      // Re-establish the cortex's branch before staging. (Legacy path only —
      // post-AGT-458 every writer enqueues to `l1_outbox` and the default
      // plumbing drain needs no checkout.) A concurrent write to a *different*
      // cortex (or an operator command) may have switched the tree out during
      // the debounce window. Without this re-switch, `git add -- <safeCortex>`
      // would stage the diff on the wrong branch and the commit would land
      // there. The check is a cheap `rev-parse` first to avoid a redundant
      // switch when the branch is
      // already correct.
      const currentBranch = (await git(
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        repoPath,
      )).trim();
      // Idempotent branch setup — mirrors ensureOnBranch in lib/git.ts but
      // uses the async `git` seam so the `_gitOverride` test double sees
      // these calls. The old `try { switch -- } catch { switch -c }` pattern
      // was fragile: any transient `switch --` failure on an *existing* branch
      // fell through to `switch -c` → "fatal: a branch named '<x>' already
      // exists". Replace with an explicit local-ref check (rev-parse) so the
      // decision is deterministic regardless of transient errors.
      if (currentBranch !== safeCortex) {
        // Self-heal (#69): a prior cycle (this cortex or another) may have
        // crashed after appending to the L1 page but before committing,
        // leaving the shared worktree dirty on `currentBranch`. `git switch`
        // refuses to overwrite uncommitted changes, which would wedge branch
        // switching for EVERY cortex until a human cleans the tree. Commit the
        // leftover on its own branch (it belongs there by the orphan-branch
        // invariant) so the switch starts clean — preserving the data rather
        // than resetting it away. Mirrors `lib/git.ts:salvageDirtyWorktree`.
        // Stage only TRACKED changes (`git add -u`) — untracked files don't
        // block the switch and shouldn't be swept into cortex history.
        // Guarded on a real `.git` (like the union-driver step below) so the
        // call-count unit tests — which mock git with no repo on disk — don't
        // see the salvage's extra add/diff/commit.
        if (fs.existsSync(path.join(repoPath, '.git'))) {
          await git(['add', '-u'], repoPath);
          const hasTrackedDirt = await git(['diff', '--cached', '--quiet'], repoPath)
            .then(() => false, () => true);
          if (hasTrackedDirt) {
            await git(
              [
                'commit',
                '-m',
                `chore(cortex): salvage uncommitted worktree changes on ${currentBranch} (self-heal #69)`,
              ],
              repoPath,
            );
            log(
              `self-healed dirty worktree on '${currentBranch}' before switching to '${safeCortex}' (#69)`,
            );
          }
        }
        const localRefExists = await git(
          ['rev-parse', '--verify', '--quiet', `refs/heads/${safeCortex}`],
          repoPath,
        ).then(() => true, () => false);
        if (localRefExists) {
          await git(['switch', '--', safeCortex], repoPath);
          // Fast-forward toward origin if behind; swallow "unborn upstream"
          // and "not possible to fast-forward" — the subsequent pull-rebase
          // reconciles divergence via the union driver.
          try {
            await git(['merge', '--ff-only', `origin/${safeCortex}`], repoPath);
          } catch (ffErr) {
            const ffMsg = ffErr instanceof Error ? ffErr.message : String(ffErr);
            if (
              !ffMsg.includes(GIT_FF_ONLY_NO_REMOTE_REF) &&
              !ffMsg.includes(GIT_FF_ONLY_NOT_MERGEABLE)
            ) {
              throw ffErr;
            }
          }
        } else {
          await git(
            ['switch', '-c', safeCortex, '--', `origin/${safeCortex}`],
            repoPath,
          );
        }
      }

      // Ensure the union merge driver is committed on this branch BEFORE the
      // pull-rebase below, so a page that another node also appended to
      // reconciles losslessly instead of throwing a rebase conflict. Mirrors
      // `lib/git.ts:ensureUnionMergeAttribute`, inlined to use the async git
      // seam (so the `_gitOverride` test double sees these calls). Committed
      // as its own commit; rides along on the push. Idempotent — the
      // `withUnionMergeAttribute` helper returns null once the line exists,
      // so steady-state cycles skip the write+commit entirely.
      // Guard on a real `.git` so unit tests (which mock `git` but have no
      // repo on disk) don't write a stray `.gitattributes`. Mirrors the
      // no-op-outside-a-repo behavior of `ensureUnionMergeAttribute`.
      if (fs.existsSync(path.join(repoPath, '.git'))) {
        // Always-effective local union driver — the load-bearing half. The
        // committed `.gitattributes` below can't bootstrap union during the
        // rebase that introduces it (rebase reads attributes from the origin
        // tree, which lacks the file); `.git/info/attributes` is active
        // immediately. Pure fs, idempotent.
        ensureLocalUnionMergeAttribute();
        const attrPath = path.join(repoPath, '.gitattributes');
        let attrCurrent = '';
        try {
          attrCurrent = fs.readFileSync(attrPath, 'utf-8');
        } catch {
          /* absent — treated as empty */
        }
        const attrNext = withUnionMergeAttribute(attrCurrent);
        if (attrNext !== null) {
          fs.writeFileSync(attrPath, attrNext, 'utf-8');
          await git(['add', '--', '.gitattributes'], repoPath);
          await git(
            ['commit', '-m', `chore(cortex): union merge driver for *.jsonl on ${safeCortex}`],
            repoPath,
          );
          log(`added union merge driver (.gitattributes) for cortex '${safeCortex}'`);
        }
      }

      // --- drain l1_outbox ---
      // handleSync enqueues each retro/memory/event as a row in this cortex's
      // `l1_outbox` table; the actual L1 file append happens here, inside the
      // global execute lock, so no concurrent cortex can dirty the tree
      // mid-switch. The rows are read in FIFO order (autoincrement id) and
      // their serialized JSONL lines are written verbatim. We capture the
      // ids so the DELETE after the commit only removes rows we actually
      // processed — new rows that landed during the append+commit window
      // stay pending for the next cycle.
      let drainedIds: number[] = [];
      try {
        const db = getCortexDb(safeCortex);
        const rows = db.prepare(
          'SELECT id, line FROM l1_outbox ORDER BY id ASC',
        ).all() as { id: number; line: string }[];
        if (rows.length > 0) {
          const cortexDir = path.join(repoPath, safeCortex);
          for (const row of rows) {
            appendRawLineToL1Page(cortexDir, row.line);
          }
          drainedIds = rows.map((r) => r.id);
          log(`drained ${rows.length} outbox ${rows.length === 1 ? 'row' : 'rows'} for cortex '${safeCortex}'`);
        }
      } catch (drainErr) {
        // Don't swallow — propagate so the outer catch logs it and the rows
        // stay in the outbox for the next cycle. Re-throwing here aborts
        // before any DELETE so durability is preserved.
        throw new Error(
          `outbox drain failed for cortex '${safeCortex}': ` +
            (drainErr instanceof Error ? drainErr.message : String(drainErr)),
        );
      }

      // Use the larger of the drain count and the legacy `notify()` count —
      // pre-outbox writers (event-curator, scheduler) still call notify()
      // with pendingCount and dirty the tree directly; they aren't reflected
      // in `drainedIds`. Either source contributes to the commit message.
      const effectiveCount = Math.max(drainedIds.length, count);
      const commitMsg = `auto: ${effectiveCount} ${effectiveCount === 1 ? 'entry' : 'entries'} via daemon ${new Date().toISOString()}`;

      // Stage all changes in the cortex sub-directory.
      await git(['add', '--', safeCortex], repoPath);

      // Detect whether there is anything staged. `diff --cached --quiet`
      // exits 0 when the staged area is clean, non-zero when changes exist.
      let hasStagedChanges: boolean;
      try {
        await git(['diff', '--cached', '--quiet', '--', safeCortex], repoPath);
        hasStagedChanges = false; // exit 0 → nothing staged
      } catch {
        hasStagedChanges = true; // non-zero exit → staged changes present
      }

      if (!hasStagedChanges) {
        log(`nothing to commit for cortex '${safeCortex}' (staged area is clean)`);
        // Even with nothing staged, if we drained rows (and somehow the append
        // produced no diff — corrupt state) leaving them in the outbox would
        // cause re-append on every cycle. We didn't enter this branch in
        // practice because appendRawLineToL1Page always changes the file, but
        // the early-return must still clean up the outbox to avoid an
        // accumulating queue. Safe to DELETE: the rows were either committed
        // by an earlier cycle (and the file's content already reflects them)
        // or the drain wrote them and a subsequent op reverted — in either
        // case the L1 file is the source of truth from here forward.
        if (drainedIds.length > 0) {
          this._deleteOutboxRows(safeCortex, drainedIds);
        }
        return;
      }

      await git(['commit', '-m', commitMsg], repoPath);
      log(`committed ${effectiveCount} ${effectiveCount === 1 ? 'entry' : 'entries'} for cortex '${safeCortex}'`);

      // The local commit is durable in git history — the data is now safe
      // even if the upcoming push fails. Drop the outbox rows so the next
      // cycle doesn't re-append them.
      if (drainedIds.length > 0) {
        this._deleteOutboxRows(safeCortex, drainedIds);
      }

      if (skipPush) {
        log(`push suppressed for cortex '${safeCortex}' (skipPush=true)`);
        return;
      }

      // Pull-rebase before push, with bounded retry on non-fast-forward.
      //
      // The cortex branch is a SHARED ref: the proxy is not the only writer
      // — an operator's local daemon (or another proxy) commits to the same
      // `cortex/<name>` branch. So `origin` can carry commits this clone
      // doesn't have, and a bare `git push` bounces with "fetch first" /
      // non-fast-forward. The CLI write path (`lib/git.ts:appendAndCommit`
      // → `pullRebaseOrAbort`) already rebases before pushing; the
      // push-debouncer historically did not, which made every proxy push
      // fail the moment any other writer touched the branch.
      //
      // We rebase our just-made commit on top of origin (append-only JSONL
      // rebases cleanly — distinct writers append distinct lines), then
      // push. If origin advances again in the window between our pull and
      // our push, the push bounces and we loop: re-pull, re-push, up to
      // MAX_PUSH_ATTEMPTS. A non-rejection push error (auth, network) is
      // surfaced immediately rather than spun on.
      const MAX_PUSH_ATTEMPTS = 3;
      let pushed = false;
      let lastPushErr: unknown;
      for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
        // pull --rebase origin <branch>; abort on conflict so the tree
        // doesn't linger mid-rebase across attempts.
        try {
          await git(['pull', '--rebase', 'origin', '--', safeCortex], repoPath);
        } catch (pullErr) {
          const pmsg = pullErr instanceof Error ? pullErr.message : String(pullErr);
          if (pmsg.includes('CONFLICT') || pmsg.includes('could not apply')) {
            try {
              await git(['rebase', '--abort'], repoPath);
            } catch {
              /* best effort — leave no rebase-in-progress for the next cycle */
            }
            throw new Error(
              `Rebase conflict on '${safeCortex}' during push-debounce. This should not ` +
                `happen with append-only JSONL — if it recurs, open an issue at ` +
                `https://github.com/OpenThinkAi/think-cli/issues with the git output above.`,
            );
          }
          // Otherwise acceptable: e.g. the branch has no upstream yet (the
          // very first push of a brand-new cortex). Swallow and let the
          // push below either succeed or surface a clearer error.
        }

        try {
          // `--` before the branch name separates it from any preceding options.
          await git(['push', 'origin', '--', safeCortex], repoPath);
          pushed = true;
          break;
        } catch (pushErr) {
          lastPushErr = pushErr;
          const pmsg = pushErr instanceof Error ? pushErr.message : String(pushErr);
          const isNonFastForward = /rejected|fetch first|non-fast-forward|stale info/i.test(pmsg);
          if (!isNonFastForward) {
            // Auth/network/other — don't spin, surface immediately.
            throw pushErr;
          }
          log(
            `push rejected for cortex '${safeCortex}' (attempt ${attempt}/${MAX_PUSH_ATTEMPTS}, ` +
              `origin advanced) — re-pulling and retrying`,
          );
        }
      }

      if (pushed) {
        log(`pushed cortex '${safeCortex}' to origin`);
      } else {
        throw (
          lastPushErr ??
          new Error(`push failed for cortex '${safeCortex}' after ${MAX_PUSH_ATTEMPTS} attempts`)
        );
      }
    } catch (err) {
      // Log the full error; event-driven retry fires on next notify() call.
      const msg = err instanceof Error ? err.message : String(err);
      log(`push failed for cortex '${safeCortex}' (will retry on next write): ${msg}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

/**
 * Process-global push debouncer. Imported by the sync handler to schedule
 * a push after every L1 write.
 */
export const pushDebouncer = new PushDebouncer();
