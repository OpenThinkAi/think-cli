/**
 * #97 (AGT-1330): the retro curator persists dedupe judgments and skips pairs
 * it has already judged while both sides are unchanged, so a quiescent cortex
 * makes zero LLM dedupe calls per curation run.
 *
 * These drive the real FTS candidate builder (getCandidatePairs is NOT mocked)
 * through runCurationPasses; only the LLM call (runRetroDedupe) is stubbed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCortexDb, closeAllCortexDbs } from '../../src/db/engrams.js';
import { closeUsageDb } from '../../src/db/usage-db.js';
import {
  insertRetro,
  getDedupeJudgmentHashes,
  retroContentHash,
  retroPairKey,
} from '../../src/db/retro-queries.js';
import * as retroCurator from '../../src/lib/retro-curator.js';
import { runCurationPasses, type CurationLogger } from '../../src/commands/curate-retros.js';
import { resolveRetroValueWeights } from '../../src/lib/retro-value-signal.js';
import type { DedupeJudgment } from '../../src/lib/retro-curator.js';

const WEIGHTS = resolveRetroValueWeights(undefined);

function captureLogger(): { logger: CurationLogger; lines: string[] } {
  const lines: string[] = [];
  const push = (m: string) => { lines.push(m); };
  return {
    lines,
    logger: { info: push, merged: push, promoted: push, relegated: push, detail: push },
  };
}

/** Stub that answers every pair in the prompt with the given verdict. */
function stubDedupe(equivalent: boolean) {
  return vi.spyOn(retroCurator, 'runRetroDedupe').mockImplementation(async (prompt: string) => {
    const out: DedupeJudgment[] = [];
    const re = /A \(id: ([^)]+)\):[\s\S]*?B \(id: ([^)]+)\):/g;
    for (const m of prompt.matchAll(re)) out.push({ a: m[1], b: m[2], equivalent });
    return out;
  });
}

function run(cortex: string, logger: CurationLogger, dryRun = false) {
  return runCurationPasses(cortex, dryRun, 50, WEIGHTS, logger);
}

const NO_CANDIDATES = '(no dedupe candidates: no new or changed retro pairs since they were last judged)';

describe('retro dedupe judgments (#97)', () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'think-dedupe-judgments-test-'));
    process.env.THINK_HOME = tmpHome;
    closeAllCortexDbs();
    closeUsageDb();
  });

  afterEach(() => {
    closeAllCortexDbs();
    closeUsageDb();
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('migration v20 creates retro_dedupe_judgments', () => {
    const db = getCortexDb('v20-schema');
    const cols = (db.prepare('PRAGMA table_info(retro_dedupe_judgments)').all() as { name: string }[])
      .map(c => c.name);
    expect(cols).toEqual(['retro_a', 'retro_b', 'hash_a', 'hash_b', 'equivalent', 'judged_at']);
    const v = db.prepare('SELECT MAX(version) AS v FROM _migrations').get() as { v: number };
    expect(v.v).toBeGreaterThanOrEqual(20);
  });

  it('a quiescent cortex makes zero LLM dedupe calls on the next run and logs no candidates', async () => {
    const cortex = 'quiescent';
    const a = insertRetro(cortex, { content: 'database migrations transaction should always be wrapped' });
    const b = insertRetro(cortex, { content: 'database migrations need a transaction around each step' });
    const llm = stubDedupe(false);

    const first = captureLogger();
    await run(cortex, first.logger);
    expect(llm).toHaveBeenCalledTimes(1);
    expect(llm.mock.calls[0][0]).toContain(a.id);
    expect(llm.mock.calls[0][0]).toContain(b.id);

    // The not-equivalent verdict is persisted with both content hashes.
    const stored = getDedupeJudgmentHashes(cortex).get(retroPairKey(a.id, b.id));
    expect(stored?.get(a.id)).toBe(retroContentHash(a.content));
    expect(stored?.get(b.id)).toBe(retroContentHash(b.content));
    const row = getCortexDb(cortex).prepare('SELECT equivalent FROM retro_dedupe_judgments').get() as { equivalent: number };
    expect(row.equivalent).toBe(0);

    const second = captureLogger();
    await run(cortex, second.logger);
    await run(cortex, captureLogger().logger);
    expect(llm).toHaveBeenCalledTimes(1);
    expect(second.lines.some(l => l.includes(NO_CANDIDATES))).toBe(true);
  });

  it('a new retro re-enters the candidate set with only its new pairs', async () => {
    const cortex = 'new-retro';
    const a = insertRetro(cortex, { content: 'database migrations transaction should always be wrapped' });
    const b = insertRetro(cortex, { content: 'database migrations need a transaction around each step' });
    const llm = stubDedupe(false);
    await run(cortex, captureLogger().logger);
    expect(llm).toHaveBeenCalledTimes(1);

    const c = insertRetro(cortex, { content: 'database migrations transaction rollback on failure' });
    await run(cortex, captureLogger().logger);
    expect(llm).toHaveBeenCalledTimes(2);
    const prompt = llm.mock.calls[1][0];
    expect(prompt).toContain(c.id);
    // The already-judged a|b pair is not re-sent.
    expect(prompt).not.toMatch(new RegExp(`A \\(id: (${a.id}|${b.id})\\):[^\\n]*\\n\\s*B \\(id: (${a.id}|${b.id})\\)`));
  });

  it('editing either retro invalidates the stored verdict and re-judges the pair', async () => {
    const cortex = 'edited';
    const a = insertRetro(cortex, { content: 'database migrations transaction should always be wrapped' });
    const b = insertRetro(cortex, { content: 'database migrations need a transaction around each step' });
    const llm = stubDedupe(false);
    await run(cortex, captureLogger().logger);
    expect(llm).toHaveBeenCalledTimes(1);

    getCortexDb(cortex)
      .prepare('UPDATE retros SET content = ? WHERE id = ?')
      .run('database migrations need a transaction around every step', b.id);

    await run(cortex, captureLogger().logger);
    expect(llm).toHaveBeenCalledTimes(2);
    expect(llm.mock.calls[1][0]).toContain(a.id);
    expect(llm.mock.calls[1][0]).toContain(b.id);

    // Re-recorded against the new content — the following run is quiet again.
    await run(cortex, captureLogger().logger);
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it('equivalent pairs still merge as before and the verdict is recorded', async () => {
    const cortex = 'equivalent';
    const a = insertRetro(cortex, { content: 'database migrations transaction should always be wrapped' });
    const b = insertRetro(cortex, { content: 'database migrations need a transaction around each step' });
    stubDedupe(true);

    const cap = captureLogger();
    const result = await run(cortex, cap.logger);
    expect(result.merged).toBe(1);

    const db = getCortexDb(cortex);
    const canonical = db.prepare('SELECT occurrences, tombstoned_at FROM retros WHERE id = ?').get(a.id) as { occurrences: number; tombstoned_at: string | null };
    const merged = db.prepare('SELECT tombstone_reason FROM retros WHERE id = ?').get(b.id) as { tombstone_reason: string };
    expect(canonical.occurrences).toBe(2);
    expect(canonical.tombstoned_at).toBeNull();
    expect(merged.tombstone_reason).toBe(`merged_into:${a.id}`);
    const row = db.prepare('SELECT equivalent FROM retro_dedupe_judgments').get() as { equivalent: number };
    expect(row.equivalent).toBe(1);
  });

  it('a pair the model omits from its answer stays unjudged and is retried', async () => {
    const cortex = 'omitted';
    insertRetro(cortex, { content: 'database migrations transaction should always be wrapped' });
    insertRetro(cortex, { content: 'database migrations need a transaction around each step' });
    const llm = vi.spyOn(retroCurator, 'runRetroDedupe').mockResolvedValue([]);

    await run(cortex, captureLogger().logger);
    await run(cortex, captureLogger().logger);
    expect(llm).toHaveBeenCalledTimes(2);
    expect(getDedupeJudgmentHashes(cortex).size).toBe(0);
  });

  it('--dry-run does not persist judgments', async () => {
    const cortex = 'dry-run';
    insertRetro(cortex, { content: 'database migrations transaction should always be wrapped' });
    insertRetro(cortex, { content: 'database migrations need a transaction around each step' });
    const llm = stubDedupe(false);

    await run(cortex, captureLogger().logger, true);
    expect(getDedupeJudgmentHashes(cortex).size).toBe(0);
    await run(cortex, captureLogger().logger);
    expect(llm).toHaveBeenCalledTimes(2);
  });
});
