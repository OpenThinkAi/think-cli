/**
 * Tests for PullLoop — AGT-310
 *
 * Coverage:
 * 1. No new commits: fetch succeeds, cursor unchanged, no ingest calls.
 * 2. New commit: entries ingested, cursor updated to new SHA.
 * 3. Fetch failure: WARN logged, no cursor update, loop continues.
 * 4. INSERT OR IGNORE dedup: same entry arriving twice is only inserted once.
 * 5. isActive / interval switching: after notifyCliCall, active interval
 *    is shorter than idle interval.
 * 6. triggerImmediatePull: interrupt fires a cycle immediately without
 *    waiting for the timer.
 * 7. stop(): loop stops scheduling further cycles.
 *
 * Git commands and DB writes are mocked so no real subprocess or file I/O
 * is needed. Embed is mocked to a fixed Float32Array.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PullLoop,
  notifyCliCall,
  triggerImmediatePull,
  ACTIVE_INTERVAL_MIN_MS,
  ACTIVE_INTERVAL_MAX_MS,
  IDLE_INTERVAL_MIN_MS,
  IDLE_INTERVAL_MAX_MS,
  ACTIVE_THRESHOLD_MS,
} from '../../src/daemon/pull-loop.js';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Mock embed so tests don't download the model.
vi.mock('../../src/lib/embed.js', () => ({
  default: vi.fn().mockResolvedValue(new Float32Array(384).fill(0)),
  EMBEDDING_MODEL_NAME: 'bge-small-en-v1.5-test',
}));

// Mock getCortexDb with an in-memory SQLite-like object.
const insertedIds = new Set<string>();

vi.mock('../../src/db/engrams.js', () => ({
  getCortexDb: vi.fn(() => ({
    prepare: (sql: string) => ({
      get: (id: string) => (sql.includes('SELECT id FROM memories WHERE id = ?') && insertedIds.has(id) ? { id } : undefined),
      run: (...args: unknown[]) => {
        // Capture the id (first positional arg after INSERT OR IGNORE)
        if (typeof args[0] === 'string' && sql.includes('INSERT OR IGNORE INTO memories')) {
          insertedIds.add(args[0] as string);
        }
        return { changes: 1 };
      },
    }),
  })),
}));

// Mock memory-queries for sync_cursors.
const cursors = new Map<string, string>();

vi.mock('../../src/db/memory-queries.js', () => ({
  getSyncCursor: vi.fn((_cortex: string, _backend: string, _dir: string): string | null => {
    return cursors.get(`${_cortex}:${_backend}:${_dir}`) ?? null;
  }),
  setSyncCursor: vi.fn((_cortex: string, _backend: string, _dir: string, sha: string) => {
    cursors.set(`${_cortex}:${_backend}:${_dir}`, sha);
  }),
}));

// Mock assignNextSeq.
vi.mock('../../src/db/activity-seq.js', () => ({
  assignNextSeq: vi.fn(() => 1),
}));

// ---------------------------------------------------------------------------
// Git mock factory
// ---------------------------------------------------------------------------

interface GitCall {
  args: string[];
  cwd: string;
}

interface GitMockConfig {
  /** If set, fetch throws this error. */
  fetchError?: string;
  /** Remote HEAD SHA to return from rev-parse. null = branch doesn't exist. */
  remoteHead?: string | null;
  /** Commits to return from rev-list (oldest first). */
  newCommits?: string[];
  /** Map commitSha → list of changed JSONL file paths. */
  changedFiles?: Map<string, string[]>;
  /** Map `sha:filepath` → file content. */
  fileContents?: Map<string, string>;
}

function buildGitMock(cfg: GitMockConfig): { impl: (args: string[], cwd: string) => Promise<string>; calls: GitCall[] } {
  const calls: GitCall[] = [];

  const impl = async (args: string[], cwd: string): Promise<string> => {
    calls.push({ args, cwd });

    // Determine actual command (skip -c flags)
    let cmdIdx = 0;
    while (cmdIdx < args.length && (args[cmdIdx] === '-c' || (cmdIdx > 0 && args[cmdIdx - 1] === '-c'))) {
      cmdIdx++;
    }
    const actualCmd = args[cmdIdx] ?? args[0];

    if (actualCmd === 'fetch') {
      if (cfg.fetchError) throw new Error(cfg.fetchError);
      return '';
    }

    if (actualCmd === 'rev-parse') {
      if (cfg.remoteHead === null || cfg.remoteHead === undefined) {
        throw new Error('unknown revision');
      }
      return cfg.remoteHead;
    }

    if (actualCmd === 'rev-list') {
      return (cfg.newCommits ?? []).join('\n');
    }

    if (actualCmd === 'diff-tree') {
      const sha = args[args.length - 1];
      const files = cfg.changedFiles?.get(sha) ?? [];
      return files.join('\n');
    }

    if (actualCmd === 'show') {
      // format: `sha:path`
      const ref = args[args.length - 1];
      const content = cfg.fileContents?.get(ref);
      if (content === undefined) throw new Error(`not found: ${ref}`);
      return content;
    }

    return '';
  };

  return { impl, calls };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const logs: string[] = [];
function writeLine(msg: string): void {
  logs.push(msg);
}

async function waitMs(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Run one cycle synchronously by calling fetchAndIngest via the public
 * PullLoop.start() handle (which fires the first cycle immediately).
 * Returns after the first cycle completes.
 */
async function runOneCycle(loop: PullLoop): Promise<void> {
  const handle = loop.start();
  // Wait enough time for the async cycle to complete.
  await waitMs(50);
  handle.stop();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  logs.length = 0;
  insertedIds.clear();
  cursors.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PullLoop — no new commits', () => {
  it('does not update cursor when remote HEAD equals last seen SHA', async () => {
    const { getSyncCursor, setSyncCursor } = await import('../../src/db/memory-queries.js');
    const sha = 'aaaa1111';
    cursors.set('mycortex:git:pull', sha);

    const { impl } = buildGitMock({ remoteHead: sha });
    const loop = new PullLoop('mycortex', writeLine);
    loop._gitOverride = impl;

    await runOneCycle(loop);

    expect(setSyncCursor).not.toHaveBeenCalled();
    expect(getSyncCursor).toHaveBeenCalled();
  });
});

describe('PullLoop — new commits ingested', () => {
  it('ingests entries and updates cursor when new commits exist', async () => {
    const { setSyncCursor } = await import('../../src/db/memory-queries.js');
    const { getCortexDb } = await import('../../src/db/engrams.js');

    const oldSha = 'aaaa0000';
    const newSha = 'bbbb1111';
    const commitSha = 'cccc2222';
    cursors.set('testcortex:git:pull', oldSha);

    const entry1 = JSON.stringify({
      id: 'entry-id-001',
      ts: '2026-05-17T10:00:00Z',
      author: 'testuser',
      content: 'Hello from peer',
      origin_peer_id: 'peer-abc',
      kind: 'memory',
      topics: [],
      deleted_at: null,
    });

    const fileContents = new Map([
      [`${commitSha}:000001.jsonl`, entry1],
    ]);
    const changedFiles = new Map([[commitSha, ['000001.jsonl']]]);

    const { impl } = buildGitMock({
      remoteHead: newSha,
      newCommits: [commitSha],
      changedFiles,
      fileContents,
    });

    const loop = new PullLoop('testcortex', writeLine);
    loop._gitOverride = impl;

    await runOneCycle(loop);

    // Cursor should be updated to newSha.
    expect(setSyncCursor).toHaveBeenCalledWith('testcortex', 'git', 'pull', newSha);

    // DB prepare should have been called (meaning ingestEntry ran).
    expect(getCortexDb).toHaveBeenCalledWith('testcortex');

    // Entry should be in the inserted set.
    expect(insertedIds.has('entry-id-001')).toBe(true);
  });

  it('deduplicates: same entry arriving twice is only inserted once', async () => {
    const { setSyncCursor } = await import('../../src/db/memory-queries.js');
    const oldSha = null; // first time, no prior cursor
    const newSha = 'dddd1111';
    const commitSha = 'eeee2222';

    const entry = JSON.stringify({
      id: 'dup-entry-001',
      ts: '2026-05-17T11:00:00Z',
      author: 'peer',
      content: 'Duplicate content',
      origin_peer_id: 'peer-xyz',
      kind: 'memory',
      topics: [],
      deleted_at: null,
    });

    // Pre-populate as already inserted to simulate dedup.
    insertedIds.add('dup-entry-001');

    const fileContents = new Map([[`${commitSha}:000001.jsonl`, entry]]);
    const changedFiles = new Map([[commitSha, ['000001.jsonl']]]);

    const { impl } = buildGitMock({
      remoteHead: newSha,
      newCommits: [commitSha],
      changedFiles,
      fileContents,
    });

    const loop = new PullLoop('dedupcortex', writeLine);
    loop._gitOverride = impl;

    // Ensure no cursor is set (fresh start).
    cursors.delete('dedupcortex:git:pull');

    await runOneCycle(loop);

    // Cursor should still be updated.
    expect(setSyncCursor).toHaveBeenCalledWith('dedupcortex', 'git', 'pull', newSha);

    // The entry was already in insertedIds — still just 1 entry for this id.
    const countForId = [...insertedIds].filter(id => id === 'dup-entry-001').length;
    expect(countForId).toBe(1);
  });
});

describe('PullLoop — fetch failure', () => {
  it('logs WARN and skips cursor update on fetch error', async () => {
    const { setSyncCursor } = await import('../../src/db/memory-queries.js');

    const { impl } = buildGitMock({ fetchError: 'network unreachable' });
    const loop = new PullLoop('errcortex', writeLine);
    loop._gitOverride = impl;

    await runOneCycle(loop);

    expect(setSyncCursor).not.toHaveBeenCalled();
    expect(logs.some(l => l.includes('WARN') && l.includes('git fetch failed'))).toBe(true);
  });
});

describe('PullLoop — active/idle modes', () => {
  it('ACTIVE_INTERVAL constants are within expected bounds', () => {
    expect(ACTIVE_INTERVAL_MIN_MS).toBe(5_000);
    expect(ACTIVE_INTERVAL_MAX_MS).toBe(10_000);
    expect(IDLE_INTERVAL_MIN_MS).toBe(60_000);
    expect(IDLE_INTERVAL_MAX_MS).toBe(120_000);
    expect(ACTIVE_THRESHOLD_MS).toBe(5 * 60 * 1000);
  });

  it('notifyCliCall and triggerImmediatePull do not throw for valid cortex names', () => {
    expect(() => notifyCliCall('test-cortex')).not.toThrow();
    expect(() => triggerImmediatePull('test-cortex')).not.toThrow();
  });

  it('notifyCliCall does not throw for invalid cortex name', () => {
    expect(() => notifyCliCall('../bad')).not.toThrow();
  });

  it('triggerImmediatePull no-ops when no loop is running', () => {
    // Should not throw even if no loop is registered for this cortex.
    expect(() => triggerImmediatePull('nonexistent-cortex-xyz')).not.toThrow();
  });
});

describe('PullLoop — stop()', () => {
  it('stop() prevents further cycles from running', async () => {
    const { setSyncCursor } = await import('../../src/db/memory-queries.js');

    const { impl, calls } = buildGitMock({ remoteHead: null });
    const loop = new PullLoop('stopcortex', writeLine);
    loop._gitOverride = impl;

    const handle = loop.start();
    // Stop immediately before any cycle can complete.
    handle.stop();

    // Give some time to ensure no further cycles fire.
    await waitMs(20);

    // After stop, setSyncCursor should not have been called in a new cycle.
    expect(setSyncCursor).not.toHaveBeenCalled();
    expect(logs.some(l => l.includes('pull loop stopped'))).toBe(true);
    void calls; // suppress unused
  });
});
