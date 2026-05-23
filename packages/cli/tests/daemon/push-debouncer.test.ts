/**
 * Tests for PushDebouncer — AGT-309
 *
 * Coverage:
 * 1. Burst: 5 notify() calls within 200ms → exactly one commit + one push
 *    fires 500ms after the last write.
 * 2. Commit message format: "auto: N entries via daemon <ISO>".
 * 3. Two independent cortexes: each gets its own debounce cycle.
 * 4. skipPush=true: git add + commit fires, push is suppressed.
 * 5. Nothing-to-commit: when staged area is clean the sequence stops after
 *    git add (no error thrown, no commit attempted).
 *
 * Git commands are mocked via _gitOverride so no real subprocess is spawned.
 * We use a 10ms debounce delay in tests so they complete quickly without
 * needing fake timers (which interact poorly with setImmediate chains).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PushDebouncer } from '../../src/daemon/push-debouncer.js';

// ---------------------------------------------------------------------------
// Test debounce delay — short enough that tests complete quickly
// ---------------------------------------------------------------------------

const TEST_DEBOUNCE_MS = 10;

// ---------------------------------------------------------------------------
// Isolation: point THINK_HOME at a fresh temp dir so getRepoPath() never
// resolves to the developer's real cortex repo. The repo dir is created
// WITHOUT a `.git`, so the push-debouncer's `.gitattributes` self-heal step
// (guarded on `.git` existing) is a no-op for the call-count tests below —
// they assert on the git command sequence via the mock, not on real fs.
// The dedicated `.gitattributes` test creates a `.git` to opt that step in.
// ---------------------------------------------------------------------------

let prevThinkHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
  prevThinkHome = process.env.THINK_HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'think-pushdeb-'));
  process.env.THINK_HOME = tmpHome;
  fs.mkdirSync(path.join(tmpHome, 'repo'), { recursive: true });
});

afterEach(() => {
  if (prevThinkHome === undefined) delete process.env.THINK_HOME;
  else process.env.THINK_HOME = prevThinkHome;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock git implementation that records calls and can be configured
 * to simulate "nothing to commit" (diff --cached --quiet exits 0).
 *
 * Returns an `impl` function to inject via `_gitOverride`, a `calls` array
 * for assertions, and a `completion` Promise that resolves once the final
 * expected git call has arrived (determined by the caller passing a resolve
 * callback).
 */
function buildGitMock(opts: { nothingToCommit?: boolean } = {}) {
  const calls: Array<{ args: string[]; cwd: string }> = [];

  const impl = async (args: string[], cwd: string): Promise<string> => {
    calls.push({ args, cwd });

    // `diff --cached --quiet` — exit 0 means clean, non-zero means dirty.
    if (args.includes('--cached') && args.includes('--quiet')) {
      if (opts.nothingToCommit) {
        // Simulate "nothing to commit": return normally (no throw).
        return '';
      }
      // Simulate staged changes: throw so the caller treats it as dirty.
      throw new Error('exit code 1');
    }

    return '';
  };

  return { impl, calls };
}

/**
 * Wait until the `calls` array length reaches `targetLength`, polling every
 * 5ms. Gives up after `timeoutMs` and throws a helpful error.
 */
async function waitForCalls(
  calls: Array<{ args: string[]; cwd: string }>,
  targetLength: number,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (calls.length < targetLength) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${targetLength} git calls; got ${calls.length}: ` +
          JSON.stringify(calls.map(c => c.args[0])),
      );
    }
    await new Promise(r => setTimeout(r, 5));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PushDebouncer', () => {
  it('burst: 5 writes within 200ms → exactly one commit and one push after the debounce window', async () => {
    const { impl, calls } = buildGitMock();
    const debouncer = new PushDebouncer(TEST_DEBOUNCE_MS);
    debouncer._gitOverride = impl;

    const cortex = 'my-cortex';

    // Write 5 entries spread over <200ms (each 5ms apart).
    for (let i = 0; i < 5; i++) {
      debouncer.notify(cortex);
      if (i < 4) await new Promise(r => setTimeout(r, 5));
    }

    // Expected: add, diff --cached, commit, push → 4 calls
    await waitForCalls(calls, 4);

    const addCalls    = calls.filter(c => c.args[0] === 'add');
    const commitCalls = calls.filter(c => c.args[0] === 'commit');
    const pushCalls   = calls.filter(c => c.args[0] === 'push');

    expect(addCalls).toHaveLength(1);
    expect(commitCalls).toHaveLength(1);
    expect(pushCalls).toHaveLength(1);
  });

  it('commit message contains "auto: 5 entries via daemon" and an ISO timestamp', async () => {
    const { impl, calls } = buildGitMock();
    const debouncer = new PushDebouncer(TEST_DEBOUNCE_MS);
    debouncer._gitOverride = impl;

    const cortex = 'msg-cortex';
    for (let i = 0; i < 5; i++) debouncer.notify(cortex);

    // add, diff, commit, push = 4 calls
    await waitForCalls(calls, 4);

    const commitCall = calls.find(c => c.args[0] === 'commit');
    expect(commitCall).toBeDefined();
    const msgArg = commitCall!.args[commitCall!.args.indexOf('-m') + 1];
    expect(msgArg).toMatch(/^auto: 5 entries via daemon \d{4}-\d{2}-\d{2}T/);
  });

  it('two cortexes: each fires independently — no cross-cortex coalescing', async () => {
    const { impl, calls } = buildGitMock();
    const debouncer = new PushDebouncer(TEST_DEBOUNCE_MS);
    debouncer._gitOverride = impl;

    debouncer.notify('cortex-alpha');
    debouncer.notify('cortex-beta');

    // 2 cortexes × (add + diff + commit + push) = 8 calls
    await waitForCalls(calls, 8);

    const pushCalls = calls.filter(c => c.args[0] === 'push');
    expect(pushCalls).toHaveLength(2);

    const pushedBranches = pushCalls.map(c => c.args[c.args.length - 1]);
    expect(pushedBranches).toContain('cortex-alpha');
    expect(pushedBranches).toContain('cortex-beta');
  });

  it('skipPush=true: git add + commit fire but push does NOT fire', async () => {
    const { impl, calls } = buildGitMock();
    const debouncer = new PushDebouncer(TEST_DEBOUNCE_MS);
    debouncer._gitOverride = impl;

    debouncer.notify('offline-cortex', /* skipPush */ true);

    // add, diff, commit = 3 calls (no push)
    await waitForCalls(calls, 3);

    // Give a small extra window to ensure push doesn't arrive late.
    await new Promise(r => setTimeout(r, 50));

    const addCalls    = calls.filter(c => c.args[0] === 'add');
    const commitCalls = calls.filter(c => c.args[0] === 'commit');
    const pushCalls   = calls.filter(c => c.args[0] === 'push');

    expect(addCalls).toHaveLength(1);
    expect(commitCalls).toHaveLength(1);
    expect(pushCalls).toHaveLength(0);
  });

  it('nothing-to-commit: sequence stops after git add — no commit, no push', async () => {
    const { impl, calls } = buildGitMock({ nothingToCommit: true });
    const debouncer = new PushDebouncer(TEST_DEBOUNCE_MS);
    debouncer._gitOverride = impl;

    debouncer.notify('clean-cortex');

    // add, diff = 2 calls (no commit or push)
    await waitForCalls(calls, 2);

    // Give a small extra window to ensure commit/push don't arrive late.
    await new Promise(r => setTimeout(r, 50));

    const commitCalls = calls.filter(c => c.args[0] === 'commit');
    const pushCalls   = calls.filter(c => c.args[0] === 'push');

    expect(commitCalls).toHaveLength(0);
    expect(pushCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // pull-rebase-before-push (shared-branch concurrency: the proxy is not the
  // only writer to cortex/<name>, so origin can advance under it).
  // -------------------------------------------------------------------------

  /**
   * Mock git where `push` returns the next outcome from `pushOutcomes`:
   * `'ok'` resolves, anything else is thrown as the error message. Once the
   * array is exhausted, push resolves. `diff --cached --quiet` throws
   * (dirty) so the commit fires. Everything else (rev-parse, switch, add,
   * commit, pull, rebase) resolves with ''.
   */
  function buildGitMockWithPush(pushOutcomes: string[]) {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    let pushIdx = 0;
    const impl = async (args: string[], cwd: string): Promise<string> => {
      calls.push({ args, cwd });
      if (args.includes('--cached') && args.includes('--quiet')) {
        throw new Error('exit code 1'); // dirty → commit fires
      }
      if (args[0] === 'push') {
        const outcome = pushOutcomes[pushIdx++] ?? 'ok';
        if (outcome !== 'ok') throw new Error(outcome);
      }
      return '';
    };
    return { impl, calls };
  }

  it('pulls --rebase before pushing', async () => {
    const { impl, calls } = buildGitMockWithPush(['ok']);
    const debouncer = new PushDebouncer(TEST_DEBOUNCE_MS);
    debouncer._gitOverride = impl;

    debouncer.notify('rebase-cortex');
    await waitForCalls(calls, 1);
    await new Promise(r => setTimeout(r, 50));

    const pullIdx = calls.findIndex(
      c => c.args[0] === 'pull' && c.args.includes('--rebase'),
    );
    const pushIdx = calls.findIndex(c => c.args[0] === 'push');
    expect(pullIdx).toBeGreaterThanOrEqual(0);
    expect(pushIdx).toBeGreaterThanOrEqual(0);
    // pull --rebase must precede push.
    expect(pullIdx).toBeLessThan(pushIdx);
    // pull targets the cortex branch explicitly.
    expect(calls[pullIdx].args).toContain('rebase-cortex');
  });

  it('non-fast-forward rejection: re-pulls and retries, then succeeds', async () => {
    // First push bounces (origin advanced); second succeeds.
    const { impl, calls } = buildGitMockWithPush([
      '! [rejected] cortex/x -> cortex/x (fetch first)',
      'ok',
    ]);
    const debouncer = new PushDebouncer(TEST_DEBOUNCE_MS);
    debouncer._gitOverride = impl;

    debouncer.notify('ff-cortex');
    await waitForCalls(calls, 2);
    await new Promise(r => setTimeout(r, 80));

    const pullCalls = calls.filter(c => c.args[0] === 'pull');
    const pushCalls = calls.filter(c => c.args[0] === 'push');
    // Two push attempts, each preceded by a pull --rebase.
    expect(pushCalls.length).toBe(2);
    expect(pullCalls.length).toBe(2);
  });

  it('non-rejection push error (auth/network) surfaces immediately without retry-spin', async () => {
    const { impl, calls } = buildGitMockWithPush([
      'Permission denied (publickey). fatal: Could not read from remote repository.',
      'ok', // would be used if it (wrongly) retried
    ]);
    const debouncer = new PushDebouncer(TEST_DEBOUNCE_MS);
    debouncer._gitOverride = impl;

    debouncer.notify('auth-cortex');
    await waitForCalls(calls, 1);
    await new Promise(r => setTimeout(r, 80));

    const pushCalls = calls.filter(c => c.args[0] === 'push');
    // Exactly one push attempt — the auth error is surfaced, not spun on.
    expect(pushCalls.length).toBe(1);
  });

  it('exhausts retries on persistent non-fast-forward and stops at the cap', async () => {
    const { impl, calls } = buildGitMockWithPush([
      'rejected (fetch first)',
      'rejected (fetch first)',
      'rejected (fetch first)',
      'ok', // beyond the cap — must NOT be reached
    ]);
    const debouncer = new PushDebouncer(TEST_DEBOUNCE_MS);
    debouncer._gitOverride = impl;

    debouncer.notify('stuck-cortex');
    await waitForCalls(calls, 1);
    await new Promise(r => setTimeout(r, 120));

    const pushCalls = calls.filter(c => c.args[0] === 'push');
    expect(pushCalls.length).toBe(3); // capped at MAX_PUSH_ATTEMPTS, not 4
  });

  // -------------------------------------------------------------------------
  // .gitattributes union-merge self-heal (only fires when a real .git exists)
  // -------------------------------------------------------------------------

  it('stamps .gitattributes (union merge) before the pull when the branch lacks it', async () => {
    // Opt the self-heal step in: create a .git so the guard passes.
    fs.mkdirSync(path.join(tmpHome, 'repo', '.git'), { recursive: true });
    const { impl, calls } = buildGitMockWithPush(['ok']);
    const debouncer = new PushDebouncer(TEST_DEBOUNCE_MS);
    debouncer._gitOverride = impl;

    debouncer.notify('attr-cortex');
    await waitForCalls(calls, 1);
    await new Promise(r => setTimeout(r, 60));

    // The file was actually written with the union line.
    const attr = fs.readFileSync(path.join(tmpHome, 'repo', '.gitattributes'), 'utf-8');
    expect(attr).toContain('*.jsonl merge=union');

    // It was staged + committed, and that happened BEFORE the pull --rebase.
    const attrAddIdx = calls.findIndex(
      c => c.args[0] === 'add' && c.args.includes('.gitattributes'),
    );
    const pullIdx = calls.findIndex(c => c.args[0] === 'pull' && c.args.includes('--rebase'));
    expect(attrAddIdx).toBeGreaterThanOrEqual(0);
    expect(pullIdx).toBeGreaterThanOrEqual(0);
    expect(attrAddIdx).toBeLessThan(pullIdx); // driver committed before rebase
  });

  it('does not re-stamp .gitattributes when the union line is already present', async () => {
    fs.mkdirSync(path.join(tmpHome, 'repo', '.git'), { recursive: true });
    // Pre-seed an existing .gitattributes with the line.
    fs.writeFileSync(
      path.join(tmpHome, 'repo', '.gitattributes'),
      '*.jsonl merge=union\n',
      'utf-8',
    );
    const { impl, calls } = buildGitMockWithPush(['ok']);
    const debouncer = new PushDebouncer(TEST_DEBOUNCE_MS);
    debouncer._gitOverride = impl;

    debouncer.notify('attr-present-cortex');
    await waitForCalls(calls, 1);
    await new Promise(r => setTimeout(r, 60));

    // No `.gitattributes` add — the self-heal is idempotent.
    const attrAdds = calls.filter(
      c => c.args[0] === 'add' && c.args.includes('.gitattributes'),
    );
    expect(attrAdds.length).toBe(0);
  });
});
