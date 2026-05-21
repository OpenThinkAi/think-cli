import { describe, it, expect } from 'vitest';
import {
  createLinearConnector,
  LinearRateLimitError,
  type FetchFn,
  type LinearCursor,
} from '../../../src/serve/connectors/linear.js';

/**
 * Unit tests for the Linear connector (AGT-392). The connector talks to
 * Linear's GraphQL endpoint via an injected `fetchImpl`. Each test plants
 * a stub that returns a canned GraphQL response and asserts on the
 * emitted EventInputs.
 *
 * The terminal pathways exercised here:
 *   1. issue completed   → id `:completed:<iso>`, payload final_state='completed'
 *   2. issue canceled    → id `:canceled:<iso>`,  payload final_state='canceled'
 *
 * Plus: non-terminal issues skipped, reopen-then-close cycle produces a
 * distinct id under a shared episode_key, rate-limit handling, cursor
 * advancement, missing-credential, malformed pattern, GraphQL errors,
 * pagination, and verifyCredential's ok/not-ok branches.
 */

const ENDPOINT = 'https://api.linear.app/graphql';
const SUB = { id: 'sub-lin-1', kind: 'linear', pattern: 'ENG' };
const TOKEN = 'lin_api_test_xxx';

interface GraphQLBodyShape {
  query: string;
  variables?: Record<string, unknown>;
}

function readBody(init: RequestInit | undefined): GraphQLBodyShape {
  const raw = (init?.body ?? '') as string;
  return JSON.parse(raw) as GraphQLBodyShape;
}

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
  const headers = new Headers(init?.headers ?? {});
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers,
  });
}

function makeIssue(overrides: Record<string, unknown>) {
  // Base shape that satisfies the GraphQL selection set the connector
  // sends. Each test overrides whatever fields are relevant.
  return {
    id: 'iss_id_1',
    number: 123,
    identifier: 'ENG-123',
    title: 'Default title',
    description: null,
    url: 'https://linear.app/eng/issue/ENG-123',
    priority: null,
    priorityLabel: null,
    createdAt: '2026-05-19T10:00:00.000Z',
    updatedAt: '2026-05-19T12:00:00.000Z',
    completedAt: null,
    canceledAt: null,
    startedAt: null,
    archivedAt: null,
    state: { name: 'Done', type: 'completed' },
    team: { key: 'ENG', name: 'Engineering' },
    assignee: null,
    creator: null,
    labels: { nodes: [] },
    comments: { nodes: [] },
    ...overrides,
  };
}

function issuesPage(nodes: Array<ReturnType<typeof makeIssue>>, hasNextPage = false, endCursor: string | null = null) {
  return {
    data: {
      issues: {
        pageInfo: { hasNextPage, endCursor },
        nodes,
      },
    },
  };
}

describe('createLinearConnector — terminal-event emission', () => {
  it('emits one event for an issue moved to a completed state', async () => {
    const completedAt = '2026-05-19T12:00:00.000Z';
    const calls: GraphQLBodyShape[] = [];
    const fetchImpl: FetchFn = async (url, init) => {
      expect(url).toBe(ENDPOINT);
      calls.push(readBody(init));
      return jsonResponse(
        issuesPage([
          makeIssue({
            identifier: 'ENG-42',
            number: 42,
            title: 'Fix the broken thing',
            description: 'It was broken because reasons.',
            updatedAt: completedAt,
            completedAt,
            state: { name: 'Done', type: 'completed' },
            assignee: { name: 'Alice Smith', displayName: 'alice' },
            labels: { nodes: [{ name: 'bug' }, { name: 'p1' }] },
            comments: {
              nodes: [
                {
                  id: 'c1',
                  body: 'Root cause: off-by-one in the digest.',
                  createdAt: '2026-05-19T11:50:00.000Z',
                  updatedAt: '2026-05-19T11:50:00.000Z',
                  user: { name: 'Bob Jones', displayName: 'bob' },
                },
              ],
            },
          }),
        ]),
      );
    };

    const connector = createLinearConnector({ fetchImpl });
    const result = await connector.poll({
      subscription: SUB,
      credential: TOKEN,
      cursor: null,
    });

    expect(result.events).toHaveLength(1);
    const evt = result.events[0];
    expect(evt.id).toBe(`linear:ENG-42:completed:${completedAt}`);
    expect(evt.episodeKey).toBe('linear:ENG-42');
    expect(evt.terminal).toBe(true);
    const payload = JSON.parse(evt.payload as string) as {
      kind: string;
      final_state: string;
      identifier: string;
      number: number;
      title: string;
      description: string;
      assignee: string;
      labels: string[];
      comments: Array<{ author: string; body: string }>;
      state_type: string;
      completed_at: string;
    };
    expect(payload.kind).toBe('issue.completed');
    expect(payload.final_state).toBe('completed');
    expect(payload.identifier).toBe('ENG-42');
    expect(payload.number).toBe(42);
    expect(payload.title).toBe('Fix the broken thing');
    expect(payload.description).toBe('It was broken because reasons.');
    expect(payload.assignee).toBe('alice');
    expect(payload.labels).toEqual(['bug', 'p1']);
    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0].author).toBe('bob');
    expect(payload.state_type).toBe('completed');
    expect(payload.completed_at).toBe(completedAt);

    // First poll's GraphQL variables: teamKey=ENG, since=null.
    expect(calls).toHaveLength(1);
    expect(calls[0].variables?.teamKey).toBe('ENG');
    expect(calls[0].variables?.since).toBeNull();

    // Cursor advanced to the issue's updatedAt.
    expect(result.nextCursor.issuesUpdatedSince).toBe(completedAt);
  });

  it('emits one event for an issue moved to a canceled state', async () => {
    const canceledAt = '2026-05-19T13:00:00.000Z';
    const fetchImpl: FetchFn = async () =>
      jsonResponse(
        issuesPage([
          makeIssue({
            identifier: 'ENG-9',
            number: 9,
            title: 'Wontfix',
            updatedAt: canceledAt,
            canceledAt,
            state: { name: 'Canceled', type: 'canceled' },
          }),
        ]),
      );

    const connector = createLinearConnector({ fetchImpl });
    const result = await connector.poll({ subscription: SUB, credential: TOKEN, cursor: null });

    expect(result.events).toHaveLength(1);
    const evt = result.events[0];
    expect(evt.id).toBe(`linear:ENG-9:canceled:${canceledAt}`);
    expect(evt.episodeKey).toBe('linear:ENG-9');
    const payload = JSON.parse(evt.payload as string) as { kind: string; final_state: string };
    expect(payload.kind).toBe('issue.canceled');
    expect(payload.final_state).toBe('canceled');
  });

  it('skips issues in non-terminal states but still advances the cursor', async () => {
    const fetchImpl: FetchFn = async () =>
      jsonResponse(
        issuesPage([
          makeIssue({
            identifier: 'ENG-1',
            updatedAt: '2026-05-20T08:00:00.000Z',
            completedAt: null,
            state: { name: 'In Progress', type: 'started' },
          }),
          makeIssue({
            identifier: 'ENG-2',
            updatedAt: '2026-05-20T09:00:00.000Z',
            completedAt: null,
            state: { name: 'Backlog', type: 'backlog' },
          }),
        ]),
      );
    const connector = createLinearConnector({ fetchImpl });
    const result = await connector.poll({ subscription: SUB, credential: TOKEN, cursor: null });
    expect(result.events).toHaveLength(0);
    // Cursor advances even on non-terminal rows — otherwise we'd
    // re-fetch the same backlog forever.
    expect(result.nextCursor.issuesUpdatedSince).toBe('2026-05-20T09:00:00.000Z');
  });

  it('skips a terminal-typed issue with no completedAt/canceledAt (defensive)', async () => {
    const fetchImpl: FetchFn = async () =>
      jsonResponse(
        issuesPage([
          makeIssue({
            identifier: 'ENG-100',
            updatedAt: '2026-05-20T08:00:00.000Z',
            completedAt: null,
            state: { name: 'Done', type: 'completed' },
          }),
        ]),
      );
    const connector = createLinearConnector({ fetchImpl });
    const result = await connector.poll({ subscription: SUB, credential: TOKEN, cursor: null });
    expect(result.events).toHaveLength(0);
  });
});

describe('createLinearConnector — reopen-then-close cycles (AC #3)', () => {
  it('produces a new terminal event for each closure cycle under a shared episode_key', async () => {
    // First poll: ENG-7 completed at T1.
    const t1 = '2026-05-19T12:00:00.000Z';
    let phase = 0;
    const fetchImpl: FetchFn = async () => {
      phase++;
      if (phase === 1) {
        return jsonResponse(
          issuesPage([
            makeIssue({
              identifier: 'ENG-7',
              number: 7,
              updatedAt: t1,
              completedAt: t1,
              state: { name: 'Done', type: 'completed' },
            }),
          ]),
        );
      }
      // Second poll: ENG-7 reopened and re-completed at T2 (cursor has
      // advanced past T1, so we see only the post-reopen state).
      const t2 = '2026-05-20T12:00:00.000Z';
      return jsonResponse(
        issuesPage([
          makeIssue({
            identifier: 'ENG-7',
            number: 7,
            updatedAt: t2,
            completedAt: t2, // Linear writes a fresh timestamp on re-completion.
            state: { name: 'Done', type: 'completed' },
          }),
        ]),
      );
    };

    const connector = createLinearConnector({ fetchImpl });
    const r1 = await connector.poll({ subscription: SUB, credential: TOKEN, cursor: null });
    expect(r1.events).toHaveLength(1);
    const firstId = r1.events[0].id;
    const sharedEpisodeKey = r1.events[0].episodeKey;
    expect(sharedEpisodeKey).toBe('linear:ENG-7');

    const r2 = await connector.poll({
      subscription: SUB,
      credential: TOKEN,
      cursor: r1.nextCursor,
    });
    expect(r2.events).toHaveLength(1);
    const secondId = r2.events[0].id;
    const secondEpisodeKey = r2.events[0].episodeKey;
    // Distinct event id, same episode key — AC #3.
    expect(secondId).not.toBe(firstId);
    expect(secondEpisodeKey).toBe(sharedEpisodeKey);
  });
});

describe('createLinearConnector — cursor + pagination', () => {
  it('passes the stored cursor as `since` in the next GraphQL variables', async () => {
    const calls: GraphQLBodyShape[] = [];
    const fetchImpl: FetchFn = async (_url, init) => {
      calls.push(readBody(init));
      return jsonResponse(issuesPage([]));
    };

    const connector = createLinearConnector({ fetchImpl });
    const cursor: LinearCursor = { issuesUpdatedSince: '2026-05-19T12:00:00.000Z' };
    const result = await connector.poll({
      subscription: SUB,
      credential: TOKEN,
      cursor,
    });

    expect(result.events).toHaveLength(0);
    expect(calls[0].variables?.since).toBe('2026-05-19T12:00:00.000Z');
    // Cursor sticks when there's nothing new to advance past.
    expect(result.nextCursor.issuesUpdatedSince).toBe('2026-05-19T12:00:00.000Z');
  });

  it('pages through `hasNextPage` results and emits across pages', async () => {
    let call = 0;
    const calls: GraphQLBodyShape[] = [];
    const fetchImpl: FetchFn = async (_url, init) => {
      call++;
      calls.push(readBody(init));
      if (call === 1) {
        return jsonResponse(
          issuesPage(
            [
              makeIssue({
                identifier: 'ENG-1',
                updatedAt: '2026-05-19T10:00:00.000Z',
                completedAt: '2026-05-19T10:00:00.000Z',
                state: { name: 'Done', type: 'completed' },
              }),
            ],
            true,
            'cursor-page-2',
          ),
        );
      }
      return jsonResponse(
        issuesPage([
          makeIssue({
            identifier: 'ENG-2',
            updatedAt: '2026-05-19T11:00:00.000Z',
            completedAt: '2026-05-19T11:00:00.000Z',
            state: { name: 'Done', type: 'completed' },
          }),
        ]),
      );
    };
    const connector = createLinearConnector({ fetchImpl });
    const r = await connector.poll({ subscription: SUB, credential: TOKEN, cursor: null });
    expect(r.events).toHaveLength(2);
    expect(call).toBe(2);
    // First call has no after-cursor; second call carries it.
    expect(calls[0].variables?.after).toBeNull();
    expect(calls[1].variables?.after).toBe('cursor-page-2');
    expect(r.nextCursor.issuesUpdatedSince).toBe('2026-05-19T11:00:00.000Z');
  });
});

describe('createLinearConnector — rate limiting', () => {
  it('throws LinearRateLimitError on 429 with Retry-After', async () => {
    const fetchImpl: FetchFn = async () =>
      new Response(JSON.stringify({ message: 'slow down' }), {
        status: 429,
        headers: { 'Retry-After': '30', 'content-type': 'application/json' },
      });
    const fixedNow = new Date('2026-05-21T12:00:00Z');
    const connector = createLinearConnector({ fetchImpl, now: () => fixedNow });
    await expect(
      connector.poll({ subscription: SUB, credential: TOKEN, cursor: null }),
    ).rejects.toBeInstanceOf(LinearRateLimitError);
    try {
      await connector.poll({ subscription: SUB, credential: TOKEN, cursor: null });
    } catch (err) {
      expect((err as LinearRateLimitError).resetAt).toEqual(
        new Date(fixedNow.getTime() + 30_000),
      );
    }
  });

  it('throws LinearRateLimitError on 403 + X-RateLimit-Requests-Remaining=0', async () => {
    // Linear's reset header is in milliseconds since epoch (their docs
    // are explicit about ms, not seconds).
    const resetMs = new Date('2026-05-21T13:00:00Z').getTime();
    const fetchImpl: FetchFn = async () =>
      new Response(JSON.stringify({ message: 'rate limited' }), {
        status: 403,
        headers: {
          'X-RateLimit-Requests-Remaining': '0',
          'X-RateLimit-Requests-Reset': String(resetMs),
          'content-type': 'application/json',
        },
      });
    const connector = createLinearConnector({ fetchImpl });
    await expect(
      connector.poll({ subscription: SUB, credential: TOKEN, cursor: null }),
    ).rejects.toBeInstanceOf(LinearRateLimitError);
  });

  it('non-rate-limit 4xx propagates as a plain Error (not LinearRateLimitError)', async () => {
    const fetchImpl: FetchFn = async () =>
      new Response('Server Error', { status: 500, statusText: 'Internal Server Error' });
    const connector = createLinearConnector({ fetchImpl });
    await expect(
      connector.poll({ subscription: SUB, credential: TOKEN, cursor: null }),
    ).rejects.toThrowError(/500/);
  });

  it('logs a warning when rate-limit remaining is low but does not throw', async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: unknown) => warnings.push(String(msg));
    try {
      const fetchImpl: FetchFn = async () =>
        new Response(JSON.stringify(issuesPage([])), {
          status: 200,
          headers: {
            'X-RateLimit-Requests-Remaining': '5',
            'content-type': 'application/json',
          },
        });
      const connector = createLinearConnector({ fetchImpl });
      const result = await connector.poll({
        subscription: SUB,
        credential: TOKEN,
        cursor: null,
      });
      expect(result.events).toHaveLength(0);
      expect(warnings.some((w) => w.includes('rate limit low'))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });

  it('surfaces GraphQL errors as a plain Error (200 with errors[] body)', async () => {
    const fetchImpl: FetchFn = async () =>
      jsonResponse({
        errors: [{ message: 'Entity not authorized', extensions: { code: 'FORBIDDEN' } }],
      });
    const connector = createLinearConnector({ fetchImpl });
    await expect(
      connector.poll({ subscription: SUB, credential: TOKEN, cursor: null }),
    ).rejects.toThrowError(/Entity not authorized/);
  });
});

describe('createLinearConnector — input guards', () => {
  it('throws when credential is null', async () => {
    const fetchImpl: FetchFn = async () => {
      throw new Error('should not be called');
    };
    const connector = createLinearConnector({ fetchImpl });
    await expect(
      connector.poll({ subscription: SUB, credential: null, cursor: null }),
    ).rejects.toThrowError(/missing credential/);
  });

  it('throws on a malformed pattern (lowercase or non-letter start)', async () => {
    const fetchImpl: FetchFn = async () => {
      throw new Error('should not be called');
    };
    const connector = createLinearConnector({ fetchImpl });
    await expect(
      connector.poll({
        subscription: { ...SUB, pattern: 'eng' },
        credential: TOKEN,
        cursor: null,
      }),
    ).rejects.toThrowError(/team key/);
    await expect(
      connector.poll({
        subscription: { ...SUB, pattern: '7TEAM' },
        credential: TOKEN,
        cursor: null,
      }),
    ).rejects.toThrowError(/team key/);
  });

  it('sends the API key in the Authorization header without a Bearer prefix', async () => {
    let observedAuth: string | null = null;
    const fetchImpl: FetchFn = async (_url, init) => {
      const headers = new Headers(init?.headers ?? {});
      observedAuth = headers.get('Authorization');
      return jsonResponse(issuesPage([]));
    };
    const connector = createLinearConnector({ fetchImpl });
    await connector.poll({ subscription: SUB, credential: TOKEN, cursor: null });
    expect(observedAuth).toBe(TOKEN);
    expect(observedAuth).not.toMatch(/^Bearer /);
  });
});

describe('createLinearConnector.verifyCredential', () => {
  it('returns ok=true on a successful viewer query', async () => {
    const fetchImpl: FetchFn = async () =>
      jsonResponse({ data: { viewer: { id: 'u1', name: 'Alice', email: 'a@example.com' } } });
    const connector = createLinearConnector({ fetchImpl });
    const r = await connector.verifyCredential!('any-api-key');
    expect(r.ok).toBe(true);
  });

  it('returns ok=false on 401', async () => {
    const fetchImpl: FetchFn = async () =>
      new Response('Unauthorized', { status: 401 });
    const connector = createLinearConnector({ fetchImpl });
    const r = await connector.verifyCredential!('bad-key');
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/401/);
  });

  it('returns ok=false when GraphQL returns an errors[] body', async () => {
    const fetchImpl: FetchFn = async () =>
      jsonResponse({
        errors: [{ message: 'Authentication failed', extensions: { code: 'UNAUTHENTICATED' } }],
      });
    const connector = createLinearConnector({ fetchImpl });
    const r = await connector.verifyCredential!('bad-key');
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/Authentication failed/);
  });

  it('rejects an empty credential without making an HTTP call', async () => {
    let called = false;
    const fetchImpl: FetchFn = async () => {
      called = true;
      throw new Error('should not be called');
    };
    const connector = createLinearConnector({ fetchImpl });
    const r = await connector.verifyCredential!('');
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });

  it('does not echo the credential into the detail on network failure', async () => {
    const SECRET = 'lin_api_super_secret_zzz';
    const fetchImpl: FetchFn = async () => {
      throw new Error('econnreset');
    };
    const connector = createLinearConnector({ fetchImpl });
    const r = await connector.verifyCredential!(SECRET);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});
