/**
 * AGT-457 (design doc §5 M3) — close the surfacing → curation feedback loop.
 *
 * Every recall that surfaces a retro must write back to that retro's
 * `last_recalled_at` / `recalled_count` on the retros table, so the curator's
 * relegation path (previously dormant) can fire. This exercises the live
 * write-back wired into recordSurfacings (recall.ts).
 *
 * A retro is stored in BOTH the memories table (kind='retro', what recall
 * reads) and the retros table (what the curator reads), sharing one id. The
 * fixtures populate both so the surfaced id matches a retros row.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
import { insertMemory } from '../../src/db/memory-queries.js';
import { insertRetro } from '../../src/db/retro-queries.js';
import { handleRecall } from '../../src/daemon/recall.js';
import { saveConfig, getConfig } from '../../src/lib/config.js';
import * as embedModule from '../../src/lib/embed.js';

const DIM = 3;
function axis(pos: number): Float32Array {
  const v = new Float32Array(DIM);
  v[pos % DIM] = 1.0;
  return v;
}
function toBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer);
}

const CORTEX = 'recall-surfacing-test';

describe('recall surfacing → retros.last_recalled_at write-back (AGT-457)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;
  let retroId: string;

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-recall-surfacing-'));
    process.env.THINK_HOME = tmpHome;
    closeAllCortexDbs();

    const db = getCortexDb(CORTEX);

    // Insert the retro into BOTH tables with a shared id: the memories row is
    // what recall surfaces, the retros row is what the curator (and
    // bumpRecallStats) updates.
    const mem = insertMemory(CORTEX, {
      ts: new Date().toISOString(),
      author: 'test',
      content: 'always run schema migrations inside a transaction',
    });
    retroId = mem.id;
    // insertMemory doesn't persist `kind` (it's set by the sync-handler's raw
    // INSERT in production); stamp it directly alongside the embedding so recall
    // tags the entry kind='retro'.
    db.prepare('UPDATE memories SET embedding = ?, kind = ? WHERE id = ?').run(
      toBlob(axis(0)),
      'retro',
      retroId,
    );

    insertRetro(CORTEX, {
      id: retroId,
      content: 'always run schema migrations inside a transaction',
    });

    // Floor off so the orthogonal-vector fixture isn't dropped.
    saveConfig({ ...getConfig(), recall: { relevanceFloor: -1 } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeAllCortexDbs();
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('advances last_recalled_at and recalled_count when a retro is surfaced', async () => {
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));

    // Precondition: never recalled.
    const db = getCortexDb(CORTEX);
    const before = db
      .prepare('SELECT last_recalled_at, recalled_count FROM retros WHERE id = ?')
      .get(retroId) as { last_recalled_at: string | null; recalled_count: number };
    expect(before.last_recalled_at).toBeNull();
    expect(before.recalled_count).toBe(0);

    const results = await handleRecall({ cortex: CORTEX, query: 'migrations' });
    expect(results.some(r => r.id === retroId && r.kind === 'retro')).toBe(true);

    const after = db
      .prepare('SELECT last_recalled_at, recalled_count FROM retros WHERE id = ?')
      .get(retroId) as { last_recalled_at: string | null; recalled_count: number };
    expect(after.last_recalled_at).not.toBeNull();
    expect(after.recalled_count).toBe(1);
  });

  it('increments recalled_count on each subsequent surfacing', async () => {
    vi.spyOn(embedModule, 'default').mockResolvedValue(axis(0));
    const db = getCortexDb(CORTEX);

    await handleRecall({ cortex: CORTEX, query: 'migrations' });
    await handleRecall({ cortex: CORTEX, query: 'migrations again' });

    const after = db
      .prepare('SELECT recalled_count FROM retros WHERE id = ?')
      .get(retroId) as { recalled_count: number };
    expect(after.recalled_count).toBe(2);
  });
});
