import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { cortexCommand } from '../../src/commands/cortex.js';
import { createTestCortex, type TestCortex } from '../fixtures/cortex.js';
import { saveConfig, getConfig, getPeerId } from '../../src/lib/config.js';
import { insertMemory, searchMemories } from '../../src/db/memory-queries.js';
import { deterministicId, deterministicEventId } from '../../src/lib/deterministic-id.js';
import { HttpSyncAdapter } from '../../src/sync/http-adapter.js';
import { getSyncAdapter } from '../../src/sync/registry.js';

// The two RemoteMemory / RemoteLongTermEvent shapes the http adapter consumes
// (mirrored from packages/cli/src/sync/http-adapter.ts). Kept inline here
// rather than exported from the adapter — the adapter's wire types are an
// internal detail of HTTP transport, not a public surface, so the test
// fixture restates them locally.
interface FixtureMemory {
  id: string;
  ts: string;
  author: string;
  content: string;
  source_ids: string[];
  episode_key: string | null;
  decisions: string[] | null;
}

interface FixtureLongTermEvent {
  id: string;
  ts: string;
  author: string;
  kind: string;
  title: string;
  content: string;
  topics: string[];
  supersedes: string | null;
  source_memory_ids: string[];
  deleted_at: string | null;
}

interface FixtureServerHandle {
  url: string;
  close: () => Promise<void>;
}

// Minimal node:http fixture matching the two endpoints HttpSyncAdapter.pull
// touches: GET /v1/cortexes/<name>/memories and /long-term-events. Ignores
// `since`/`limit` and always echoes the full seeded set — idempotency is
// enforced by the adapter's INSERT OR IGNORE on dedup, not by the server.
function startFixtureHttpServer(opts: {
  token: string;
  memories: FixtureMemory[];
  longTermEvents: FixtureLongTermEvent[];
}): Promise<FixtureServerHandle> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const auth = req.headers['authorization'];
      if (auth !== `Bearer ${opts.token}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      const reqUrl = new URL(req.url ?? '/', 'http://localhost');
      const memMatch = reqUrl.pathname.match(/^\/v1\/cortexes\/[^/]+\/memories$/);
      const ltMatch = reqUrl.pathname.match(/^\/v1\/cortexes\/[^/]+\/long-term-events$/);
      if (req.method === 'GET' && memMatch) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          memories: opts.memories,
          // next_since past the served set so the adapter's loop exits and
          // the cursor advances; on the next pull the same set comes back
          // (fixture ignores `since`) and dedup carries the idempotency.
          next_since: String(opts.memories.length),
        }));
        return;
      }
      if (req.method === 'GET' && ltMatch) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          events: opts.longTermEvents,
          next_since: String(opts.longTermEvents.length),
        }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('failed to bind fixture server'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((res, rej) => {
          server.close(err => err ? rej(err) : res());
        }),
      });
    });
  });
}

describe('think cortex migrate --to fs --path', () => {
  let cortex: TestCortex | null = null;
  let fsRoot: string | null = null;
  let fixture: FixtureServerHandle | null = null;

  afterEach(async () => {
    cortex?.cleanup();
    cortex = null;
    if (fsRoot) {
      rmSync(fsRoot, { recursive: true, force: true });
      fsRoot = null;
    }
    if (fixture) {
      await fixture.close();
      fixture = null;
    }
    vi.restoreAllMocks();
  });

  it('exports SQLite memories to <path>/<cortex>/<peer>-0001.jsonl and rewrites config to fs', async () => {
    cortex = createTestCortex();
    fsRoot = mkdtempSync(path.join(tmpdir(), 'think-fs-migrate-target-'));
    // Use a fresh subdir as the target — the migrate command refuses to
    // export into a folder that already has subdirectories.
    const target = path.join(fsRoot, 'cortex-root');

    // Configure a `repo` source so the migrate command sees a backend to
    // migrate from. We point at a bogus file:// URL — the pull-from-source
    // step will fail-soft and the migrate continues with the SQLite data
    // we've already inserted.
    const baseConfig = getConfig();
    saveConfig({
      ...baseConfig,
      cortex: {
        author: 'test',
        active: cortex.name,
        repo: '/nonexistent/source.git',
      },
    });

    insertMemory(cortex.name, {
      id: deterministicId('2026-04-29T12:00:00Z', 'a', 'pre-migration'),
      ts: '2026-04-29T12:00:00Z',
      author: 'a',
      content: 'pre-migration',
    });

    // Suppress process.exit so commander errors fail the test rather than
    // killing the worker.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    // Quiet the noisy yellow "pull failed" line so test output stays clean.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // The fake repo URL will make source pull fail. By default migrate
    // aborts in that case; --allow-stale-source opts into proceeding with
    // whatever local SQLite already has (which is what we want here).
    await cortexCommand.parseAsync(
      ['migrate', '--to', 'fs', '--path', target, '--allow-stale-source'],
      { from: 'user' },
    );

    expect(exitSpy).not.toHaveBeenCalled();

    // Config now points at the fs backend; repo cleared symmetrically.
    const after = getConfig();
    expect(after.cortex?.fs?.path).toBe(target);
    expect(after.cortex?.repo).toBeUndefined();
    expect(after.cortex?.server).toBeUndefined();

    // Memory landed in the expected per-peer bucket file.
    const peerId = getPeerId();
    const bucketPath = path.join(target, cortex.name, `${peerId}-0001.jsonl`);
    expect(fs.existsSync(bucketPath)).toBe(true);
    const lines = readFileSync(bucketPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as { content: string; origin_peer_id: string };
    expect(parsed.content).toBe('pre-migration');
    expect(parsed.origin_peer_id).toBe(peerId);
  });

  it('aborts on source-pull failure unless --allow-stale-source is passed', async () => {
    cortex = createTestCortex();
    fsRoot = mkdtempSync(path.join(tmpdir(), 'think-fs-migrate-stale-'));

    const baseConfig = getConfig();
    saveConfig({
      ...baseConfig,
      cortex: {
        author: 'test',
        active: cortex.name,
        repo: '/nonexistent/source.git',
      },
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      cortexCommand.parseAsync(
        ['migrate', '--to', 'fs', '--path', path.join(fsRoot, 'target')],
        { from: 'user' },
      ),
    ).rejects.toThrow(/process\.exit\(1\)/);

    expect(exitSpy).toHaveBeenCalledWith(1);
    // Config still points at the original backend — abort before rewrite.
    const after = getConfig();
    expect(after.cortex?.repo).toBe('/nonexistent/source.git');
    expect(after.cortex?.fs).toBeUndefined();
  });

  it('migrates http→fs end-to-end (config rewrite, parity, dedup, post-migrate sync/recall)', async () => {
    cortex = createTestCortex();
    fsRoot = mkdtempSync(path.join(tmpdir(), 'think-fs-migrate-http-'));
    const target = path.join(fsRoot, 'cortex-root');

    // Distinctive single token in one memory's content so the post-migration
    // FTS recall query matches deterministically.
    const FTS_TOKEN = 'uniquepullableword';
    const fixtureMemories: FixtureMemory[] = [
      {
        id: deterministicId('2026-04-29T12:00:00Z', 'remote', `remote memory one ${FTS_TOKEN}`),
        ts: '2026-04-29T12:00:00Z',
        author: 'remote',
        content: `remote memory one ${FTS_TOKEN}`,
        source_ids: [],
        episode_key: null,
        decisions: null,
      },
      {
        id: deterministicId('2026-04-29T12:01:00Z', 'remote', 'remote memory two'),
        ts: '2026-04-29T12:01:00Z',
        author: 'remote',
        content: 'remote memory two',
        source_ids: [],
        episode_key: null,
        decisions: null,
      },
    ];
    const fixtureEvents: FixtureLongTermEvent[] = [
      {
        id: deterministicEventId('2026-04-29T13:00:00Z', 'remote', 'remote milestone', 'first remote milestone body'),
        ts: '2026-04-29T13:00:00Z',
        author: 'remote',
        kind: 'milestone',
        title: 'remote milestone',
        content: 'first remote milestone body',
        topics: ['remote'],
        supersedes: null,
        source_memory_ids: [],
        deleted_at: null,
      },
    ];

    const TOKEN = 'test-token';
    fixture = await startFixtureHttpServer({
      token: TOKEN,
      memories: fixtureMemories,
      longTermEvents: fixtureEvents,
    });

    const baseConfig = getConfig();
    saveConfig({
      ...baseConfig,
      cortex: {
        author: 'test',
        active: cortex.name,
        server: { url: fixture.url, token: TOKEN },
      },
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Real fixture answers — no --allow-stale-source needed; the http→SQLite
    // pull actually runs end-to-end inside the migrate command.
    await cortexCommand.parseAsync(
      ['migrate', '--to', 'fs', '--path', target],
      { from: 'user' },
    );
    expect(exitSpy).not.toHaveBeenCalled();

    // (1) Config rewrite: server cleared, fs.path set.
    const after = getConfig();
    expect(after.cortex?.fs?.path).toBe(target);
    expect(after.cortex?.server).toBeUndefined();
    expect(after.cortex?.repo).toBeUndefined();

    // (2) Memory parity: every fixture memory is in the per-peer bucket file
    // exactly once (first migrate run yields one-of-each — the spike's stand-in
    // for the literal "no duplicates if migrate is re-run" wording, since the
    // command refuses to re-target a non-empty folder by design).
    const peerId = getPeerId();
    const memBucket = path.join(target, cortex.name, `${peerId}-0001.jsonl`);
    expect(fs.existsSync(memBucket)).toBe(true);
    const memLines = readFileSync(memBucket, 'utf-8').trim().split('\n');
    const memRows = memLines.map(l => JSON.parse(l) as {
      ts: string;
      author: string;
      content: string;
      origin_peer_id?: string;
    });
    expect(memRows.map(r => r.content).sort()).toEqual(fixtureMemories.map(m => m.content).sort());
    // Http-pulled rows land in SQLite with origin_peer_id=null (the puller is
    // not the originator); the fs push omits the field rather than fabricating
    // it. Locking that in here so a regression doesn't silently mis-attribute.
    for (const row of memRows) {
      expect(row.origin_peer_id).toBeUndefined();
    }

    // Long-term event parity.
    const ltFile = path.join(target, cortex.name, `${peerId}-long-term.jsonl`);
    expect(fs.existsSync(ltFile)).toBe(true);
    const ltLines = readFileSync(ltFile, 'utf-8').trim().split('\n');
    const ltRows = ltLines.map(l => JSON.parse(l) as { title: string; kind: string });
    expect(ltRows.map(r => r.title).sort()).toEqual(fixtureEvents.map(e => e.title).sort());

    // (3) Dedup: re-pulling from the http source produces zero new SQLite rows
    // for both memories and long-term events. Restore the http config briefly
    // so HttpSyncAdapter can authenticate, then revert to fs-only for the
    // remaining post-migration assertions.
    const withServer = getConfig();
    saveConfig({
      ...withServer,
      cortex: {
        ...withServer.cortex!,
        server: { url: fixture.url, token: TOKEN },
      },
    });
    const httpAdapter = new HttpSyncAdapter();
    const repull = await httpAdapter.pull(cortex.name);
    expect(repull.errors).toEqual([]);
    expect(repull.pulled).toBe(0);
    const cleared = getConfig();
    delete cleared.cortex!.server;
    saveConfig(cleared);

    // (4) Post-migration `think sync` writes to the fs cortex. After migrate
    // the per-peer bucket holds 2 lines (one per fixture memory); a fresh
    // local insert + sync should append a third, attributed to this peer.
    insertMemory(cortex.name, {
      id: deterministicId('2026-04-29T14:00:00Z', 'local', 'post-migrate write'),
      ts: '2026-04-29T14:00:00Z',
      author: 'local',
      content: 'post-migrate write',
    });
    const postAdapter = getSyncAdapter();
    expect(postAdapter?.name).toBe('local-fs');
    const syncResult = await postAdapter!.sync(cortex.name);
    expect(syncResult.errors).toEqual([]);
    expect(syncResult.pushed).toBe(1);
    const memLinesAfter = readFileSync(memBucket, 'utf-8').trim().split('\n');
    expect(memLinesAfter).toHaveLength(3);
    const lastRow = JSON.parse(memLinesAfter[2]) as { content: string; origin_peer_id?: string };
    expect(lastRow.content).toBe('post-migrate write');
    expect(lastRow.origin_peer_id).toBe(peerId);

    // (5) Post-migration recall returns the http-pulled memory via FTS.
    const hits = searchMemories(cortex.name, FTS_TOKEN);
    expect(hits.map(r => r.content)).toContain(`remote memory one ${FTS_TOKEN}`);
  });

  it('refuses to migrate into a folder that already has subdirectories', async () => {
    cortex = createTestCortex();
    fsRoot = mkdtempSync(path.join(tmpdir(), 'think-fs-migrate-busy-'));
    fs.mkdirSync(path.join(fsRoot, 'preexisting-cortex'));

    const baseConfig = getConfig();
    saveConfig({
      ...baseConfig,
      cortex: {
        author: 'test',
        active: cortex.name,
        repo: '/nonexistent/source.git',
      },
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      cortexCommand.parseAsync(
        ['migrate', '--to', 'fs', '--path', fsRoot],
        { from: 'user' },
      ),
    ).rejects.toThrow(/process\.exit\(1\)/);

    expect(exitSpy).toHaveBeenCalledWith(1);
    // Config still points at the original backend.
    const after = getConfig();
    expect(after.cortex?.repo).toBe('/nonexistent/source.git');
    expect(after.cortex?.fs).toBeUndefined();
  });
});
