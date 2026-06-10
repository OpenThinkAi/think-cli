/**
 * Plumbing write path tests — AGT-478
 *
 * Coverage:
 * 1. behind-≥-100 simulation: mock git signals a large `behind` count;
 *    debouncer takes the force-reset path on attempt 1 and entries land.
 * 2. non-FF rejection on attempt 1 → retries with forceResetToRemote=true on
 *    attempt 2 (calls update-ref unconditionally), then push succeeds.
 * 3. permanent NFF exhaustion surfaces in getPushDebouncerMetrics():
 *    pushFailuresNonFastForward increments, lastPushErrorAt is set.
 * 4. ensureLocalUnionMergeAttribute() installs the union driver in
 *    .git/info/attributes before any appendLinesViaPlumbing call.
 * 5. tick-report push_debouncer field: createScheduler() returns push_debouncer
 *    in the TickReport with the expected shape.
 *
 * Git commands are mocked via _gitOverride so no real subprocess is spawned.
 * appendLinesViaPlumbing itself is mocked (returned via vi.mock) so we can
 * drive the push-debouncer's retry loop without the full plumbing machinery.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PushDebouncer, _pushMetrics, getPushDebouncerMetrics } from '../../src/daemon/push-debouncer.js';

// ---------------------------------------------------------------------------
// Mock appendLinesViaPlumbing so we can control its return value and avoid the
// full git-plumbing machinery. The real function is exercised by separate
// integration tests; here we only want to drive the debouncer's retry loop.
// ---------------------------------------------------------------------------

// Use vi.hoisted so the variables are available when vi.mock factories run
// (vi.mock calls are hoisted to the top of the file by vitest's transform).
const { mockAppend, mockEnsureUnion } = vi.hoisted(() => ({
  mockAppend: vi.fn<
    Parameters<typeof import('../../src/lib/git-plumbing.js').appendLinesViaPlumbing>,
    ReturnType<typeof import('../../src/lib/git-plumbing.js').appendLinesViaPlumbing>
  >(),
  mockEnsureUnion: vi.fn(),
}));

vi.mock('../../src/lib/git-plumbing.js', () => ({
  appendLinesViaPlumbing: (...args: unknown[]) => mockAppend(...(args as Parameters<typeof mockAppend>)),
}));

// Mock ensureLocalUnionMergeAttribute so we can spy without touching the FS.
vi.mock('../../src/lib/git.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/git.js')>();
  return {
    ...real,
    ensureLocalUnionMergeAttribute: mockEnsureUnion,
  };
});

// ---------------------------------------------------------------------------
// Isolation helpers
// ---------------------------------------------------------------------------

const TEST_DEBOUNCE_MS = 10;

let prevThinkHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
  vi.clearAllMocks();

  // Reset process-lifetime metrics between tests (they share module state).
  _pushMetrics.pushSuccesses = 0;
  _pushMetrics.pushFailuresNonFastForward = 0;
  _pushMetrics.lastPushErrorAt = null;

  prevThinkHome = process.env.THINK_HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'think-plumb-write-'));
  process.env.THINK_HOME = tmpHome;

  // Create repo dir WITH a .git so the ensureLocalUnionMergeAttribute guard
  // passes (the step is guarded on `.git` existing).
  fs.mkdirSync(path.join(tmpHome, 'repo', '.git'), { recursive: true });

  const cfgDir = path.join(tmpHome, 'config');
  fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(cfgDir, 'config.json'),
    JSON.stringify({
      peerId: 'plumb-write-test',
      cortex: {
        author: 'test',
        plumbingWrites: true,   // use the plumbing path (default)
        largeBehindThreshold: 10,
      },
    }),
    { mode: 0o600 },
  );
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
 * Seed the l1_outbox for a cortex with one row so the debouncer has
 * something to drain. Uses the real getCortexDb so the SQLite table is
 * actually populated.
 */
async function seedOutbox(cortex: string): Promise<void> {
  const { getCortexDb } = await import('../../src/db/engrams.js');
  const db = getCortexDb(cortex);
  // Ensure the outbox table exists (migrations may not have run in tmpHome).
  // Schema matches the production definition in src/db/engrams.ts.
  db.exec(`CREATE TABLE IF NOT EXISTS l1_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id TEXT NOT NULL,
    line TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT`);
  db.prepare('INSERT INTO l1_outbox (entry_id, line, created_at) VALUES (?, ?, ?)').run(
    'test-entry-1',
    JSON.stringify({ kind: 'event', id: 'test-1', ts: new Date().toISOString() }),
    new Date().toISOString(),
  );
}

/**
 * Build a git mock that handles the pre-flight fetch and rev-list calls the
 * debouncer uses for large-behind detection, plus a configurable push outcome.
 *
 * `behind` — how many commits behind origin the clone should appear.
 * `pushOutcomes` — array of push results ('ok' resolves; anything else throws).
 */
function buildPlumbingMock(opts: {
  behind?: number;
  pushOutcomes?: string[];
}) {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  let pushIdx = 0;
  const impl = async (args: string[], cwd: string): Promise<string> => {
    calls.push({ args, cwd });

    if (args[0] === 'fetch') {
      return '';
    }
    if (args[0] === 'rev-list' && args.includes('--count')) {
      // Return the simulated `behind` count.
      return String(opts.behind ?? 0);
    }
    if (args[0] === 'push') {
      const outcome = (opts.pushOutcomes ?? ['ok'])[pushIdx++] ?? 'ok';
      if (outcome !== 'ok') throw new Error(outcome);
      return '';
    }
    if (args[0] === 'update-ref') {
      return '';
    }
    return '';
  };
  return { impl, calls };
}

async function waitForMs(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PushDebouncer — plumbing path (AGT-478)', () => {
  it('behind≥threshold: takes force-reset path on attempt 1 and succeeds', async () => {
    // mock appendLinesViaPlumbing to succeed immediately.
    mockAppend.mockResolvedValue({ commit: 'abc'.repeat(14).slice(0, 40), stagedPath: 'cortex/000001.jsonl', parent: null });

    const { impl, calls } = buildPlumbingMock({ behind: 50, pushOutcomes: ['ok'] });
    await seedOutbox('cortex-large-behind');

    const debouncer = new PushDebouncer(TEST_DEBOUNCE_MS);
    debouncer._gitOverride = impl;

    await debouncer.flush('cortex-large-behind');

    // The pre-flight fetch + rev-list should have fired.
    const fetchCalls = calls.filter((c) => c.args[0] === 'fetch');
    const revListCalls = calls.filter(
      (c) => c.args[0] === 'rev-list' && c.args.includes('--count'),
    );
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    expect(revListCalls.length).toBeGreaterThanOrEqual(1);

    // appendLinesViaPlumbing should have been called with forceResetToRemote=true.
    expect(mockAppend).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(String),
      'cortex-large-behind',
      expect.any(Array),
      expect.any(String),
      expect.objectContaining({ forceResetToRemote: true }),
    );

    // Push should have succeeded.
    expect(_pushMetrics.pushSuccesses).toBe(1);
    expect(_pushMetrics.pushFailuresNonFastForward).toBe(0);
  });

  it('non-FF rejection on attempt 1: retries with forceResetToRemote=true on attempt 2 and succeeds', async () => {
    mockAppend.mockResolvedValue({ commit: 'def'.repeat(14).slice(0, 40), stagedPath: 'cortex/000001.jsonl', parent: 'aaa'.repeat(14).slice(0, 40) });

    const { impl } = buildPlumbingMock({
      behind: 0, // no large-behind short-circuit
      pushOutcomes: [
        '! [rejected] cortex/x -> cortex/x (non-fast-forward)',
        'ok',
      ],
    });
    await seedOutbox('cortex-nff-retry');

    const debouncer = new PushDebouncer(TEST_DEBOUNCE_MS);
    debouncer._gitOverride = impl;

    await debouncer.flush('cortex-nff-retry');

    // Attempt 1: forceResetToRemote=false (startWithReset=false, attempt 1).
    // Attempt 2: forceResetToRemote=true.
    expect(mockAppend).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = mockAppend.mock.calls;
    expect(firstCall[5]).toEqual(expect.objectContaining({ forceResetToRemote: false }));
    expect(secondCall[5]).toEqual(expect.objectContaining({ forceResetToRemote: true }));

    expect(_pushMetrics.pushSuccesses).toBe(1);
    expect(_pushMetrics.pushFailuresNonFastForward).toBe(0);
  });

  it('permanent NFF exhaustion surfaces in metrics (AC #5)', async () => {
    mockAppend.mockResolvedValue({ commit: 'ffe'.repeat(14).slice(0, 40), stagedPath: 'cortex/000001.jsonl', parent: null });

    const { impl } = buildPlumbingMock({
      behind: 0,
      pushOutcomes: [
        '! [rejected] (non-fast-forward)',
        '! [rejected] (non-fast-forward)',
        '! [rejected] (non-fast-forward)',
        'ok', // beyond cap — must not be reached
      ],
    });
    await seedOutbox('cortex-perm-nff');

    const debouncer = new PushDebouncer(TEST_DEBOUNCE_MS);
    debouncer._gitOverride = impl;

    await debouncer.flush('cortex-perm-nff');

    // All 3 attempts exhausted.
    expect(mockAppend).toHaveBeenCalledTimes(3);

    // Metrics must reflect the permanent failure.
    const m = getPushDebouncerMetrics();
    expect(m.pushFailuresNonFastForward).toBe(1);
    expect(m.lastPushErrorAt).not.toBeNull();
    expect(m.pushSuccesses).toBe(0);
  });

  it('ensureLocalUnionMergeAttribute is called before appendLinesViaPlumbing when .git exists (AC #4)', async () => {
    mockAppend.mockResolvedValue({ commit: 'a1b'.repeat(14).slice(0, 40), stagedPath: 'cortex/000001.jsonl', parent: null });

    const { impl } = buildPlumbingMock({ behind: 0, pushOutcomes: ['ok'] });
    await seedOutbox('cortex-union-attr');

    const debouncer = new PushDebouncer(TEST_DEBOUNCE_MS);
    debouncer._gitOverride = impl;

    await debouncer.flush('cortex-union-attr');

    // ensureLocalUnionMergeAttribute must have been called.
    expect(mockEnsureUnion).toHaveBeenCalledTimes(1);

    // And it was called before appendLinesViaPlumbing.
    const ensureOrder = mockEnsureUnion.mock.invocationCallOrder[0];
    const appendOrder = mockAppend.mock.invocationCallOrder[0];
    expect(ensureOrder).toBeLessThan(appendOrder);
  });

  it('behind<threshold: normal (non-force-reset) path on attempt 1', async () => {
    mockAppend.mockResolvedValue({ commit: 'c2d'.repeat(14).slice(0, 40), stagedPath: 'cortex/000001.jsonl', parent: null });

    const { impl } = buildPlumbingMock({ behind: 3, pushOutcomes: ['ok'] });
    await seedOutbox('cortex-small-behind');

    const debouncer = new PushDebouncer(TEST_DEBOUNCE_MS);
    debouncer._gitOverride = impl;

    await debouncer.flush('cortex-small-behind');

    // Attempt 1 should NOT use forceResetToRemote (behind < threshold of 10).
    expect(mockAppend).toHaveBeenCalledTimes(1);
    expect(mockAppend.mock.calls[0][5]).toEqual(
      expect.objectContaining({ forceResetToRemote: false }),
    );
    expect(_pushMetrics.pushSuccesses).toBe(1);
  });

  it('auth/network errors surface immediately without NFF retry spin', async () => {
    mockAppend.mockResolvedValue({ commit: 'e3f'.repeat(14).slice(0, 40), stagedPath: 'cortex/000001.jsonl', parent: null });

    const { impl } = buildPlumbingMock({
      behind: 0,
      pushOutcomes: [
        'Permission denied (publickey). fatal: Could not read from remote repository.',
        'ok', // would be used if it wrongly retried
      ],
    });
    await seedOutbox('cortex-auth-err');

    const debouncer = new PushDebouncer(TEST_DEBOUNCE_MS);
    debouncer._gitOverride = impl;

    await debouncer.flush('cortex-auth-err');

    // Only one push attempt — auth error surfaces immediately.
    expect(mockAppend).toHaveBeenCalledTimes(1);
    // Auth errors are NOT counted as NFF failures.
    expect(_pushMetrics.pushFailuresNonFastForward).toBe(0);
  });

  it('getPushDebouncerMetrics() returns a snapshot (not a mutable reference)', async () => {
    _pushMetrics.pushSuccesses = 5;
    const m1 = getPushDebouncerMetrics();
    _pushMetrics.pushSuccesses = 99;
    const m2 = getPushDebouncerMetrics();
    expect(m1.pushSuccesses).toBe(5);
    expect(m2.pushSuccesses).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// Scheduler TickReport push_debouncer field (AC #5 — tick-report surface)
// ---------------------------------------------------------------------------

describe('TickReport push_debouncer field (AC #5)', () => {
  it('tick report includes push_debouncer with correct shape after a successful push', async () => {
    // Arrange: seed a known metrics state.
    _pushMetrics.pushSuccesses = 3;
    _pushMetrics.pushFailuresNonFastForward = 1;
    _pushMetrics.lastPushErrorAt = '2026-06-09T00:00:00.000Z';

    // Build a minimal scheduler with no subscriptions and no drain so tickOnce
    // returns quickly.
    const { createScheduler } = await import('../../src/serve/scheduler/index.js');
    const { openDb } = await import('../../src/serve/db.js');
    const { createVault } = await import('../../src/serve/vault/index.js');
    const { buildDefaultRegistry } = await import('../../src/serve/connectors/registry.js');

    // Each test needs its own DB file — use tmpHome.
    const dbPath = path.join(tmpHome, 'serve.db');
    const db = openDb(dbPath);
    const vault = createVault(Buffer.from('test-key-32-bytes-padded-1234567'));
    const registry = buildDefaultRegistry();

    const scheduler = createScheduler({
      db,
      registry,
      vault,
      intervalMs: 60_000,
    });

    const report = await scheduler.tickOnce();

    expect(report.push_debouncer).toBeDefined();
    expect(report.push_debouncer.successes).toBe(3);
    expect(report.push_debouncer.failures_nff).toBe(1);
    expect(report.push_debouncer.last_failure_at).toBe('2026-06-09T00:00:00.000Z');

    scheduler.stop();
    db.close();
  });

  it('tick report push_debouncer.failures_nff is 0 and last_failure_at is null initially', async () => {
    // Metrics already reset in beforeEach.
    const { createScheduler } = await import('../../src/serve/scheduler/index.js');
    const { openDb } = await import('../../src/serve/db.js');
    const { createVault } = await import('../../src/serve/vault/index.js');
    const { buildDefaultRegistry } = await import('../../src/serve/connectors/registry.js');

    const dbPath = path.join(tmpHome, 'serve2.db');
    const db = openDb(dbPath);
    const vault = createVault(Buffer.from('test-key-32-bytes-padded-1234567'));
    const registry = buildDefaultRegistry();

    const scheduler = createScheduler({ db, registry, vault, intervalMs: 60_000 });
    const report = await scheduler.tickOnce();

    expect(report.push_debouncer.failures_nff).toBe(0);
    expect(report.push_debouncer.successes).toBe(0);
    expect(report.push_debouncer.last_failure_at).toBeNull();

    scheduler.stop();
    db.close();
  });
});
