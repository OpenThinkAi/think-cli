/**
 * L1 outbox drain — race-fix tests for #65 root cause.
 *
 * Background: `think retro --cortex A` then `think retro --cortex B` in
 * quick succession used to fail in the daemon's push-debouncer with
 *   "git switch -- B: Your local changes to the following files would be
 *    overwritten by checkout: A/000001.jsonl"
 * because handleSync wrote the L1 file synchronously (dirtying the tree)
 * while the push-debouncer fired async setImmediate per cortex with no
 * cross-cortex coordination. AGT-437 fixed the surface "branch already
 * exists" symptom but left the underlying race.
 *
 * The fix moves all L1 file writes into the push-debouncer behind a global
 * async mutex (see `push-debouncer.ts:_executeLock`). handleSync inserts
 * the JSONL line into `l1_outbox` instead; the debouncer drains under the
 * lock. Two cortices can no longer interleave on the shared working tree.
 *
 * These tests use the `_gitOverride` seam so no real subprocess fires —
 * we assert on the recorded call sequence + actual file writes to a tmp
 * THINK_HOME.
 *
 * Kind note: the writes below use `kind: 'event'` (the original `think retro`
 * scenario motivated the fix, but the outbox/L1 drain mechanics are
 * kind-agnostic). Events deliberately bypass the AGT-455 retro write gate and
 * near-duplicate fold — both of which would otherwise reject the short fixture
 * content or collapse the multi-write FIFO test, neither of which is what this
 * file exercises.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock the embedding pipeline so tests don't download the 150MB model.
const MOCK_EMBEDDING = Float32Array.from({ length: 384 }, (_, i) => i / 384);
vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn().mockResolvedValue(
    vi.fn().mockResolvedValue({ data: MOCK_EMBEDDING }),
  ),
}));

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let thinkHome: string;

beforeEach(async () => {
  thinkHome = mkdtempSync(join(tmpdir(), 'think-outbox-drain-'));
  process.env.THINK_HOME = thinkHome;
  // The push-debouncer reads the working tree under <thinkHome>/repo. We
  // create it (but with no .git) — the mocked git override absorbs every
  // subprocess call, but the `.gitattributes` self-heal step still does
  // an `fs.existsSync('.git')` check that must return false to skip.
  mkdirSync(join(thinkHome, 'repo'), { recursive: true });

  const configDir = join(thinkHome, 'config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const config = { peerId: 'outbox-test-peer', cortex: { author: 'test-author' } };
  await import('node:fs').then((fs) =>
    fs.writeFileSync(join(configDir, 'config.json'), JSON.stringify(config), { mode: 0o600 }),
  );

  // Reset module state so each test gets a fresh push-debouncer singleton
  // with no leftover timers / _executeLock chain.
  vi.resetModules();

  // Touch the cortex DBs we'll use so cortexExists() returns true.
  const { getCortexDb, closeAllCortexDbs } = await import('../../src/db/engrams.js');
  closeAllCortexDbs();
  getCortexDb('alpha');
  getCortexDb('beta');
  closeAllCortexDbs();
});

afterEach(async () => {
  const { closeAllCortexDbs } = await import('../../src/db/engrams.js');
  closeAllCortexDbs();
  rmSync(thinkHome, { recursive: true, force: true });
  delete process.env.THINK_HOME;
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Git mock — records calls; never throws; treats `diff --cached --quiet`
// as "dirty" so the commit fires.
// ---------------------------------------------------------------------------

interface GitCall { args: string[]; cwd: string }

function makeGitMock() {
  const calls: GitCall[] = [];
  const impl = async (args: string[], cwd: string): Promise<string> => {
    calls.push({ args, cwd });
    if (args.includes('--cached') && args.includes('--quiet')) {
      throw new Error('exit code 1'); // dirty → commit fires
    }
    // rev-parse --abbrev-ref HEAD returns a branch name — empty string is
    // good enough; the debouncer treats it as "not on the target branch"
    // and runs the switch (also mocked → no-op).
    return '';
  };
  return { impl, calls };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function readPageLines(cortex: string): string[] {
  const cortexDir = join(thinkHome, 'repo', cortex);
  if (!existsSync(cortexDir)) return [];
  const lines: string[] = [];
  for (const file of readdirSync(cortexDir).filter((f) => /^\d{6}\.jsonl$/.test(f)).sort()) {
    const raw = readFileSync(join(cortexDir, file), 'utf-8');
    for (const ln of raw.split('\n')) if (ln.length > 0) lines.push(ln);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('L1 outbox + push-debouncer drain', () => {
  it('handleSync writes to l1_outbox, NOT to the L1 page file directly', async () => {
    const { handleSync } = await import('../../src/daemon/sync-handler.js');
    const { getCortexDb } = await import('../../src/db/engrams.js');

    await handleSync({ cortex: 'alpha', content: 'first entry', kind: 'event' });

    // L1 page file must NOT exist yet — the drain runs async after 500ms.
    expect(existsSync(join(thinkHome, 'repo', 'alpha'))).toBe(false);

    // The outbox row carries the wire-format JSONL line.
    const db = getCortexDb('alpha');
    const rows = db.prepare('SELECT entry_id, line FROM l1_outbox ORDER BY id ASC').all() as
      { entry_id: string; line: string }[];
    expect(rows).toHaveLength(1);
    const parsed = JSON.parse(rows[0].line) as Record<string, unknown>;
    expect(parsed['content']).toBe('first entry');
    expect(parsed['kind']).toBe('event');
  });

  it('flush() drains the outbox to the L1 page file', async () => {
    const { handleSync } = await import('../../src/daemon/sync-handler.js');
    const { pushDebouncer } = await import('../../src/daemon/push-debouncer.js');
    const { getCortexDb } = await import('../../src/db/engrams.js');

    const { impl } = makeGitMock();
    pushDebouncer._gitOverride = impl;

    await handleSync({ cortex: 'alpha', content: 'pre-flush', kind: 'event' });
    await pushDebouncer.flush('alpha');

    const lines = readPageLines('alpha');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(parsed['content']).toBe('pre-flush');

    // Outbox cleared after successful commit.
    const db = getCortexDb('alpha');
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM l1_outbox').get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it('two cortices flushed back-to-back never race on git switch (the #65 root cause)', async () => {
    const { handleSync } = await import('../../src/daemon/sync-handler.js');
    const { pushDebouncer } = await import('../../src/daemon/push-debouncer.js');

    const { impl, calls } = makeGitMock();
    pushDebouncer._gitOverride = impl;

    await handleSync({ cortex: 'alpha', content: 'alpha-1', kind: 'event' });
    await handleSync({ cortex: 'beta', content: 'beta-1', kind: 'event' });

    // Fire both flushes concurrently — the global mutex must serialize them.
    await Promise.all([
      pushDebouncer.flush('alpha'),
      pushDebouncer.flush('beta'),
    ]);

    expect(readPageLines('alpha')).toHaveLength(1);
    expect(readPageLines('beta')).toHaveLength(1);

    // The serialization invariant: the two cortex commit cycles do not
    // interleave. Find the index of each cortex's `git push`; every git
    // call for cortexX between its switch and its push must be for cortexX.
    const pushIndices = calls
      .map((c, i) => (c.args[0] === 'push' ? { branch: c.args[c.args.length - 1], i } : null))
      .filter((x): x is { branch: string; i: number } => x !== null);
    expect(pushIndices).toHaveLength(2);

    // Each cycle's run is a contiguous slice. Walk forward from the first
    // push backwards to its switch and assert the cortex name is consistent.
    for (const { branch, i } of pushIndices) {
      // Find this cycle's switch (closest preceding `switch` call).
      let j = i;
      while (j >= 0 && calls[j].args[0] !== 'switch') j--;
      // Every call between the switch and the push must reference this
      // cortex (either as a positional arg or as an `add -- <cortex>` etc.).
      for (let k = j; k <= i; k++) {
        const argsStr = calls[k].args.join(' ');
        // Allow `git rev-parse refs/heads/<branch>` or `git diff --cached --quiet -- <branch>`
        // etc. The key guarantee: no OTHER cortex's name appears.
        const otherBranch = branch === 'alpha' ? 'beta' : 'alpha';
        expect(
          argsStr.includes(otherBranch),
          `cycle for '${branch}' contaminated with '${otherBranch}': ${argsStr}`,
        ).toBe(false);
      }
    }
  });

  it('drain order: multiple outbox rows for one cortex append in FIFO order', async () => {
    const { handleSync } = await import('../../src/daemon/sync-handler.js');
    const { pushDebouncer } = await import('../../src/daemon/push-debouncer.js');

    const { impl } = makeGitMock();
    pushDebouncer._gitOverride = impl;

    for (let i = 1; i <= 5; i++) {
      await handleSync({ cortex: 'alpha', content: `entry-${i}`, kind: 'event' });
    }
    await pushDebouncer.flush('alpha');

    const lines = readPageLines('alpha');
    expect(lines).toHaveLength(5);
    const contents = lines.map((ln) => (JSON.parse(ln) as { content: string }).content);
    expect(contents).toEqual(['entry-1', 'entry-2', 'entry-3', 'entry-4', 'entry-5']);
  });

  it('restart replay: outbox rows present at boot are still drainable (durability)', async () => {
    // Simulate a daemon crash by writing directly to outbox and then bringing
    // up a fresh push-debouncer instance, mirroring the boot replay path.
    const { handleSync } = await import('../../src/daemon/sync-handler.js');
    const { pushDebouncer } = await import('../../src/daemon/push-debouncer.js');
    const { getCortexDb } = await import('../../src/db/engrams.js');

    const { impl } = makeGitMock();
    pushDebouncer._gitOverride = impl;

    // Enqueue without draining (simulates "daemon crashed before debounce
    // window expired").
    await handleSync({ cortex: 'alpha', content: 'survived-crash', kind: 'event' });
    const db = getCortexDb('alpha');
    expect((db.prepare('SELECT COUNT(*) AS n FROM l1_outbox').get() as { n: number }).n).toBe(1);
    expect(existsSync(join(thinkHome, 'repo', 'alpha'))).toBe(false);

    // Boot replay: fire notify() exactly as daemon/index.ts does after
    // detecting non-empty outbox.
    pushDebouncer.notify('alpha');
    await waitFor(() => readPageLines('alpha').length === 1);

    const lines = readPageLines('alpha');
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]) as { content: string }).content).toBe('survived-crash');
  });
});
