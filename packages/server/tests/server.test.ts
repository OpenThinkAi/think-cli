import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, type TestDb } from './fixtures/db.js';
import { request } from './fixtures/app-client.js';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.cleanup();
});

describe('open-think-server', () => {
  describe('auth', () => {
    it('rejects requests with no Authorization header', async () => {
      const r = await request({ path: '/v1/cortexes', token: null });
      expect(r.status).toBe(401);
    });

    it('rejects requests with the wrong token', async () => {
      const r = await request({ path: '/v1/cortexes', token: 'nope' });
      expect(r.status).toBe(401);
    });

    it('accepts requests with the correct token', async () => {
      const r = await request<{ cortexes: string[] }>({ path: '/v1/cortexes' });
      expect(r.status).toBe(200);
      expect(r.body.cortexes).toBeDefined();
    });

    it('health endpoint is unauthenticated', async () => {
      const r = await request<{ status: string }>({ path: '/v1/health', token: null });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('ok');
    });
  });

  describe('cortex', () => {
    it('creates and lists cortexes', async () => {
      const created = await request<{ name: string }>({
        method: 'POST',
        path: '/v1/cortexes',
        body: { name: 'engineering' },
      });
      expect(created.status).toBe(201);
      expect(created.body.name).toBe('engineering');

      const listed = await request<{ cortexes: string[] }>({ path: '/v1/cortexes' });
      expect(listed.body.cortexes).toContain('engineering');
    });

    it('rejects invalid cortex names', async () => {
      const r = await request({
        method: 'POST',
        path: '/v1/cortexes',
        body: { name: '../../etc/passwd' },
      });
      expect(r.status).toBe(400);
    });

    it('cortex creation is idempotent: 201 on create, 200 on no-op', async () => {
      const first = await request({ method: 'POST', path: '/v1/cortexes', body: { name: 'idem' } });
      expect(first.status).toBe(201);
      const second = await request({ method: 'POST', path: '/v1/cortexes', body: { name: 'idem' } });
      expect(second.status).toBe(200);
    });
  });

  describe('memories', () => {
    it('upserts memories and dedupes by id (memories are immutable)', async () => {
      const cortexName = 'mem-test-' + Math.random().toString(36).slice(2, 8);
      const memory = {
        id: 'mem-1',
        ts: '2026-04-29T12:00:00Z',
        author: 'test',
        content: 'hello world',
        source_ids: [],
      };

      const first = await request<{ accepted: number; inserted: number }>({
        method: 'POST',
        path: `/v1/cortexes/${cortexName}/memories`,
        body: { memories: [memory] },
      });
      expect(first.status).toBe(200);
      expect(first.body.inserted).toBe(1);

      // Re-sending the same memory should be a no-op.
      const second = await request<{ accepted: number; inserted: number }>({
        method: 'POST',
        path: `/v1/cortexes/${cortexName}/memories`,
        body: { memories: [memory] },
      });
      expect(second.body.inserted).toBe(0);
      expect(second.body.accepted).toBe(1);
    });

    it('paginates pull by server_seq', async () => {
      const cortexName = 'page-' + Math.random().toString(36).slice(2, 8);
      const memories = Array.from({ length: 5 }, (_, i) => ({
        id: `mem-${i}`,
        ts: `2026-04-29T12:0${i}:00Z`,
        author: 'a',
        content: `m${i}`,
        source_ids: [],
      }));

      await request({
        method: 'POST',
        path: `/v1/cortexes/${cortexName}/memories`,
        body: { memories },
      });

      const firstPage = await request<{
        memories: { id: string; server_seq: string }[];
        next_since: string;
      }>({ path: `/v1/cortexes/${cortexName}/memories?since=0&limit=3` });

      expect(firstPage.status).toBe(200);
      expect(firstPage.body.memories).toHaveLength(3);
      expect(firstPage.body.memories.map(m => m.id)).toEqual(['mem-0', 'mem-1', 'mem-2']);

      const secondPage = await request<{
        memories: { id: string }[];
        next_since: string;
      }>({ path: `/v1/cortexes/${cortexName}/memories?since=${firstPage.body.next_since}&limit=10` });

      expect(secondPage.body.memories.map(m => m.id)).toEqual(['mem-3', 'mem-4']);
    });

    it('rejects payloads larger than the cap', async () => {
      const cortexName = 'cap-' + Math.random().toString(36).slice(2, 8);
      const memories = Array.from({ length: 501 }, (_, i) => ({
        id: `mem-${i}`,
        ts: '2026-04-29T12:00:00Z',
        author: 'a',
        content: 'x',
        source_ids: [],
      }));
      const r = await request({
        method: 'POST',
        path: `/v1/cortexes/${cortexName}/memories`,
        body: { memories },
      });
      expect(r.status).toBe(400);
    });

    it('rejects invalid since values', async () => {
      const r = await request({ path: '/v1/cortexes/anything/memories?since=-1' });
      expect(r.status).toBe(400);
    });

    it('does not expose any engram endpoint', async () => {
      const r = await request({ path: '/v1/cortexes/anything/engrams' });
      expect(r.status).toBe(404);
    });
  });
});
