/**
 * One-shot rescue of stranded engram rows — AGT-1302.
 *
 * Seeds the four shapes that actually exist in the wild (live, expired,
 * decision-bearing, `subscribe:*`) plus the malformed ones a year of
 * unvalidated writers left behind, and pins the contract: kinds, original
 * timestamps, the migration marker, idempotency, the skip count, and a
 * `--dry-run` that writes nothing at all.
 *
 * Everything here runs against a THINK_HOME under os.tmpdir(). Nothing in this
 * file may ever open a real cortex — the rows this migration moves are not
 * recoverable once moved.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock the embedding pipeline so tests don't download the 150MB model.
const MOCK_EMBEDDING = Float32Array.from({ length: 384 }, (_, i) => i / 384);
vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn().mockResolvedValue(
    vi.fn().mockResolvedValue({ data: MOCK_EMBEDDING }),
  ),
}));

let thinkHome: string;
let originalThinkHome: string | undefined;
const logLines: string[] = [];
const log = (msg: string): void => { logLines.push(msg); };

const PAST = '2026-05-01T09:00:00.000Z';
const EXPIRED = '2026-05-15T09:00:00.000Z';
const FUTURE = '2099-01-01T00:00:00.000Z';

beforeEach(async () => {
  originalThinkHome = process.env.THINK_HOME;
  thinkHome = mkdtempSync(join(tmpdir(), 'think-engram-migration-'));
  process.env.THINK_HOME = thinkHome;
  logLines.length = 0;

  const configDir = join(thinkHome, 'config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({ peerId: 'migration-test-peer', cortex: { author: 'test-author' } }),
    { mode: 0o600 },
  );

  vi.resetModules();
  const { closeAllCortexDbs } = await import('../../src/db/engrams.js');
  closeAllCortexDbs();
});

afterEach(async () => {
  const { closeAllCortexDbs } = await import('../../src/db/engrams.js');
  closeAllCortexDbs();
  if (originalThinkHome === undefined) delete process.env.THINK_HOME;
  else process.env.THINK_HOME = originalThinkHome;
  rmSync(thinkHome, { recursive: true, force: true });
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Seeding — straight SQL, so a row can have any shape the old writers produced
// ---------------------------------------------------------------------------

interface SeedRow {
  id: string;
  content: string;
  created_at?: string;
  expires_at?: string;
  evaluated_at?: string | null;
  deleted_at?: string | null;
  episode_key?: string | null;
  context?: string | null;
  decisions?: string | null;
}

async function seed(cortex: string, rows: SeedRow[]): Promise<void> {
  const { getCortexDb } = await import('../../src/db/engrams.js');
  const db = getCortexDb(cortex);
  const stmt = db.prepare(
    `INSERT INTO engrams (id, content, created_at, expires_at, evaluated_at, deleted_at, episode_key, context, decisions)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    stmt.run(
      row.id,
      row.content,
      row.created_at ?? PAST,
      row.expires_at ?? FUTURE,
      row.evaluated_at ?? null,
      row.deleted_at ?? null,
      row.episode_key ?? null,
      row.context ?? null,
      row.decisions ?? null,
    );
  }
}

async function memoryRows(cortex: string): Promise<Record<string, unknown>[]> {
  const { getCortexDb } = await import('../../src/db/engrams.js');
  return getCortexDb(cortex)
    .prepare(
      `SELECT id, ts, created_at, kind, content, topics_json, author, origin_peer_id,
              embedding_model, activity_seq, occurrences
         FROM memories ORDER BY ts ASC, id ASC`,
    )
    .all() as unknown as Record<string, unknown>[];
}

async function engramRows(cortex: string): Promise<Record<string, unknown>[]> {
  const { getCortexDb } = await import('../../src/db/engrams.js');
  return getCortexDb(cortex)
    .prepare('SELECT id, evaluated_at, promoted FROM engrams ORDER BY id ASC')
    .all() as unknown as Record<string, unknown>[];
}

async function outboxRows(cortex: string): Promise<{ entry_id: string; line: string; created_at: string }[]> {
  const { getCortexDb } = await import('../../src/db/engrams.js');
  return getCortexDb(cortex)
    .prepare('SELECT entry_id, line, created_at FROM l1_outbox ORDER BY id ASC')
    .all() as unknown as { entry_id: string; line: string; created_at: string }[];
}

async function migrate(opts: Record<string, unknown> = {}): Promise<
  Awaited<ReturnType<typeof import('../../src/lib/engram-migration.js')['migrateStrandedEngrams']>>
> {
  const { migrateStrandedEngrams } = await import('../../src/lib/engram-migration.js');
  return migrateStrandedEngrams({ log, ...opts });
}

/** The four shapes AC6 names, in one cortex. */
async function seedTheFourShapes(cortex: string): Promise<void> {
  await seed(cortex, [
    { id: 'row-live', content: 'a live observation' },
    { id: 'row-expired', content: 'an observation past its TTL', expires_at: EXPIRED },
    {
      id: 'row-decision',
      content: 'explored the git-remote backend',
      decisions: JSON.stringify(['Decided to keep the outbox hand-off']),
      created_at: '2026-05-02T09:00:00.000Z',
    },
    { id: 'row-subscribe', content: 'a feed item', episode_key: 'subscribe:teammate-feed' },
  ]);
}

// ---------------------------------------------------------------------------

describe('migrateStrandedEngrams — AC1/AC2/AC3', () => {
  it('rescues live, expired and decision-bearing rows and skips subscribe rows', async () => {
    await seedTheFourShapes('alpha');

    const summary = await migrate({ cortexes: ['alpha'] });

    expect(summary.totals).toMatchObject({
      events: 1, memories: 2, skippedSubscribe: 1, skippedInvalid: 0, failed: 0, repaired: 0,
    });

    const rows = await memoryRows('alpha');
    expect(rows).toHaveLength(3);

    // The expired row is rescued too — it was the one most at risk (AC1).
    const contents = rows.map((r) => r.content as string);
    expect(contents).toContain('an observation past its TTL');

    // Decision-bearing → event, content and decision on one line.
    const event = rows.find((r) => r.kind === 'event')!;
    expect(event.content).toBe(
      'explored the git-remote backend — Decisions: Decided to keep the outbox hand-off',
    );
    // Everything else → memory.
    expect(rows.filter((r) => r.kind === 'memory')).toHaveLength(2);

    // Original created_at preserved on both L2 columns — not the migration time.
    expect(event.ts).toBe('2026-05-02T09:00:00.000Z');
    expect(event.created_at).toBe('2026-05-02T09:00:00.000Z');
    expect(rows.find((r) => r.id === event.id)!.ts).toBe('2026-05-02T09:00:00.000Z');

    // Written as a normal entry: author, peer, embedding, activity_seq (AC1).
    expect(event.author).toBe('test-author');
    expect(event.origin_peer_id).toBe('migration-test-peer');
    expect(event.embedding_model).toBeTruthy();
    expect(event.activity_seq).toBeTruthy();
    expect(event.occurrences).toBeNull(); // retro-only column

    // AC3: every rescued entry is marked as migrated.
    for (const row of rows) {
      expect(JSON.parse(row.topics_json as string)).toContain('migrated-engram');
    }

    // AC3: source rows stamped — except the subscribe row, which was not moved.
    const engrams = await engramRows('alpha');
    const bySrc = Object.fromEntries(engrams.map((e) => [e.id, e]));
    expect(bySrc['row-live'].evaluated_at).toBeTruthy();
    expect(bySrc['row-live'].promoted).toBe(1);
    expect(bySrc['row-expired'].evaluated_at).toBeTruthy();
    expect(bySrc['row-decision'].evaluated_at).toBeTruthy();
    expect(bySrc['row-subscribe'].evaluated_at).toBeNull();
  });

  it('hands every rescued entry to L1 through the outbox, at its original timestamp', async () => {
    await seedTheFourShapes('beta');
    await migrate({ cortexes: ['beta'] });

    const outbox = await outboxRows('beta');
    expect(outbox).toHaveLength(3);
    const line = JSON.parse(outbox.find((r) => r.created_at === '2026-05-02T09:00:00.000Z')!.line) as Record<string, unknown>;
    expect(line.kind).toBe('event');
    expect(line.ts).toBe('2026-05-02T09:00:00.000Z');
    expect(line.deleted_at).toBeNull();
    expect(line.topics).toContain('migrated-engram');
    // Same shared entry model every other L1 writer uses (AGT-1298).
    expect(line).toHaveProperty('supersedes');
    expect(line).toHaveProperty('compacted_from');
    expect(line).toHaveProperty('source_ids');
  });

  it('is idempotent — a second run migrates nothing (AC3)', async () => {
    await seedTheFourShapes('gamma');

    const first = await migrate({ cortexes: ['gamma'] });
    expect(first.totals.events + first.totals.memories).toBe(3);

    const second = await migrate({ cortexes: ['gamma'] });
    expect(second.totals).toMatchObject({ events: 0, memories: 0, failed: 0, repaired: 0 });
    // The subscribe row is still reported as skipped — it is still there.
    expect(second.totals.skippedSubscribe).toBe(1);
    expect(await memoryRows('gamma')).toHaveLength(3);
    expect(await outboxRows('gamma')).toHaveLength(3);
  });

  it('never writes a second entry for a row whose stamp was lost', async () => {
    // A DB restored from a backup taken between the entry write and the stamp
    // — the case the deterministic entry id exists for.
    await seed('delta', [{ id: 'row-1', content: 'written once' }]);
    await migrate({ cortexes: ['delta'] });

    const { getCortexDb } = await import('../../src/db/engrams.js');
    getCortexDb('delta')
      .prepare('UPDATE engrams SET evaluated_at = NULL, promoted = NULL WHERE id = ?')
      .run('row-1');

    const again = await migrate({ cortexes: ['delta'] });
    expect(again.totals).toMatchObject({ events: 0, memories: 0, repaired: 1 });
    expect(await memoryRows('delta')).toHaveLength(1);
    // …and the stamp is back, so a third run does nothing at all.
    expect((await engramRows('delta'))[0].evaluated_at).toBeTruthy();
  });

  it('leaves already-evaluated and soft-deleted rows alone', async () => {
    await seed('eps', [
      { id: 'row-evaluated', content: 'the curator already saw this', evaluated_at: PAST },
      { id: 'row-deleted', content: 'soft-deleted', deleted_at: PAST },
    ]);

    const summary = await migrate({ cortexes: ['eps'] });
    expect(summary.totals.events + summary.totals.memories).toBe(0);
    expect(await memoryRows('eps')).toHaveLength(0);
  });

  it('re-encodes the row context as the repo: topic so brief still scopes it', async () => {
    await seed('zeta', [{ id: 'row-1', content: 'a lesson', context: 'Think-CLI' }]);
    await migrate({ cortexes: ['zeta'] });

    const topics = JSON.parse((await memoryRows('zeta'))[0].topics_json as string) as string[];
    expect(topics).toEqual(['migrated-engram', 'repo:think-cli']);
  });

  it('sweeps every cortex under the index dir, including slash-named ones', async () => {
    await seed('home', [{ id: 'h-1', content: 'home row' }]);
    await seed('cortex/engineering', [{ id: 'e-1', content: 'engineering row' }]);

    // No `cortexes` option — the default walk is listKnownCortexes(), which is
    // recursive (a flat readdir hides `cortex/engineering`; that was #78).
    const summary = await migrate();
    expect(summary.cortexes.map((c) => c.cortex).sort()).toEqual(['cortex/engineering', 'home']);
    expect(summary.totals.memories).toBe(2);
    expect(await memoryRows('cortex/engineering')).toHaveLength(1);
  });

  it('is not swallowed by the paused config', async () => {
    // `think pause` suppresses new CLI event creation. It must not decide
    // whether a year of stranded decisions gets rescued.
    const configPath = join(thinkHome, 'config', 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        peerId: 'migration-test-peer',
        paused: true,
        cortex: { author: 'test-author' },
      }),
      { mode: 0o600 },
    );
    await seed('eta', [{ id: 'row-1', content: 'stranded while paused' }]);

    const summary = await migrate({ cortexes: ['eta'] });
    expect(summary.totals.memories).toBe(1);
    expect(await memoryRows('eta')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('migrateStrandedEngrams — legacy rows the v3 write path would reject', () => {
  it('parses malformed, empty and non-string decisions defensively', async () => {
    await seed('dec', [
      { id: 'd-broken', content: 'broken json', decisions: '{not json at all' },
      { id: 'd-empty', content: 'empty array', decisions: '[]' },
      { id: 'd-nonstring', content: 'non-string members', decisions: JSON.stringify([{ text: 'x' }, 42]) },
      { id: 'd-notarray', content: 'not an array', decisions: JSON.stringify('a bare string') },
      { id: 'd-blank', content: 'blank column', decisions: '   ' },
    ]);

    const summary = await migrate({ cortexes: ['dec'] });
    // Empty array and blank string carry no decision text → memories.
    expect(summary.totals).toMatchObject({ events: 3, memories: 2, skippedInvalid: 0, failed: 0 });

    const byContent = new Map(
      (await memoryRows('dec')).map((r) => [(r.content as string).split(' —')[0], r]),
    );
    // Unparseable JSON is kept verbatim rather than dropped.
    expect(byContent.get('broken json')!.content).toBe(
      'broken json — Decisions: {not json at all',
    );
    expect(byContent.get('broken json')!.kind).toBe('event');
    // Non-string members are rendered, not silently discarded.
    expect(byContent.get('non-string members')!.content).toBe(
      'non-string members — Decisions: {"text":"x"}; 42',
    );
    expect(byContent.get('not an array')!.content).toBe(
      'not an array — Decisions: a bare string',
    );
    expect(byContent.get('empty array')!.kind).toBe('memory');
    expect(byContent.get('blank column')!.kind).toBe('memory');
  });

  it('strips control characters instead of re-submitting them', async () => {
    await seed('ctl', [
      { id: 'c-1', content: 'clean\x1b[31m red\x07 text0m', decisions: JSON.stringify(['drop\x00this']) },
    ]);

    await migrate({ cortexes: ['ctl'] });

    const content = (await memoryRows('ctl'))[0].content as string;
    expect(content).toBe('clean[31m red text0m — Decisions: dropthis');
    expect(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(content)).toBe(false);
  });

  it('truncates an oversized legacy row rather than dropping it, keeping the decision', async () => {
    await seed('big', [
      {
        id: 'b-1',
        content: 'X'.repeat(70 * 1024),
        decisions: JSON.stringify(['the decision must survive']),
      },
    ]);

    const summary = await migrate({ cortexes: ['big'] });
    expect(summary.totals).toMatchObject({ events: 1, skippedInvalid: 0 });

    const content = (await memoryRows('big'))[0].content as string;
    expect(Buffer.byteLength(content, 'utf-8')).toBeLessThanOrEqual(64 * 1024);
    expect(content).toContain('truncated by engram migration');
    expect(content.endsWith('— Decisions: the decision must survive')).toBe(true);
    expect(summary.cortexes[0].warnings.join(' ')).toContain('truncated');
  });

  it('reports an unusable row and leaves it in place rather than dropping it', async () => {
    await seed('bad', [
      { id: 'x-1', content: '\x00\x07\x1b' }, // nothing left once stripped
      { id: 'x-2', content: 'a usable row' },
    ]);

    const summary = await migrate({ cortexes: ['bad'] });
    expect(summary.totals).toMatchObject({ memories: 1, skippedInvalid: 1 });
    // Named in the warnings, logged, and — critically — NOT stamped, so the
    // row is still there to be looked at.
    expect(summary.cortexes[0].warnings.join(' ')).toContain('x-1');
    expect(logLines.join('\n')).toContain('x-1');
    const engrams = Object.fromEntries((await engramRows('bad')).map((e) => [e.id, e]));
    expect(engrams['x-1'].evaluated_at).toBeNull();
    expect(engrams['x-2'].evaluated_at).toBeTruthy();
  });

  it('leaves a row unstamped when its entry cannot be embedded', async () => {
    await seed('embed-fail', [{ id: 'row-1', content: 'needs an embedding' }]);

    const embedMod = await import('../../src/lib/embed.js');
    const spy = vi.spyOn(embedMod, 'default').mockRejectedValue(new Error('model unavailable'));
    try {
      const summary = await migrate({ cortexes: ['embed-fail'] });
      expect(summary.totals).toMatchObject({ events: 0, memories: 0, failed: 1 });
    } finally {
      spy.mockRestore();
    }

    expect(await memoryRows('embed-fail')).toHaveLength(0);
    expect((await engramRows('embed-fail'))[0].evaluated_at).toBeNull();

    // The next run — with embedding back — picks it up. Nothing was lost.
    const retry = await migrate({ cortexes: ['embed-fail'] });
    expect(retry.totals.memories).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('migrateStrandedEngrams — --dry-run (AC4)', () => {
  it('reports per-cortex counts and writes nothing at all', async () => {
    await seedTheFourShapes('dry');
    await seed('dry-2', [{ id: 'other', content: 'another cortex' }]);

    // A read-only pass cannot share this process's write handles.
    const { closeAllCortexDbs } = await import('../../src/db/engrams.js');
    closeAllCortexDbs();

    const summary = await migrate({ dryRun: true });
    expect(summary.dryRun).toBe(true);
    const byCortex = Object.fromEntries(summary.cortexes.map((c) => [c.cortex, c]));
    expect(byCortex['dry']).toMatchObject({ events: 1, memories: 2, skippedSubscribe: 1 });
    expect(byCortex['dry-2']).toMatchObject({ events: 0, memories: 1, skippedSubscribe: 0 });
    expect(summary.cortexes.every((c) => c.error === undefined)).toBe(true);

    // Nothing written: no entries, no outbox hand-off, no stamps.
    expect(await memoryRows('dry')).toHaveLength(0);
    expect(await outboxRows('dry')).toHaveLength(0);
    expect((await engramRows('dry')).every((r) => r.evaluated_at === null)).toBe(true);
  });

  it('predicts exactly what the real run then does', async () => {
    await seedTheFourShapes('predict');
    const { closeAllCortexDbs } = await import('../../src/db/engrams.js');
    closeAllCortexDbs();

    const preview = await migrate({ cortexes: ['predict'], dryRun: true });
    const real = await migrate({ cortexes: ['predict'] });

    expect(real.totals.events).toBe(preview.totals.events);
    expect(real.totals.memories).toBe(preview.totals.memories);
    expect(real.totals.skippedSubscribe).toBe(preview.totals.skippedSubscribe);
    expect(real.totals.skippedInvalid).toBe(preview.totals.skippedInvalid);
  });
});
