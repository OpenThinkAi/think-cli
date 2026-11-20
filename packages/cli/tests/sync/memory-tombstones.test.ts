/**
 * Memory tombstones — `think forget` (AGT-2331).
 *
 * Coverage:
 *   - line shape: ids only (never content), old-peer-safe redundant fields
 *   - parse: tombstone vs memory lines; parseMemoriesJsonl ignores tombstones
 *   - apply: row + FTS + compaction links + undrained outbox gone; ids recorded;
 *     idempotent; ingest paths refuse a forgotten id
 *   - daemon forget handler: hard delete + outbox tombstone line + derived list
 *   - fs adapter: forget on A propagates to B through the folder
 *   - hub: A forgets → hub deletes its stored line → B removes its copy;
 *     the line stream never carries tombstones (older clients unaffected);
 *     a forgotten line can't be re-pushed; seq stays monotonic;
 *     an older hub without the route degrades (push reports + keeps queued,
 *     pull skips silently)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { createApp } from '../../src/serve/app.js';
import { buildDefaultRegistry } from '../../src/serve/connectors/registry.js';
import { openDb, type Database } from '../../src/serve/db.js';
import { createVault } from '../../src/serve/vault/index.js';
import { HubSyncAdapter, type FetchLike } from '../../src/sync/hub-adapter.js';
import { LocalFsSyncAdapter } from '../../src/sync/local-fs-adapter.js';
import { saveConfig, getConfig, getPeerId } from '../../src/lib/config.js';
import { insertMemory, insertMemoryIfNotExists, getSyncCursor } from '../../src/db/memory-queries.js';
import { getCortexDb } from '../../src/db/engrams.js';
import { parseMemoriesJsonl } from '../../src/lib/curator.js';
import { deterministicId } from '../../src/lib/deterministic-id.js';
import {
  TOMBSTONE_PLACEHOLDER,
  applyMemoryTombstone,
  applyMemoryTombstoneNoTx,
  getLocalTombstonesSince,
  isForgotten,
  parseTombstone,
  parseTombstonesJsonl,
  serializeTombstoneLine,
  tombstoneIdsFor,
} from '../../src/lib/memory-tombstones.js';
import { handleForget } from '../../src/daemon/delete-handler.js';
import { pushDebouncer } from '../../src/daemon/push-debouncer.js';
import { appendCortexLine, maxCortexSeq } from '../../src/serve/cortex-lines-store.js';
import { createPeerPair, type PeerPair } from '../fixtures/peer-pair.js';

const TOKEN = 'tomb-test-token-' + randomBytes(6).toString('hex');
process.env.THINK_TOKEN = TOKEN;
const HUB_URL = 'https://hub.test.local';

let pair: PeerPair;

beforeEach(() => {
  pair = createPeerPair();
  pushDebouncer._gitOverride = async () => '';
});

afterEach(() => {
  pushDebouncer._gitOverride = undefined;
  pair.cleanup();
});

function rowCount(id: string): number {
  return (getCortexDb(pair.cortexName).prepare('SELECT COUNT(*) AS n FROM memories WHERE id = ?').get(id) as { n: number }).n;
}

function ftsHits(word: string): number {
  return (getCortexDb(pair.cortexName)
    .prepare('SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH ?')
    .get(word) as { n: number }).n;
}

describe('tombstone line shape', () => {
  it('carries ids only, plus fields older peers already treat as a soft delete', () => {
    const line = serializeTombstoneLine({
      ids: ['own-id', 'content-id'],
      ts: '2026-11-19T00:00:00.000Z',
      author: 'matt',
      origin_peer_id: 'peer-1',
    });
    const obj = JSON.parse(line) as Record<string, unknown>;
    expect(obj['kind']).toBe('tombstone');
    expect(obj['id']).toBe('own-id');
    expect(obj['ids']).toEqual(['own-id', 'content-id']);
    // Older daemons: `content` non-empty + `deleted_at` set + `id` → they
    // soft-delete the row. Older adapters/reindex skip `deleted_at` lines.
    expect(obj['content']).toBe(TOMBSTONE_PLACEHOLDER);
    expect(obj['deleted_at']).toBe('2026-11-19T00:00:00.000Z');
  });

  it('round-trips through parseTombstone and is invisible to parseMemoriesJsonl', () => {
    const line = serializeTombstoneLine({ ids: ['a', 'b'], ts: 't', author: 'x', origin_peer_id: null });
    const memLine = JSON.stringify({ id: 'm', ts: 't', author: 'x', content: 'hello', kind: 'memory' });
    const raw = `${memLine}\n${line}\n{not json\n`;
    expect(parseTombstonesJsonl(raw)).toEqual([{ ids: ['a', 'b'], ts: 't', author: 'x', origin_peer_id: null }]);
    expect(parseMemoriesJsonl(raw).map((m) => m.content)).toEqual(['hello']);
    expect(parseTombstone({ kind: 'memory', id: 'x' })).toBeNull();
    expect(parseTombstone({ kind: 'tombstone' })).toBeNull();
  });

  it('includes the content-derived id so adapter-pulled copies are matched', () => {
    const row = { id: 'uuid-1', ts: '2026-01-01T00:00:00Z', author: 'a', content: 'secret' };
    expect(tombstoneIdsFor(row)).toEqual(['uuid-1', deterministicId(row.ts, row.author, row.content)]);
  });
});

describe('applyMemoryTombstone', () => {
  it('removes the row, its FTS entry, compaction links and undrained outbox lines; records ids', () => {
    pair.peerA.activate();
    const row = insertMemory(pair.cortexName, { ts: '2026-01-01T00:00:00Z', author: 'a', content: 'zebrapassword' });
    const db = getCortexDb(pair.cortexName);
    db.prepare("INSERT INTO compaction_links (raw_id, compacted_id) VALUES (?, 'c1')").run(row.id);
    db.prepare("INSERT INTO l1_outbox (entry_id, line, created_at) VALUES (?, '{\"content\":\"zebrapassword\"}', 'now')").run(row.id);
    expect(ftsHits('zebrapassword')).toBe(1);

    const r = applyMemoryTombstone(db, { ids: [row.id], ts: 'now', author: 'a', origin_peer_id: null });
    expect(r.removed).toBe(1);
    expect(rowCount(row.id)).toBe(0);
    expect(ftsHits('zebrapassword')).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM compaction_links').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM l1_outbox').get() as { n: number }).n).toBe(0);
    expect(isForgotten(db, row.id)).toBe(true);

    // Idempotent.
    expect(applyMemoryTombstone(db, { ids: [row.id], ts: 'now', author: 'a', origin_peer_id: null }))
      .toEqual({ removed: 0, recorded: false });
  });

  it('makes every sync ingest path refuse the forgotten id', () => {
    pair.peerA.activate();
    const db = getCortexDb(pair.cortexName);
    applyMemoryTombstone(db, { ids: ['gone'], ts: 'now', author: 'a', origin_peer_id: null });
    const res = insertMemoryIfNotExists(pair.cortexName, {
      id: 'gone', ts: 't', author: 'a', content: 'resurrected?', source_ids: [],
    });
    expect(res.inserted).toBe(false);
    expect(rowCount('gone')).toBe(0);
  });

  it('getLocalTombstonesSince returns only forgets made here, grouped, never pulled ones', () => {
    pair.peerA.activate();
    const db = getCortexDb(pair.cortexName);
    const me = getPeerId();
    applyMemoryTombstoneNoTx(db, { ids: ['a1', 'a2'], ts: 't1', author: 'me', origin_peer_id: me }, { local: true });
    // A pulled tombstone that claims this peer's id must not be re-emitted.
    applyMemoryTombstone(db, { ids: ['f1'], ts: 't2', author: 'them', origin_peer_id: me });
    applyMemoryTombstoneNoTx(db, { ids: ['a3'], ts: 't3', author: 'me', origin_peer_id: me }, { local: true });
    const batch = getLocalTombstonesSince(db, 0);
    expect(batch.tombstones.map((t) => t.ids)).toEqual([['a1', 'a2'], ['a3']]);
    expect(batch.maxSeq).toBe(3);
    expect(getLocalTombstonesSince(db, batch.maxSeq).tombstones).toEqual([]);

    // limit caps the batch and maxSeq follows the last included forget.
    const first = getLocalTombstonesSince(db, 0, 1);
    expect(first.tombstones.map((t) => t.ids)).toEqual([['a1', 'a2']]);
    expect(first.maxSeq).toBe(1);
  });
});

describe('daemon forget handler', () => {
  it('hard-deletes the entry (even if soft-deleted) and enqueues an id-only tombstone line', () => {
    pair.peerA.activate();
    const row = insertMemory(pair.cortexName, {
      ts: '2026-01-01T00:00:00Z', author: 'a', content: 'customer ssn 123',
      deleted_at: '2026-01-02T00:00:00Z',
    });
    const db = getCortexDb(pair.cortexName);
    db.prepare("INSERT INTO compaction_links (raw_id, compacted_id) VALUES (?, ?)").run(row.id, 'nope');

    const res = handleForget({ cortex: pair.cortexName, id: row.id });
    expect(res.forgotten).toBe(true);
    expect(res.ids).toContain(row.id);
    expect(rowCount(row.id)).toBe(0);

    const lines = db.prepare('SELECT line FROM l1_outbox').all() as { line: string }[];
    expect(lines).toHaveLength(1);
    expect(lines[0].line).not.toContain('ssn');
    expect(parseTombstone(JSON.parse(lines[0].line))?.ids).toEqual(res.ids);

    const again = handleForget({ cortex: pair.cortexName, id: row.id });
    expect(again).toMatchObject({ forgotten: false, alreadyForgotten: true });
  });

  it('reports live compacted entries derived from the forgotten one', () => {
    pair.peerA.activate();
    const raw = insertMemory(pair.cortexName, { ts: 't1', author: 'a', content: 'raw fact' });
    const comp = insertMemory(pair.cortexName, { ts: 't2', author: 'a', content: 'summary of raw fact' });
    getCortexDb(pair.cortexName)
      .prepare('INSERT INTO compaction_links (raw_id, compacted_id) VALUES (?, ?)').run(raw.id, comp.id);
    const res = handleForget({ cortex: pair.cortexName, id: raw.id });
    expect(res.derived).toEqual([{ id: comp.id, content: 'summary of raw fact' }]);
    expect(rowCount(comp.id)).toBe(1);
  });

  it('returns forgotten: false for an unknown id', () => {
    pair.peerA.activate();
    expect(handleForget({ cortex: pair.cortexName, id: 'nope' })).toMatchObject({
      forgotten: false, alreadyForgotten: false,
    });
  });
});

describe('fs adapter propagation', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'think-tomb-fs-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function useFs(): LocalFsSyncAdapter {
    saveConfig({ ...getConfig(), cortex: { fs: { path: root }, author: 'test' } });
    return new LocalFsSyncAdapter();
  }

  it('a forget on A removes B\'s copy and the tombstone line has no content', async () => {
    pair.peerA.activate();
    const fsA = useFs();
    const row = insertMemory(pair.cortexName, { ts: '2026-01-01T00:00:00Z', author: 'a', content: 'leaked token xyz' });
    await fsA.push(pair.cortexName);

    pair.peerB.activate();
    const fsB = useFs();
    await fsB.pull(pair.cortexName);
    const contentId = deterministicId(row.ts, row.author, row.content);
    expect(rowCount(contentId)).toBe(1);

    pair.peerA.activate();
    useFs();
    handleForget({ cortex: pair.cortexName, id: row.id });
    const pushed = await fsA.push(pair.cortexName);
    expect(pushed.errors).toEqual([]);

    const dir = join(root, pair.cortexName);
    const files = readdirSync(dir);
    const tombLines = files
      .flatMap((f) => readFileSync(join(dir, f), 'utf-8').split('\n'))
      .filter((l) => l.includes('"tombstone"'));
    expect(tombLines).toHaveLength(1);
    expect(tombLines[0]).not.toContain('xyz');

    pair.peerB.activate();
    useFs();
    await fsB.pull(pair.cortexName);
    expect(rowCount(contentId)).toBe(0);
    expect(isForgotten(getCortexDb(pair.cortexName), contentId)).toBe(true);

    // A second push writes nothing new.
    pair.peerA.activate();
    useFs();
    expect((await fsA.push(pair.cortexName)).pushed).toBe(0);
  });
});

describe('hub propagation', () => {
  let serveDb: Database;
  let app: Hono;

  beforeEach(() => {
    serveDb = openDb(':memory:');
    app = createApp({ db: serveDb, vault: createVault(randomBytes(32)), registry: buildDefaultRegistry() });
  });

  function hubFetch(oldHub = false): FetchLike {
    return ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (oldHub && url.includes('/v1/cortex-sync/tombstones')) {
        return Promise.resolve(new Response('not found', { status: 404 }));
      }
      return app.fetch(new Request(url, init as RequestInit));
    }) as FetchLike;
  }

  function useHub(oldHub = false): HubSyncAdapter {
    saveConfig({ ...getConfig(), cortex: { hub: { url: HUB_URL, token: TOKEN }, author: 'test' } });
    return new HubSyncAdapter(hubFetch(oldHub));
  }

  function storedContents(): string[] {
    return (serveDb.prepare('SELECT content FROM cortex_lines WHERE cortex = ? ORDER BY server_seq')
      .all(pair.cortexName) as { content: string }[]).map((r) => r.content);
  }

  it('A forgets → hub drops its stored line → B removes its copy', async () => {
    pair.peerA.activate();
    const a = useHub();
    const row = insertMemory(pair.cortexName, { ts: '2026-01-01T00:00:00Z', author: 'a', content: 'private note' });
    insertMemory(pair.cortexName, { ts: '2026-01-01T00:00:01Z', author: 'a', content: 'keep me' });
    await a.push(pair.cortexName);

    pair.peerB.activate();
    const b = useHub();
    await b.pull(pair.cortexName);
    const contentId = deterministicId(row.ts, row.author, row.content);
    expect(rowCount(contentId)).toBe(1);

    pair.peerA.activate();
    useHub();
    handleForget({ cortex: pair.cortexName, id: row.id });
    const res = await a.push(pair.cortexName);
    expect(res.errors).toEqual([]);
    expect(storedContents()).toEqual(['keep me']);

    // The ordinary line stream (what older clients read) carries no tombstone.
    const pull = await app.fetch(new Request(
      `${HUB_URL}/v1/cortex-sync/pull?cortex=${pair.cortexName}`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    ));
    const body = await pull.json() as { lines: { content: string; kind: string }[] };
    expect(body.lines.map((l) => l.kind)).toEqual(['memory']);

    pair.peerB.activate();
    useHub();
    const pulled = await b.pull(pair.cortexName);
    expect(pulled.errors).toEqual([]);
    expect(rowCount(contentId)).toBe(0);
    expect(getSyncCursor(pair.cortexName, 'hub', 'pull_tombstones')).not.toBeNull();
  });

  it('refuses to store a forgotten line again and never reuses a seq', async () => {
    const line = { ts: 't', author: 'a', content: 'x', source_ids: [], kind: 'memory' as const };
    const { id } = appendCortexLine(serveDb, 'c', line);
    const res = await app.fetch(new Request(`${HUB_URL}/v1/cortex-sync/tombstones`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cortex: 'c', tombstones: [{ ids: [id], ts: 'now' }] }),
    }));
    expect(await res.json()).toEqual({ accepted: 1, duplicates: 0, removedLines: 1 });
    expect(maxCortexSeq(serveDb, 'c')).toBe(2);
    expect(appendCortexLine(serveDb, 'c', line).inserted).toBe(false);
    expect(appendCortexLine(serveDb, 'c', { ...line, content: 'y' }).server_seq).toBe(3);
  });

  it('drains a tombstone backlog larger than the per-request cap in chunks', async () => {
    pair.peerA.activate();
    const a = useHub();
    const db = getCortexDb(pair.cortexName);
    for (let i = 0; i < 1001; i++) {
      applyMemoryTombstoneNoTx(db, { ids: [`id-${i}`], ts: 't', author: 'a', origin_peer_id: null }, { local: true });
    }
    const res = await a.push(pair.cortexName);
    expect(res.errors).toEqual([]);
    expect(res.pushed).toBe(1001);
    expect((serveDb.prepare('SELECT COUNT(*) AS n FROM cortex_tombstones').get() as { n: number }).n).toBe(1001);
  });

  it('an older hub without the route: push reports it and keeps the tombstone queued; pull is silent', async () => {
    pair.peerA.activate();
    const a = useHub(true);
    const row = insertMemory(pair.cortexName, { ts: 't', author: 'a', content: 'secret' });
    handleForget({ cortex: pair.cortexName, id: row.id });

    const pushed = await a.push(pair.cortexName);
    expect(pushed.errors).toHaveLength(1);
    expect(pushed.errors[0]).toMatch(/does not support memory tombstones/);
    expect(getSyncCursor(pair.cortexName, 'hub', 'push_tombstones')).toBeNull();

    const pulled = await a.pull(pair.cortexName);
    expect(pulled.errors).toEqual([]);

    // Once the hub supports it, the queued tombstone goes out.
    const upgraded = useHub(false);
    const later = await upgraded.push(pair.cortexName);
    expect(later.errors).toEqual([]);
    expect(getSyncCursor(pair.cortexName, 'hub', 'push_tombstones')).not.toBeNull();
  });
});

describe('daemon pull-loop', () => {
  it('applies a tombstone line from L1 and refuses the original line afterwards', async () => {
    const { PullLoop } = await import('../../src/daemon/pull-loop.js');
    pair.peerB.activate();
    const row = insertMemory(pair.cortexName, { id: 'orig-1', ts: 't', author: 'a', content: 'secret', origin_peer_id: 'peer-a' });
    const original = JSON.stringify({ id: row.id, ts: 't', author: 'a', content: 'secret', kind: 'memory' });
    const tomb = serializeTombstoneLine({ ids: [row.id], ts: 'now', author: 'a', origin_peer_id: 'peer-a' });
    const files: Record<string, string> = { 'c1:p.jsonl': `${original}\n${tomb}`, 'c2:p.jsonl': original };

    const git = async (args: string[]): Promise<string> => {
      if (args[0] === 'fetch') return '';
      if (args[0] === 'rev-parse') return 'head2';
      if (args[0] === 'rev-list') return 'c1\nc2';
      if (args[0] === 'diff-tree') return 'p.jsonl';
      if (args[0] === 'show') return files[args[1]] ?? '';
      return '';
    };
    const loop = new PullLoop(pair.cortexName, () => {});
    (loop as unknown as { _gitOverride: typeof git })._gitOverride = git;
    await (loop as unknown as { fetchAndIngest(): Promise<void> }).fetchAndIngest();

    expect(rowCount(row.id)).toBe(0);
    expect(isForgotten(getCortexDb(pair.cortexName), row.id)).toBe(true);
  });
});
