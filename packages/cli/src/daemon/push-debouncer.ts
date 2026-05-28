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
import { appendRawLineToL1Page } from '../lib/l1-page.js';
import { getCortexDb } from '../db/engrams.js';
import { daemonLog } from './log.js';

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

/** Run a git subcommand asynchronously in the given directory. */
function runGitAsync(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Apply the canonical security posture from lib/git.ts: disable hooks,
    // fsmonitor, and use the shared env-strip helper.
    const fullArgs = [
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.fsmonitor=',
      ...args,
    ];

    execFile('git', fullArgs, { cwd, encoding: 'utf-8', env: safeGitEnv() }, (err, stdout, stderr) => {
      if (err) {
        const message = (err instanceof Error ? err.message : String(err)) +
          (stderr ? `\n${stderr}` : '');
        reject(new Error(message));
      } else {
        resolve((stdout ?? '').trim());
      }
    });
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
  _gitOverride?: (args: string[], cwd: string) => Promise<string>;

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

  private async _executePushLocked(
    safeCortex: string,
    count: number,
    skipPush: boolean,
  ): Promise<void> {
    const repoPath = getRepoPath();

    const git = this._gitOverride ?? runGitAsync;

    try {
      // Re-establish the cortex's branch before staging. Writes earlier in
      // this cycle already called `ensureBranchCheckedOut(safeCortex)` at
      // the sync-handler / compaction / proxy seam, but a concurrent write
      // to a *different* cortex (or an operator command) may have switched
      // the tree out again during the 500ms debounce window. Without this
      // re-switch, `git add -- <safeCortex>` would stage the diff on the
      // wrong branch and the commit would land there. The check is a cheap
      // `rev-parse` first to avoid a redundant switch when the branch is
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
