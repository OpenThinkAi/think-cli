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
 * - Off-loop execution: the git operations run inside a new Promise resolved
 *   via setImmediate, keeping them off the daemon's synchronous event loop
 *   so they cannot block recall queries.
 * - No infinite retry: on push failure the error is logged and the counter
 *   is reset. The next `notify()` call (triggered by the next write) will
 *   fire a fresh debounce cycle.
 * - skipPush flag (AGT-293): callers can suppress the push for this
 *   cortex on the current cycle (e.g., during offline tests).
 */

import { execFile } from 'node:child_process';
import { getRepoPath, sanitizeName } from '../lib/paths.js';

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

/** Run a git subcommand in a given directory, returning stdout. */
function runGitAsync(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Inherit the same security posture as lib/git.ts: disable hooks,
    // fsmonitor, and strip env vars that alter git behaviour.
    const safeEnv: NodeJS.ProcessEnv = { ...process.env };
    delete safeEnv.GIT_SSH_COMMAND;
    delete safeEnv.GIT_PROXY_COMMAND;
    delete safeEnv.GIT_ASKPASS;
    delete safeEnv.GIT_CONFIG_GLOBAL;
    delete safeEnv.GIT_CONFIG_SYSTEM;
    delete safeEnv.GIT_WORK_TREE;
    delete safeEnv.GIT_DIR;
    delete safeEnv.GIT_EXEC_PATH;
    safeEnv.GIT_CONFIG_NOSYSTEM = '1';
    safeEnv.GIT_TEMPLATE_DIR = '';

    const fullArgs = [
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.fsmonitor=',
      ...args,
    ];

    execFile('git', fullArgs, { cwd, encoding: 'utf-8', env: safeEnv }, (err, stdout, stderr) => {
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

/** Write a timestamped line to stderr (daemon log). */
function log(msg: string): void {
  process.stderr.write(`[${new Date().toISOString()}] [push-debouncer] ${msg}\n`);
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
   * Each call resets the 500ms timer and increments the pending-entry counter.
   * When the timer fires, one `git add + commit + push` is executed.
   *
   * @param cortex    Cortex name (must be safe — validated by sanitizeName).
   * @param skipPush  When true, skip the remote push (local commit still fires).
   *                  Used by AGT-293 offline mode.
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

    // Cancel any existing timer (the burst coalesces into one push).
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    // Capture state for the closure at fire time.
    const capturedState = state;

    capturedState.timer = setTimeout(() => {
      capturedState.timer = null;

      // Take the current count and reset it so overlapping `notify()` calls
      // that land while the push is in-flight create a fresh pending batch.
      const count = capturedState.pendingCount;
      capturedState.pendingCount = 0;

      // Execute off the event loop so git I/O doesn't block recall queries.
      setImmediate(() => {
        new Promise<void>(resolve => {
          this._executePush(safeCortex, count, skipPush)
            .then(resolve)
            .catch(resolve); // errors are logged inside _executePush; never reject
        });
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
      // Stage all changes in the cortex sub-directory.
      await git(['add', '--', safeCortex], repoPath);

      // Check if there is anything to commit.
      let hasStagedChanges: boolean;
      try {
        await git(['diff', '--cached', '--quiet', '--', safeCortex], repoPath);
        // Exit code 0 means no changes.
        hasStagedChanges = false;
      } catch {
        // Non-zero exit code means there are staged changes.
        hasStagedChanges = true;
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

      await git(['push', 'origin', '--', safeCortex], repoPath);
      log(`pushed cortex '${safeCortex}' to origin`);
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
