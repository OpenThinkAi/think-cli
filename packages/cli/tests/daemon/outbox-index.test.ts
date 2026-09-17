/**
 * Boot-time L1 → L2 indexing of pending outbox rows — AGT-1298.
 *
 * The daemon-down CLI fallback enqueues an L1 line with no L2 row (a CLI
 * process cannot afford to load the embedding model). This is the daemon-side
 * half that makes such an entry recallable on the next start, without a manual
 * `think reindex`.
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
let originalHome: string | undefined;
const logLines: string[] = [];
const writeLine = (msg: string): void => { logLines.push(msg); };

beforeEach(async () => {
  originalHome = process.env.THINK_HOME;
  thinkHome = mkdtempSync(join(tmpdir(), 'think-outbox-index-'));
  process.env.THINK_HOME = thinkHome;
  logLines.length = 0;

  const configDir = join(thinkHome, 'config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({ peerId: 'index-test-peer', cortex: { author: 'test-author' } }),
    { mode: 0o600 },
  );

  vi.resetModules();
  const { closeAllCortexDbs } = await import('../../src/db/engrams.js');
  closeAllCortexDbs();
});

afterEach(async () => {
  const { closeAllCortexDbs } = await import('../../src/db/engrams.js');
  closeAllCortexDbs();
  if (originalHome === undefined) delete process.env.THINK_HOME;
  else process.env.THINK_HOME = originalHome;
  rmSync(thinkHome, { recursive: true, force: true });
  vi.resetModules();
});

/** Enqueue one L1 line the way the daemon-down CLI fallback would. */
async function enqueue(
  cortex: string,
  entry: Record<string, unknown>,
): Promise<void> {
  const { getCortexDb } = await import('../../src/db/engrams.js');
  const { enqueueL1Outbox } = await import('../../src/lib/l1-page.js');
  enqueueL1Outbox(
    getCortexDb(cortex),
    entry.id as string,
    JSON.stringify(entry),
    entry.ts as string,
  );
}

function makeEntry(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: '01920000-0000-7000-8000-000000000001',
    ts: '2026-09-17T10:00:00.000Z',
    author: 'test-author',
    origin_peer_id: 'index-test-peer',
    kind: 'memory',
    content: 'written while the daemon was down',
    topics: [],
    supersedes: [],
    compacted_from: null,
    decisions: [],
    source_ids: [],
    deleted_at: null,
    ...over,
  };
}

async function memoryRows(cortex: string): Promise<Record<string, unknown>[]> {
  const { getCortexDb } = await import('../../src/db/engrams.js');
  return getCortexDb(cortex)
    .prepare('SELECT id, kind, content, ts, created_at, topics_json, occurrences, embedding_model, activity_seq FROM memories ORDER BY id ASC')
    .all() as unknown as Record<string, unknown>[];
}

describe('indexPendingOutboxEntries', () => {
  it('indexes one entry of each kind into L2, kind and write time preserved', async () => {
    await enqueue('alpha', makeEntry({ id: 'e-mem', kind: 'memory', content: 'a memory written offline' }));
    await enqueue('alpha', makeEntry({ id: 'e-evt', kind: 'event', content: 'an event written offline', topics: ['deploy'] }));
    await enqueue('alpha', makeEntry({ id: 'e-ret', kind: 'retro', content: 'a retro written offline' }));

    const { indexPendingOutboxEntries } = await import('../../src/daemon/outbox-index.js');
    const indexed = await indexPendingOutboxEntries(['alpha'], writeLine);

    expect(indexed).toBe(3);
    const rows = await memoryRows('alpha');
    expect(rows.map(r => `${r.id}:${r.kind}`).sort()).toEqual([
      'e-evt:event', 'e-mem:memory', 'e-ret:retro',
    ]);
    // Original write time, not the boot time.
    expect(rows[0].ts).toBe('2026-09-17T10:00:00.000Z');
    expect(rows[0].created_at).toBe('2026-09-17T10:00:00.000Z');
    expect(rows.find(r => r.id === 'e-evt')!.topics_json).toBe('["deploy"]');
    // Retro-only occurrences baseline, same as handleSync.
    expect(rows.find(r => r.id === 'e-ret')!.occurrences).toBe(1);
    expect(rows.find(r => r.id === 'e-mem')!.occurrences).toBeNull();
    // Embedded — the whole reason the daemon (not the CLI) does this.
    expect(rows[0].embedding_model).toBeTruthy();
    expect(rows[0].activity_seq).toBeTruthy();
    expect(logLines.join('\n')).toContain('indexed 3');
  });

  it('is idempotent — a second pass indexes nothing', async () => {
    await enqueue('beta', makeEntry({ id: 'e-1' }));

    const { indexPendingOutboxEntries } = await import('../../src/daemon/outbox-index.js');
    expect(await indexPendingOutboxEntries(['beta'], writeLine)).toBe(1);
    expect(await indexPendingOutboxEntries(['beta'], writeLine)).toBe(0);
    expect(await memoryRows('beta')).toHaveLength(1);
  });

  it('skips rows the daemon already wrote to L2 (its own un-drained outbox)', async () => {
    // Simulate handleSync's transactional pair: L2 row + outbox row.
    const { getCortexDb } = await import('../../src/db/engrams.js');
    const db = getCortexDb('gamma');
    db.prepare(
      `INSERT INTO memories (id, ts, author, content, source_ids, created_at, sync_version, kind)
       VALUES (?, ?, ?, ?, '[]', ?, 1, 'memory')`,
    ).run('daemon-written', '2026-09-17T09:00:00.000Z', 'test-author', 'daemon wrote this', '2026-09-17T09:00:00.000Z');
    await enqueue('gamma', makeEntry({ id: 'daemon-written', content: 'daemon wrote this' }));

    const { indexPendingOutboxEntries } = await import('../../src/daemon/outbox-index.js');
    expect(await indexPendingOutboxEntries(['gamma'], writeLine)).toBe(0);
    expect(await memoryRows('gamma')).toHaveLength(1);
  });

  it('never resurrects a tombstone line as a fresh row', async () => {
    await enqueue('delta', makeEntry({ id: 'tombstoned', deleted_at: '2026-09-17T11:00:00.000Z' }));

    const { indexPendingOutboxEntries } = await import('../../src/daemon/outbox-index.js');
    expect(await indexPendingOutboxEntries(['delta'], writeLine)).toBe(0);
    expect(await memoryRows('delta')).toHaveLength(0);
  });

  it('skips a malformed line and keeps going', async () => {
    const { getCortexDb } = await import('../../src/db/engrams.js');
    getCortexDb('eps')
      .prepare('INSERT INTO l1_outbox (entry_id, line, created_at) VALUES (?, ?, ?)')
      .run('broken', '{not json', '2026-09-17T10:00:00.000Z');
    await enqueue('eps', makeEntry({ id: 'e-good', content: 'this one is fine' }));

    const { indexPendingOutboxEntries } = await import('../../src/daemon/outbox-index.js');
    expect(await indexPendingOutboxEntries(['eps'], writeLine)).toBe(1);
    expect((await memoryRows('eps')).map(r => r.id)).toEqual(['e-good']);
    expect(logLines.join('\n')).toContain('unparseable');
  });

  it('leaves the outbox rows alone — the drain still owns them', async () => {
    await enqueue('zeta', makeEntry({ id: 'e-1' }));

    const { indexPendingOutboxEntries } = await import('../../src/daemon/outbox-index.js');
    await indexPendingOutboxEntries(['zeta'], writeLine);

    const { getCortexDb } = await import('../../src/db/engrams.js');
    const row = getCortexDb('zeta')
      .prepare('SELECT COUNT(*) as count FROM l1_outbox')
      .get() as { count: number };
    expect(row.count).toBe(1);
  });

  it('a cortex with an empty outbox is a cheap no-op', async () => {
    const { getCortexDb } = await import('../../src/db/engrams.js');
    getCortexDb('eta'); // create the DB, leave the outbox empty

    const { indexPendingOutboxEntries } = await import('../../src/daemon/outbox-index.js');
    expect(await indexPendingOutboxEntries(['eta'], writeLine)).toBe(0);
    expect(logLines).toEqual([]);
  });
});
