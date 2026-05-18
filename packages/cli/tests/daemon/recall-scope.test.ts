/**
 * Tests for `think recall --scope` flag — AGT-308
 *
 * AC #1: --scope <value> accepted; allowed: active, accessible, all; default accessible.
 * AC #2: Invalid value exits with: error: invalid --scope value 'foo'; expected one of: active, accessible, all
 * AC #3: scope forwarded to daemon recall RPC's scope field.
 * AC #4: Help text gives one-line guidance (covered by Commander .option() string in recall.ts; no separate test needed).
 * AC #5: scope="active" queries only one cortex; scope="accessible" queries federated.
 *
 * Note: AC #5 daemon-layer behaviour (scope wiring in handleRecall) is covered by
 * tests/daemon/recall-federated.test.ts. This file covers the scope flag surface:
 * validation, default, and pass-through at the daemon RPC layer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
import { insertMemory } from '../../src/db/memory-queries.js';
import { handleRecall } from '../../src/daemon/recall.js';
import * as embedModule from '../../src/lib/embed.js';
import * as gitModule from '../../src/lib/git.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const DIM = 3;

function axis(pos: number): Float32Array {
  const v = new Float32Array(DIM);
  v[pos % DIM] = 1.0;
  return v;
}

function toBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

const CORTEX_ACTIVE = 'scope-active-cortex';
const CORTEX_OTHER = 'scope-other-cortex';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('think recall --scope (AGT-308)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-scope-'));
    process.env.THINK_HOME = tmpHome;
    closeAllCortexDbs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeAllCortexDbs();
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  // ── AC#2: invalid scope param rejected by handleRecall ─────────────────

  it('scope="invalid" rejected by handleRecall with a clear error (AC #2)', async () => {
    await expect(
      handleRecall({ query: 'anything', scope: 'invalid' }),
    ).rejects.toThrow(/scope.*must be one of/);
  });

  // ── AC#5: scope="active" queries only the single named cortex ──────────

  it('scope="active" queries only the named cortex, not other cortexes (AC #5)', async () => {
    // Populate CORTEX_ACTIVE with one entry pointing at axis(0).
    const dbA = getCortexDb(CORTEX_ACTIVE);
    const rowA = insertMemory(CORTEX_ACTIVE, {
      ts: new Date().toISOString(),
      author: 'test',
      content: 'entry in active cortex',
    });
    dbA.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
      .run(toBlob(axis(0)), rowA.id);

    // Populate CORTEX_OTHER with one entry — should NOT appear in results.
    const dbB = getCortexDb(CORTEX_OTHER);
    const rowB = insertMemory(CORTEX_OTHER, {
      ts: new Date().toISOString(),
      author: 'test',
      content: 'entry in other cortex',
    });
    dbB.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
      .run(toBlob(axis(0)), rowB.id);

    // listLocalBranches should NOT be called for scope="active"
    const branchSpy = vi.spyOn(gitModule, 'listLocalBranches');
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    const results = await handleRecall({
      query: 'test',
      cortex: CORTEX_ACTIVE,
      scope: 'active',
    });

    // Only the active cortex entry appears.
    expect(results.some((r) => r.id === rowA.id)).toBe(true);
    expect(results.some((r) => r.id === rowB.id)).toBe(false);
    for (const r of results) {
      expect(r.cortex).toBe(CORTEX_ACTIVE);
    }

    // federation must not have been invoked
    expect(branchSpy).not.toHaveBeenCalled();
  });

  // ── AC#5: scope="accessible" fans out to all local cortexes ────────────

  it('scope="accessible" queries all enumerated cortexes (AC #5)', async () => {
    // Populate both cortexes.
    const dbA = getCortexDb(CORTEX_ACTIVE);
    const rowA = insertMemory(CORTEX_ACTIVE, {
      ts: new Date().toISOString(),
      author: 'test',
      content: 'entry in active cortex',
    });
    dbA.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
      .run(toBlob(axis(0)), rowA.id);

    const dbB = getCortexDb(CORTEX_OTHER);
    const rowB = insertMemory(CORTEX_OTHER, {
      ts: new Date().toISOString(),
      author: 'test',
      content: 'entry in other cortex',
    });
    dbB.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
      .run(toBlob(axis(0)), rowB.id);

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    vi.spyOn(gitModule, 'listLocalBranches').mockReturnValue([CORTEX_ACTIVE, CORTEX_OTHER]);

    const results = await handleRecall({ query: 'test', scope: 'accessible', limit: 20 });

    // Results from BOTH cortexes should appear.
    const cortexNames = new Set(results.map((r) => r.cortex));
    expect(cortexNames.has(CORTEX_ACTIVE)).toBe(true);
    expect(cortexNames.has(CORTEX_OTHER)).toBe(true);
  });

  // ── AC#1: scope defaults to "accessible" ───────────────────────────────

  it('omitting scope defaults to accessible federation (AC #1)', async () => {
    const dbA = getCortexDb(CORTEX_ACTIVE);
    const rowA = insertMemory(CORTEX_ACTIVE, {
      ts: new Date().toISOString(),
      author: 'test',
      content: 'entry in active cortex',
    });
    dbA.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
      .run(toBlob(axis(0)), rowA.id);

    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    // listLocalBranches called when scope="accessible" (the default)
    const branchSpy = vi.spyOn(gitModule, 'listLocalBranches').mockReturnValue([CORTEX_ACTIVE]);

    const results = await handleRecall({ query: 'test' });
    expect(results.some((r) => r.id === rowA.id)).toBe(true);
    expect(branchSpy).toHaveBeenCalled();
  });
});
