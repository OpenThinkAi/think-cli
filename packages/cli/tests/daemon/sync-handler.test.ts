/**
 * Tests for the daemon `sync` endpoint — AGT-286
 *
 * Verifies:
 *   1. A synced memory appears in L1 (JSONL page file) AND in L2 (memories table).
 *   2. L2 row has a non-null embedding.
 *   3. Validation: content non-empty, byte-limit, kind in allowed set, cortex exists,
 *      topics bounds.
 *   4. Warning emitted when kind or topics are not yet L2-queryable.
 *
 * Uses THINK_HOME isolation (same pattern as peer-pair fixtures) so tests
 * never touch ~/.think. The @huggingface/transformers dep is mocked so these
 * tests run without downloading the 150MB model.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// Mock @huggingface/transformers before the module under test loads it.
// Returns a deterministic 384-dim Float32Array so embed() is synchronous and
// hermetic.
// ---------------------------------------------------------------------------

const MOCK_EMBEDDING = Float32Array.from({ length: 384 }, (_, i) => i / 384);

vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn().mockResolvedValue(
    vi.fn().mockResolvedValue({ data: MOCK_EMBEDDING }),
  ),
}));

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let thinkHome: string;
const cortexName = 'test-sync-cortex';

beforeEach(async () => {
  thinkHome = mkdtempSync(join(tmpdir(), 'think-sync-test-'));
  process.env.THINK_HOME = thinkHome;

  // Set up a minimal config so getConfig() and getPeerId() work.
  const configDir = join(thinkHome, 'config');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const config = {
    peerId: 'test-peer-id-agt-286',
    syncPort: 9999,
    cortex: { author: 'test-author' },
  };
  fs.writeFileSync(join(configDir, 'config.json'), JSON.stringify(config) + '\n', { mode: 0o600 });

  // Dynamically import modules AFTER setting THINK_HOME so they pick up the
  // isolated home directory.
  const { getCortexDb, closeAllCortexDbs } = await import('../../src/db/engrams.js');

  // Close any stale DB handles from a previous test.
  closeAllCortexDbs();

  // Touch the L2 database so cortexExists() returns true.
  getCortexDb(cortexName);
  closeAllCortexDbs();
});

afterEach(async () => {
  // Always close DB handles — even if a test assertion threw — to avoid leaks.
  const { closeAllCortexDbs } = await import('../../src/db/engrams.js');
  closeAllCortexDbs();

  vi.resetModules();
  rmSync(thinkHome, { recursive: true, force: true });
  delete process.env.THINK_HOME;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read the L1-bound entries for a cortex.
 *
 * Post-outbox-refactor, handleSync no longer writes the L1 page file directly
 * — it inserts a row into `l1_outbox` and the push-debouncer's serialized
 * drain writes the file. The drain requires a working git repo (real or
 * mocked), which these unit tests deliberately don't set up. So we assert
 * against the outbox instead: it carries the exact JSONL line that the drain
 * would write to the page file, in the same order. The drain-to-file path is
 * exercised end-to-end in tests/daemon/outbox-drain.test.ts with a git mock.
 *
 * `home` is unused now (kept in the signature so existing call sites don't
 * need rewriting) — the cortex DB path is derived from THINK_HOME inside
 * `getCortexDb`.
 */
async function readL1Lines(_home: string, cortex: string): Promise<Record<string, unknown>[]> {
  const { getCortexDb } = await import('../../src/db/engrams.js');
  const db = getCortexDb(cortex);
  const rows = db.prepare('SELECT line FROM l1_outbox ORDER BY id ASC').all() as { line: string }[];
  return rows.map((r) => JSON.parse(r.line) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sync handler (AGT-286)', () => {
  it('stores a memory in L1 and L2 with embedding non-null', async () => {
    const { handleSync } = await import('../../src/daemon/sync-handler.js');
    const { getCortexDb } = await import('../../src/db/engrams.js');

    const result = await handleSync({
      cortex: cortexName,
      content: 'Test memory for AGT-286',
      kind: 'memory',
    });

    expect(result.status).toBe('stored');
    expect(typeof result.entry_id).toBe('string');
    expect(result.entry_id.length).toBeGreaterThan(0);
    // No warnings — kind and topics are now written to L2 directly
    expect(result.warnings).toBeUndefined();

    // Verify L1: entry appears in the JSONL page.
    const l1Lines = await readL1Lines(thinkHome, cortexName);
    expect(l1Lines.length).toBe(1);
    const l1Entry = l1Lines[0];
    expect(l1Entry['id']).toBe(result.entry_id);
    expect(l1Entry['content']).toBe('Test memory for AGT-286');
    expect(l1Entry['kind']).toBe('memory');
    expect(l1Entry['topics']).toEqual([]);
    expect(l1Entry['supersedes']).toEqual([]);
    expect(l1Entry['compacted_from']).toBeNull();

    // Verify L2: row exists with embedding, kind, and topics_json populated.
    const db = getCortexDb(cortexName);
    const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(result.entry_id) as {
      id: string;
      content: string;
      embedding: Uint8Array | null;
      activity_seq: number | null;
      kind: string | null;
      topics_json: string | null;
    } | undefined;

    expect(row).toBeDefined();
    expect(row!.content).toBe('Test memory for AGT-286');
    expect(row!.embedding).not.toBeNull();
    expect(row!.activity_seq).toBeGreaterThan(0);
    // Bug 1 fix: kind and topics_json must be written to L2
    expect(row!.kind).toBe('memory');
    expect(row!.topics_json).toBe('[]');
  });

  it('stores a retro with topics in L1 and L2', async () => {
    const { handleSync } = await import('../../src/daemon/sync-handler.js');
    const { getCortexDb } = await import('../../src/db/engrams.js');

    const result = await handleSync({
      cortex: cortexName,
      content: 'Always validate inputs at the boundary',
      kind: 'retro',
      topics: ['testing', 'validation'],
    });

    expect(result.status).toBe('stored');
    // No warnings — kind and topics are now written to L2 directly
    expect(result.warnings).toBeUndefined();

    const l1Lines = await readL1Lines(thinkHome, cortexName);
    expect(l1Lines.length).toBe(1);
    expect(l1Lines[0]['kind']).toBe('retro');
    expect(l1Lines[0]['topics']).toEqual(['testing', 'validation']);

    // Verify L2 has kind and topics_json populated
    const db = getCortexDb(cortexName);
    const row = db.prepare('SELECT kind, topics_json FROM memories WHERE id = ?').get(result.entry_id) as {
      kind: string | null;
      topics_json: string | null;
    } | undefined;
    expect(row).toBeDefined();
    expect(row!.kind).toBe('retro');
    expect(JSON.parse(row!.topics_json ?? '[]')).toEqual(['testing', 'validation']);
  });

  it('rejects empty content', async () => {
    const { handleSync } = await import('../../src/daemon/sync-handler.js');

    await expect(
      handleSync({ cortex: cortexName, content: '   ', kind: 'memory' }),
    ).rejects.toThrow(/content/);
  });

  it('rejects content that exceeds 64 KB', async () => {
    const { handleSync } = await import('../../src/daemon/sync-handler.js');
    const bigContent = 'x'.repeat(65 * 1024);

    await expect(
      handleSync({ cortex: cortexName, content: bigContent, kind: 'memory' }),
    ).rejects.toThrow(/64 KB/);
  });

  it('rejects an invalid kind with the required error message format', async () => {
    const { handleSync } = await import('../../src/daemon/sync-handler.js');

    await expect(
      handleSync({ cortex: cortexName, content: 'hello', kind: 'bogus' }),
    ).rejects.toThrow(/invalid kind 'bogus'; expected memory\|retro\|event/);
  });

  it('rejects empty cortex name', async () => {
    const { handleSync } = await import('../../src/daemon/sync-handler.js');

    await expect(
      handleSync({ cortex: '', content: 'hello', kind: 'memory' }),
    ).rejects.toThrow(/cortex/);
  });

  it('rejects a missing cortex', async () => {
    const { handleSync } = await import('../../src/daemon/sync-handler.js');

    await expect(
      handleSync({ cortex: 'nonexistent-cortex', content: 'hello', kind: 'memory' }),
    ).rejects.toThrow(/cortex 'nonexistent-cortex' not found/);
  });

  it('rejects topics array exceeding MAX_TOPICS', async () => {
    const { handleSync } = await import('../../src/daemon/sync-handler.js');
    const tooManyTopics = Array.from({ length: 21 }, (_, i) => `topic-${i}`);

    await expect(
      handleSync({ cortex: cortexName, content: 'hello', kind: 'memory', topics: tooManyTopics }),
    ).rejects.toThrow(/topics/);
  });

  it('rejects topics with an element exceeding MAX_TOPIC_LENGTH', async () => {
    const { handleSync } = await import('../../src/daemon/sync-handler.js');
    const longTopic = 'x'.repeat(129);

    await expect(
      handleSync({ cortex: cortexName, content: 'hello', kind: 'memory', topics: [longTopic] }),
    ).rejects.toThrow(/topics/);
  });

  it('rotates to a new L1 page after L1_PAGE_SIZE lines', async () => {
    // Page rotation is driven by `getActivePage` inside the push-debouncer
    // drain, not handleSync (which only enqueues to l1_outbox). The test
    // therefore drives the full path: enqueue → flush(cortex) → file write.
    const { handleSync } = await import('../../src/daemon/sync-handler.js');
    const { pushDebouncer } = await import('../../src/daemon/push-debouncer.js');

    // Stub git so the drain's branch-switch and commit/push subprocesses
    // never fire. `diff --cached --quiet` must "fail" so the commit step
    // proceeds; everything else resolves with ''.
    pushDebouncer._gitOverride = async (args: string[]): Promise<string> => {
      if (args.includes('--cached') && args.includes('--quiet')) {
        throw new Error('exit code 1');
      }
      return '';
    };

    const cortexDir = join(thinkHome, 'repo', cortexName);
    fs.mkdirSync(cortexDir, { recursive: true, mode: 0o700 });

    // Fill 000001.jsonl with 1000 lines (the rotation threshold).
    const dummyLines = Array.from({ length: 1000 }, (_, i) =>
      JSON.stringify({ id: `dummy-${i}`, ts: new Date().toISOString(), content: `line ${i}` })
    ).join('\n') + '\n';
    fs.writeFileSync(join(cortexDir, '000001.jsonl'), dummyLines, 'utf-8');

    const result = await handleSync({
      cortex: cortexName,
      content: 'This should land in page 2',
      kind: 'event',
    });

    expect(result.status).toBe('stored');

    // Drain the outbox synchronously to materialize the L1 file write.
    await pushDebouncer.flush(cortexName);

    const files = fs.readdirSync(cortexDir).filter(f => /^\d{6}\.jsonl$/.test(f)).sort();
    expect(files).toContain('000002.jsonl');

    const page2 = fs.readFileSync(join(cortexDir, '000002.jsonl'), 'utf-8');
    const parsed = JSON.parse(page2.trim()) as { id: string };
    expect(parsed.id).toBe(result.entry_id);
  });
});
