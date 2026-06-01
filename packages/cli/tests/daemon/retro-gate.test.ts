/**
 * Tests for the write-time retro quality gate — AGT-455
 * (iterative-learning-v2 §5 M1).
 *
 * Covers the four acceptance criteria:
 *   1. accept            — a well-formed retro stores normally.
 *   2. reject-too-short  — content below the length floor is rejected with an
 *                          actionable error (and --force bypasses it).
 *   3. reject-junk-shape — test/scaffolding-shaped content and single bare
 *                          tokens are rejected (and --force bypasses them).
 *   4. near-dup-fold     — a retro >= 0.95 cosine to an existing retro folds
 *                          into the existing row (occurrences++) instead of
 *                          inserting a new one; a dissimilar retro inserts.
 *
 * Uses THINK_HOME isolation (same pattern as sync-handler.test.ts). The
 * @huggingface/transformers dep is mocked so tests run without the model.
 * Unlike sync-handler.test.ts, the mock maps content → a controllable vector
 * so cosine similarity between writes is deterministic — required for the
 * near-duplicate fold assertions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// Mock @huggingface/transformers with a content-controllable embedding.
//
// Each call returns a 384-dim unit-ish vector chosen by a marker substring in
// the content, so similarity between two writes is deterministic:
//   'BASE'  → e0-heavy vector
//   'NEAR'  → e0-heavy vector almost identical to BASE (cosine > 0.95)
//   'FAR'   → e1-heavy orthogonal-ish vector (cosine < 0.95 vs BASE)
//   default → a fixed mid vector
// ---------------------------------------------------------------------------

function unit(vec: number[]): Float32Array {
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return Float32Array.from(vec.map((v) => v / norm));
}

function vectorFor(content: string): Float32Array {
  const base = new Array(384).fill(0);
  if (content.includes('BASE')) {
    base[0] = 1; base[1] = 0.05;
  } else if (content.includes('NEAR')) {
    // Almost identical direction to BASE → cosine ~0.999.
    base[0] = 1; base[1] = 0.06; base[2] = 0.01;
  } else if (content.includes('FAR')) {
    base[1] = 1; base[2] = 0.1; // orthogonal-ish to BASE
  } else {
    base[10] = 1;
  }
  return unit(base);
}

vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn().mockResolvedValue(
    vi.fn(async (text: string) => ({ data: vectorFor(text) })),
  ),
}));

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let thinkHome: string;
const cortexName = 'test-retro-gate-cortex';

beforeEach(async () => {
  thinkHome = mkdtempSync(join(tmpdir(), 'think-retro-gate-test-'));
  process.env.THINK_HOME = thinkHome;

  const configDir = join(thinkHome, 'config');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const config = {
    peerId: 'test-peer-id-agt-455',
    syncPort: 9998,
    cortex: { author: 'test-author' },
  };
  fs.writeFileSync(join(configDir, 'config.json'), JSON.stringify(config) + '\n', { mode: 0o600 });

  const { getCortexDb, closeAllCortexDbs } = await import('../../src/db/engrams.js');
  closeAllCortexDbs();
  getCortexDb(cortexName);
  closeAllCortexDbs();
});

afterEach(async () => {
  const { closeAllCortexDbs } = await import('../../src/db/engrams.js');
  closeAllCortexDbs();
  vi.resetModules();
  rmSync(thinkHome, { recursive: true, force: true });
  delete process.env.THINK_HOME;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function countRetros(): Promise<number> {
  const { getCortexDb } = await import('../../src/db/engrams.js');
  const db = getCortexDb(cortexName);
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM memories WHERE kind = 'retro' AND deleted_at IS NULL",
  ).get() as { n: number };
  return row.n;
}

// ---------------------------------------------------------------------------
// AC1: accept
// ---------------------------------------------------------------------------

describe('retro quality gate (AGT-455)', () => {
  it('accepts a well-formed retro and stores it with occurrences=1', async () => {
    const { handleSync } = await import('../../src/daemon/sync-handler.js');
    const { getCortexDb } = await import('../../src/db/engrams.js');

    const content = 'BASE: lib/git.ts has two distinct git seams; the async wrapper supports a custom hooksPath';
    const result = await handleSync({ cortex: cortexName, content, kind: 'retro' });

    expect(result.status).toBe('stored');
    expect(result.folded).toBeUndefined();
    expect(result.supersession_scheduled).toBe(true);

    const db = getCortexDb(cortexName);
    const row = db.prepare('SELECT kind, occurrences FROM memories WHERE id = ?')
      .get(result.entry_id) as { kind: string; occurrences: number | null };
    expect(row.kind).toBe('retro');
    expect(row.occurrences).toBe(1);
    expect(await countRetros()).toBe(1);
  });

  // -------------------------------------------------------------------------
  // AC2: reject too short
  // -------------------------------------------------------------------------

  it('rejects a retro below the length floor with an actionable error', async () => {
    const { handleSync } = await import('../../src/daemon/sync-handler.js');

    await expect(
      handleSync({ cortex: cortexName, content: 'too short to be a lesson', kind: 'retro' }),
    ).rejects.toThrow(/too short.*minimum 40/);

    expect(await countRetros()).toBe(0);
  });

  it('accepts a too-short retro when force is set', async () => {
    const { handleSync } = await import('../../src/daemon/sync-handler.js');

    const result = await handleSync({
      cortex: cortexName,
      content: 'short note',
      kind: 'retro',
      force: true,
    });
    expect(result.status).toBe('stored');
    expect(await countRetros()).toBe(1);
  });

  it('does NOT apply the length floor to memory/event writes', async () => {
    const { handleSync } = await import('../../src/daemon/sync-handler.js');

    // A 9-char memory would fail the retro floor, but memories are untouched.
    const mem = await handleSync({ cortex: cortexName, content: 'tiny memo', kind: 'memory' });
    expect(mem.status).toBe('stored');

    const ev = await handleSync({ cortex: cortexName, content: 'repro', kind: 'event' });
    expect(ev.status).toBe('stored');
  });

  // -------------------------------------------------------------------------
  // AC3: reject junk shape
  // -------------------------------------------------------------------------

  it('rejects test/scaffolding-shaped retros (repro/rapid/trigger/test prefix)', async () => {
    const { handleSync } = await import('../../src/daemon/sync-handler.js');

    for (const junk of [
      'repro stamp-cli failure on the merge gate path again here',
      'rapid 1 attempt to reproduce the daemon race condition once more',
      'trigger A then B and observe the supersession worker behaviour',
      'test reproduction attempt 1 for the outbox-drain serialization race',
    ]) {
      await expect(
        handleSync({ cortex: cortexName, content: junk, kind: 'retro' }),
      ).rejects.toThrow(/test\/scaffolding detritus/);
    }
    expect(await countRetros()).toBe(0);
  });

  it('rejects a single bare token as a retro', async () => {
    const { handleSync } = await import('../../src/daemon/sync-handler.js');

    // Pad to clear the length floor so the single-token check is what fires.
    await expect(
      handleSync({ cortex: cortexName, content: 'supercalifragilisticexpialidocious-token-no-spaces-here', kind: 'retro' }),
    ).rejects.toThrow(/single bare token/);

    expect(await countRetros()).toBe(0);
  });

  it('accepts a junk-shaped retro when force is set', async () => {
    const { handleSync } = await import('../../src/daemon/sync-handler.js');

    const result = await handleSync({
      cortex: cortexName,
      content: 'repro: this is actually a real, deliberate lesson worth keeping',
      kind: 'retro',
      force: true,
    });
    expect(result.status).toBe('stored');
    expect(await countRetros()).toBe(1);
  });

  // -------------------------------------------------------------------------
  // AC4: near-duplicate fold
  // -------------------------------------------------------------------------

  it('folds a near-duplicate retro into the existing row (occurrences++) instead of inserting', async () => {
    const { handleSync } = await import('../../src/daemon/sync-handler.js');
    const { getCortexDb } = await import('../../src/db/engrams.js');

    const first = await handleSync({
      cortex: cortexName,
      content: 'BASE: always run database migrations inside a single transaction',
      kind: 'retro',
    });
    expect(first.folded).toBeUndefined();
    expect(await countRetros()).toBe(1);

    // NEAR maps to an embedding > 0.95 cosine to BASE → should fold.
    const dup = await handleSync({
      cortex: cortexName,
      content: 'NEAR: always run db migrations within one transaction for atomicity',
      kind: 'retro',
    });

    expect(dup.folded).toBe(true);
    expect(dup.entry_id).toBe(first.entry_id);
    // No supersession check is scheduled for a fold.
    expect(dup.supersession_scheduled).toBeUndefined();

    // Still exactly one retro row, with occurrences bumped to 2.
    expect(await countRetros()).toBe(1);
    const db = getCortexDb(cortexName);
    const row = db.prepare('SELECT occurrences FROM memories WHERE id = ?')
      .get(first.entry_id) as { occurrences: number };
    expect(row.occurrences).toBe(2);
  });

  it('inserts a dissimilar retro as a new row (below the near-dup threshold)', async () => {
    const { handleSync } = await import('../../src/daemon/sync-handler.js');

    const first = await handleSync({
      cortex: cortexName,
      content: 'BASE: always run database migrations inside a single transaction',
      kind: 'retro',
    });
    expect(await countRetros()).toBe(1);

    // FAR maps to a dissimilar embedding → cosine < 0.95 → new row.
    const second = await handleSync({
      cortex: cortexName,
      content: 'FAR: the recall relevance floor reuses the 0.6 compaction triage threshold',
      kind: 'retro',
    });

    expect(second.folded).toBeUndefined();
    expect(second.entry_id).not.toBe(first.entry_id);
    expect(await countRetros()).toBe(2);
  });
});
