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
import { safeGitEnv, withUnionMergeAttribute } from '../lib/git.js';
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

  // ---------------------------------------------------------------------------
  // Internal push execution
  // ---------------------------------------------------------------------------

  /**
   * Run the git add → commit → push sequence for a single cortex.
   * Logs the full error on any failure; does NOT retry (the next `notify()`
   * triggers a fresh cycle — event-driven, no background retry loop).
   */
  private async _executePush(
    safeCortex: string,
    count: number,
    skipPush: boolean,
  ): Promise<void> {
    const repoPath = getRepoPath();
    const commitMsg = `auto: ${count} ${count === 1 ? 'entry' : 'entries'} via daemon ${new Date().toISOString()}`;

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
      if (currentBranch !== safeCortex) {
        try {
          await git(['switch', '--', safeCortex], repoPath);
        } catch {
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
        return;
      }

      await git(['commit', '-m', commitMsg], repoPath);
      log(`committed ${count} ${count === 1 ? 'entry' : 'entries'} for cortex '${safeCortex}'`);

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
