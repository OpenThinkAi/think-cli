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

import { describe, it, expect } from 'vitest';
import { PushDebouncer } from '../../src/daemon/push-debouncer.js';

// ---------------------------------------------------------------------------
// Test debounce delay — short enough that tests complete quickly
// ---------------------------------------------------------------------------

const TEST_DEBOUNCE_MS = 10;

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
});
