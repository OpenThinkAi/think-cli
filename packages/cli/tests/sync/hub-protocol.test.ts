import { describe, it, expect } from 'vitest';
import {
  AUTH_HEADER,
  bearerHeader,
  makeBearerAuthHeader,
  cortexNameSchema,
  wireMemoryLineSchema,
  storedLineSchema,
  pushRequestSchema,
  pushResponseSchema,
  pullRequestSchema,
  pullResponseSchema,
  PULL_DEFAULT_LIMIT,
  PULL_MAX_LIMIT,
} from '../../src/sync/hub-protocol.js';

describe('hub-protocol contract', () => {
  describe('bearer auth', () => {
    it('builds an Authorization: Bearer header', () => {
      expect(AUTH_HEADER).toBe('Authorization');
      expect(bearerHeader('tok_123')).toBe('Bearer tok_123');
    });

    it('builds the typed header pair from a token', () => {
      expect(makeBearerAuthHeader('tok_123')).toEqual({
        name: 'Authorization',
        value: 'Bearer tok_123',
      });
    });

    it('rejects a token with CR or LF (header injection)', () => {
      expect(() => bearerHeader('tok\r\nX-Injected: yes')).toThrow();
      expect(() => makeBearerAuthHeader('tok\r\nX-Injected: yes')).toThrow();
      expect(() => bearerHeader('tok\nfoo')).toThrow();
    });
  });

  describe('cortex name', () => {
    it('accepts alphanumerics, hyphens, underscores, and namespaced slashes', () => {
      for (const name of ['team-shared', 'cortex/engineering', 'a_b-1']) {
        expect(cortexNameSchema.safeParse(name).success).toBe(true);
      }
    });

    it('rejects traversal, illegal chars, and leading/trailing slashes', () => {
      for (const name of ['', '../etc', 'a//b', 'a\\b', '/lead', 'trail/', 'has space', 'has?q']) {
        expect(cortexNameSchema.safeParse(name).success).toBe(false);
      }
    });
  });

  describe('wire memory line', () => {
    const minimal = {
      ts: '2026-06-18T12:00:00Z',
      author: 'matt',
      content: 'Decided to ship the hub adapter as OSS.',
      source_ids: ['eng_a', 'eng_b'],
      kind: 'memory' as const,
    };

    it('round-trips a minimal line', () => {
      const parsed = wireMemoryLineSchema.parse(minimal);
      expect(parsed).toEqual(minimal);
    });

    it('round-trips a line with all optional fields', () => {
      const full = {
        ...minimal,
        episode_key: 'think-cloud-psr4',
        decisions: ['hub adapter stays MIT'],
        origin_peer_id: 'peer-1',
      };
      expect(wireMemoryLineSchema.parse(full)).toEqual(full);
    });

    it('rejects a non-memory kind (engrams/events do not ride this path)', () => {
      expect(wireMemoryLineSchema.safeParse({ ...minimal, kind: 'event' }).success).toBe(false);
    });

    it('rejects a tombstone field (memories are immutable via sync)', () => {
      // deleted_at is not in the schema; zod objects default to strip mode —
      // unknown keys are silently dropped — so the parse succeeds but the field
      // is removed, proving the wire shape carries no tombstone. Confirm it is
      // not present on the parsed line.
      const parsed = wireMemoryLineSchema.parse({ ...minimal, deleted_at: '2026-06-18T13:00:00Z' });
      expect('deleted_at' in parsed).toBe(false);
    });
  });

  describe('stored line', () => {
    it('round-trips with id + server_seq', () => {
      const stored = {
        ts: '2026-06-18T11:00:00Z',
        author: 'matt',
        content: 'a memory',
        source_ids: [],
        kind: 'memory' as const,
        id: 'mem_abc',
        server_seq: 7,
      };
      expect(storedLineSchema.parse(stored)).toEqual(stored);
    });

    it('rejects a non-positive server_seq', () => {
      expect(
        storedLineSchema.safeParse({
          ts: 't', author: 'a', content: 'c', source_ids: [], kind: 'memory', id: 'x', server_seq: 0,
        }).success,
      ).toBe(false);
    });
  });

  describe('push request/response', () => {
    it('round-trips a push request', () => {
      const req = {
        cortex: 'team-shared',
        lines: [
          { ts: 't', author: 'a', content: 'c', source_ids: [], kind: 'memory' as const },
        ],
      };
      expect(pushRequestSchema.parse(req)).toEqual(req);
    });

    it('accepts an empty push (no-op)', () => {
      expect(pushRequestSchema.parse({ cortex: 'c', lines: [] })).toEqual({ cortex: 'c', lines: [] });
    });

    it('round-trips a push response with accepted + duplicate results', () => {
      const res = {
        results: [
          { id: 'mem_1', server_seq: 41, status: 'accepted' as const },
          { id: 'mem_2', server_seq: 12, status: 'duplicate' as const },
        ],
        accepted: 1,
        duplicates: 1,
        maxServerSeq: 41,
      };
      expect(pushResponseSchema.parse(res)).toEqual(res);
    });
  });

  describe('pull request', () => {
    it('applies cursor + limit defaults', () => {
      const parsed = pullRequestSchema.parse({ cortex: 'c' });
      expect(parsed.cursor).toBe(0);
      expect(parsed.limit).toBe(PULL_DEFAULT_LIMIT);
    });

    it('coerces string query params (route uses query strings)', () => {
      const parsed = pullRequestSchema.parse({ cortex: 'c', cursor: '7', limit: '50' });
      expect(parsed.cursor).toBe(7);
      expect(parsed.limit).toBe(50);
    });

    it('rejects a limit above the hard max instead of silently clamping', () => {
      expect(pullRequestSchema.safeParse({ cortex: 'c', limit: PULL_MAX_LIMIT + 1 }).success).toBe(false);
    });

    it('rejects a negative cursor', () => {
      expect(pullRequestSchema.safeParse({ cortex: 'c', cursor: -1 }).success).toBe(false);
    });
  });

  describe('pull response', () => {
    it('round-trips a page with hasMore + nextCursor', () => {
      const res = {
        lines: [
          {
            id: 'mem_1', server_seq: 7, ts: 't', author: 'a', content: 'c',
            source_ids: [], kind: 'memory' as const,
          },
        ],
        nextCursor: 7,
        hasMore: false,
      };
      expect(pullResponseSchema.parse(res)).toEqual(res);
    });

    it('round-trips an empty page (caught up)', () => {
      const res = { lines: [], nextCursor: 7, hasMore: false };
      expect(pullResponseSchema.parse(res)).toEqual(res);
    });
  });
});
