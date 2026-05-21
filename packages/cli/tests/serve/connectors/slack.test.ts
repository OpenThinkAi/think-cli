import { describe, it, expect } from 'vitest';
import {
  createSlackConnector,
  SlackRateLimitError,
  type FetchFn,
  type SlackCursor,
} from '../../../src/serve/connectors/slack.js';

/**
 * Unit tests for the Slack connector (AGT-394). The connector talks to
 * Slack via an injected `fetchImpl`, so each test plants a small
 * method→response map and asserts on emitted EventInputs.
 *
 * Pathways exercised:
 *   1. Thread with closing reaction → one terminal event per thread.
 *   2. Threads without the closing reaction → no event.
 *   3. Reply with the reaction (not on root) → no event.
 *   4. Custom closing reaction (e.g. `white_check_mark`) honored.
 *   5. `:lock:` (colon form) normalized to `lock`.
 *   6. Re-poll idempotency: emittedThreadKeys cursor prevents re-emission.
 *   7. Slack `ratelimited` envelope and HTTP 429 both throw.
 *   8. Missing credential, malformed pattern.
 *   9. `verifyCredential` paths.
 */

interface CannedResponse {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}

interface MockFetchOptions {
  routes: Array<{ match: (url: string) => boolean; response: CannedResponse }>;
  log?: string[];
}

function makeFetch(opts: MockFetchOptions): FetchFn {
  return async (url) => {
    const u = typeof url === 'string' ? url : (url as URL).toString();
    opts.log?.push(u);
    const route = opts.routes.find((r) => r.match(u));
    if (!route) {
      throw new Error(`mock fetch: no route matched ${u}`);
    }
    const status = route.response.status ?? 200;
    const headers = new Headers(route.response.headers ?? {});
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    const bodyText =
      route.response.body === undefined ? '' : JSON.stringify(route.response.body);
    return new Response(bodyText, { status, headers });
  };
}

const SUB = { id: 'sub-slack-1', kind: 'slack', pattern: 'acme' };
const TOKEN = 'xoxb-test-bot-token-xxx';
const BASE = 'https://slack.com/api';

function matchMethod(method: string) {
  return (url: string) => url.startsWith(`${BASE}/${method}`);
}

describe('createSlackConnector — terminal-event emission', () => {
  it('emits one event for a thread with the closing reaction on the root', async () => {
    const fetchImpl = makeFetch({
      routes: [
        {
          match: matchMethod('users.conversations'),
          response: {
            body: {
              ok: true,
              channels: [{ id: 'C01', name: 'engineering' }],
            },
          },
        },
        {
          match: matchMethod('conversations.history'),
          response: {
            body: {
              ok: true,
              messages: [
                {
                  ts: '1716100000.000100',
                  user: 'U_ALICE',
                  text: 'We need to decide on the cache TTL',
                  reactions: [
                    { name: 'lock', users: ['U_ALICE'], count: 1 },
                  ],
                },
              ],
            },
          },
        },
        {
          match: matchMethod('conversations.replies'),
          response: {
            body: {
              ok: true,
              messages: [
                {
                  ts: '1716100000.000100',
                  user: 'U_ALICE',
                  text: 'We need to decide on the cache TTL',
                  reactions: [{ name: 'lock', users: ['U_ALICE'], count: 1 }],
                },
                {
                  ts: '1716100050.000200',
                  thread_ts: '1716100000.000100',
                  user: 'U_BOB',
                  text: '60s feels right',
                },
                {
                  ts: '1716100100.000300',
                  thread_ts: '1716100000.000100',
                  user: 'U_ALICE',
                  text: 'Agreed, going with 60s',
                },
              ],
            },
          },
        },
      ],
    });

    const connector = createSlackConnector({ fetchImpl, closingReaction: 'lock' });
    const result = await connector.poll({
      subscription: SUB,
      credential: TOKEN,
      cursor: null,
    });

    expect(result.events).toHaveLength(1);
    const evt = result.events[0];
    expect(evt.episodeKey).toBe('slack:acme:C01:1716100000.000100');
    expect(evt.id).toBe('slack:acme:C01:1716100000.000100:closed');
    expect(evt.terminal).toBe(true);
    const payload = JSON.parse(evt.payload as string) as {
      kind: string;
      workspace: string;
      channel_id: string;
      channel_name: string;
      thread_ts: string;
      closing_reaction: string;
      participants: string[];
      message_count: number;
      messages: Array<{ ts: string; user: string | null; text: string }>;
      final_state: string;
      started_at: string;
      ended_at: string;
    };
    expect(payload.kind).toBe('thread.closed');
    expect(payload.workspace).toBe('acme');
    expect(payload.channel_id).toBe('C01');
    expect(payload.channel_name).toBe('engineering');
    expect(payload.thread_ts).toBe('1716100000.000100');
    expect(payload.closing_reaction).toBe('lock');
    expect(payload.final_state).toBe('closed');
    expect(payload.participants.sort()).toEqual(['U_ALICE', 'U_BOB']);
    expect(payload.message_count).toBe(3);
    expect(payload.messages).toHaveLength(3);
    // Time range comes from the first and last message ts.
    expect(payload.started_at).toBe(new Date(1716100000 * 1000).toISOString());
    expect(payload.ended_at).toBe(new Date(1716100100 * 1000).toISOString());
    // Cursor remembers the thread key so the next poll won't re-emit.
    expect(result.nextCursor.emittedThreadKeys).toContain(
      'slack:acme:C01:1716100000.000100',
    );
  });

  it('emits nothing for a thread without the closing reaction', async () => {
    const fetchImpl = makeFetch({
      routes: [
        {
          match: matchMethod('users.conversations'),
          response: { body: { ok: true, channels: [{ id: 'C01' }] } },
        },
        {
          match: matchMethod('conversations.history'),
          response: {
            body: {
              ok: true,
              messages: [
                {
                  ts: '1716200000.000100',
                  user: 'U_ALICE',
                  text: 'open question',
                  reactions: [{ name: 'thumbsup', users: ['U_BOB'], count: 1 }],
                },
                {
                  ts: '1716200500.000200',
                  user: 'U_ALICE',
                  text: 'no reactions yet',
                },
              ],
            },
          },
        },
      ],
    });
    const connector = createSlackConnector({ fetchImpl, closingReaction: 'lock' });
    const result = await connector.poll({
      subscription: SUB,
      credential: TOKEN,
      cursor: null,
    });
    expect(result.events).toHaveLength(0);
  });

  it('ignores the closing reaction on a reply (not on the root)', async () => {
    const fetchImpl = makeFetch({
      routes: [
        {
          match: matchMethod('users.conversations'),
          response: { body: { ok: true, channels: [{ id: 'C01' }] } },
        },
        {
          match: matchMethod('conversations.history'),
          response: {
            body: {
              ok: true,
              messages: [
                // A reply that happens to surface in history with the
                // reaction — its `thread_ts !== ts`, so the connector
                // should NOT treat it as a thread root.
                {
                  ts: '1716300050.000200',
                  thread_ts: '1716300000.000100',
                  user: 'U_BOB',
                  text: 'reply with lock',
                  reactions: [{ name: 'lock', users: ['U_ALICE'], count: 1 }],
                },
              ],
            },
          },
        },
      ],
    });
    const connector = createSlackConnector({ fetchImpl, closingReaction: 'lock' });
    const result = await connector.poll({
      subscription: SUB,
      credential: TOKEN,
      cursor: null,
    });
    expect(result.events).toHaveLength(0);
  });

  it('honors a custom closing reaction passed via options', async () => {
    const fetchImpl = makeFetch({
      routes: [
        {
          match: matchMethod('users.conversations'),
          response: { body: { ok: true, channels: [{ id: 'C42' }] } },
        },
        {
          match: matchMethod('conversations.history'),
          response: {
            body: {
              ok: true,
              messages: [
                {
                  ts: '1716400000.000100',
                  user: 'U_CAROL',
                  text: 'shipping the migration',
                  reactions: [
                    { name: 'white_check_mark', users: ['U_DAVE'], count: 1 },
                  ],
                },
              ],
            },
          },
        },
        {
          match: matchMethod('conversations.replies'),
          response: {
            body: {
              ok: true,
              messages: [
                {
                  ts: '1716400000.000100',
                  user: 'U_CAROL',
                  text: 'shipping the migration',
                  reactions: [
                    { name: 'white_check_mark', users: ['U_DAVE'], count: 1 },
                  ],
                },
              ],
            },
          },
        },
      ],
    });
    const connector = createSlackConnector({
      fetchImpl,
      closingReaction: 'white_check_mark',
    });
    const result = await connector.poll({
      subscription: SUB,
      credential: TOKEN,
      cursor: null,
    });
    expect(result.events).toHaveLength(1);
    const payload = JSON.parse(result.events[0].payload as string) as {
      closing_reaction: string;
    };
    expect(payload.closing_reaction).toBe('white_check_mark');
  });

  it('accepts `:lock:` colon-form and normalizes it', async () => {
    const fetchImpl = makeFetch({
      routes: [
        {
          match: matchMethod('users.conversations'),
          response: { body: { ok: true, channels: [{ id: 'C01' }] } },
        },
        {
          match: matchMethod('conversations.history'),
          response: {
            body: {
              ok: true,
              messages: [
                {
                  ts: '1716500000.000100',
                  user: 'U_ALICE',
                  text: 'colon form should still work',
                  reactions: [{ name: 'lock', users: ['U_ALICE'], count: 1 }],
                },
              ],
            },
          },
        },
        {
          match: matchMethod('conversations.replies'),
          response: {
            body: {
              ok: true,
              messages: [
                {
                  ts: '1716500000.000100',
                  user: 'U_ALICE',
                  text: 'colon form should still work',
                  reactions: [{ name: 'lock', users: ['U_ALICE'], count: 1 }],
                },
              ],
            },
          },
        },
      ],
    });
    const connector = createSlackConnector({
      fetchImpl,
      closingReaction: ':lock:',
    });
    const result = await connector.poll({
      subscription: SUB,
      credential: TOKEN,
      cursor: null,
    });
    expect(result.events).toHaveLength(1);
  });

  it('skips archived channels', async () => {
    const fetchImpl = makeFetch({
      routes: [
        {
          match: matchMethod('users.conversations'),
          response: {
            body: {
              ok: true,
              channels: [{ id: 'C_ARCHIVED', is_archived: true }],
            },
          },
        },
        // history/replies should not be called — assert by NOT registering
        // them and letting the mock throw if hit.
      ],
    });
    const connector = createSlackConnector({ fetchImpl, closingReaction: 'lock' });
    const result = await connector.poll({
      subscription: SUB,
      credential: TOKEN,
      cursor: null,
    });
    expect(result.events).toHaveLength(0);
  });

  it('handles multiple channels and emits one event per closed thread', async () => {
    const fetchImpl = makeFetch({
      routes: [
        {
          match: matchMethod('users.conversations'),
          response: {
            body: {
              ok: true,
              channels: [{ id: 'C01' }, { id: 'C02' }],
            },
          },
        },
        {
          match: (u) =>
            u.startsWith(`${BASE}/conversations.history`) && u.includes('channel=C01'),
          response: {
            body: {
              ok: true,
              messages: [
                {
                  ts: '1716600000.000100',
                  user: 'U1',
                  text: 'a',
                  reactions: [{ name: 'lock', users: ['U1'], count: 1 }],
                },
              ],
            },
          },
        },
        {
          match: (u) =>
            u.startsWith(`${BASE}/conversations.history`) && u.includes('channel=C02'),
          response: {
            body: {
              ok: true,
              messages: [
                {
                  ts: '1716700000.000200',
                  user: 'U2',
                  text: 'b',
                  reactions: [{ name: 'lock', users: ['U1'], count: 1 }],
                },
              ],
            },
          },
        },
        {
          match: (u) =>
            u.startsWith(`${BASE}/conversations.replies`) && u.includes('channel=C01'),
          response: {
            body: {
              ok: true,
              messages: [
                {
                  ts: '1716600000.000100',
                  user: 'U1',
                  text: 'a',
                  reactions: [{ name: 'lock', users: ['U1'], count: 1 }],
                },
              ],
            },
          },
        },
        {
          match: (u) =>
            u.startsWith(`${BASE}/conversations.replies`) && u.includes('channel=C02'),
          response: {
            body: {
              ok: true,
              messages: [
                {
                  ts: '1716700000.000200',
                  user: 'U2',
                  text: 'b',
                  reactions: [{ name: 'lock', users: ['U1'], count: 1 }],
                },
              ],
            },
          },
        },
      ],
    });
    const connector = createSlackConnector({ fetchImpl, closingReaction: 'lock' });
    const result = await connector.poll({
      subscription: SUB,
      credential: TOKEN,
      cursor: null,
    });
    expect(result.events).toHaveLength(2);
    expect(result.events.map((e) => e.episodeKey).sort()).toEqual([
      'slack:acme:C01:1716600000.000100',
      'slack:acme:C02:1716700000.000200',
    ]);
  });
});

describe('createSlackConnector — re-poll idempotency', () => {
  it('does not re-emit a thread whose key is already in the cursor', async () => {
    const fetchImpl = makeFetch({
      routes: [
        {
          match: matchMethod('users.conversations'),
          response: { body: { ok: true, channels: [{ id: 'C01' }] } },
        },
        {
          match: matchMethod('conversations.history'),
          response: {
            body: {
              ok: true,
              messages: [
                {
                  ts: '1716800000.000100',
                  user: 'U1',
                  text: 'already emitted',
                  reactions: [{ name: 'lock', users: ['U1'], count: 1 }],
                },
              ],
            },
          },
        },
        // conversations.replies should NOT be called — not registering.
      ],
    });
    const connector = createSlackConnector({ fetchImpl, closingReaction: 'lock' });
    const cursor: SlackCursor = {
      emittedThreadKeys: ['slack:acme:C01:1716800000.000100'],
    };
    const result = await connector.poll({
      subscription: SUB,
      credential: TOKEN,
      cursor,
    });
    expect(result.events).toHaveLength(0);
    // Key stays remembered so future polls also skip it.
    expect(result.nextCursor.emittedThreadKeys).toContain(
      'slack:acme:C01:1716800000.000100',
    );
  });

  it('caps emittedThreadKeys at the configured size (FIFO)', async () => {
    const fetchImpl = makeFetch({
      routes: [
        {
          match: matchMethod('users.conversations'),
          response: { body: { ok: true, channels: [{ id: 'C01' }] } },
        },
        {
          match: matchMethod('conversations.history'),
          response: {
            body: {
              ok: true,
              messages: [
                {
                  ts: '1716900000.000100',
                  user: 'U1',
                  text: 'new1',
                  reactions: [{ name: 'lock', users: ['U1'], count: 1 }],
                },
                {
                  ts: '1716900100.000200',
                  user: 'U1',
                  text: 'new2',
                  reactions: [{ name: 'lock', users: ['U1'], count: 1 }],
                },
              ],
            },
          },
        },
        {
          match: matchMethod('conversations.replies'),
          response: {
            // Returned for both calls; the test cares about cursor cap,
            // not the thread shape.
            body: {
              ok: true,
              messages: [
                {
                  ts: '1716900000.000100',
                  user: 'U1',
                  text: 'new1',
                },
              ],
            },
          },
        },
      ],
    });
    const connector = createSlackConnector({
      fetchImpl,
      closingReaction: 'lock',
      closedThreadMemorySize: 3,
    });
    const result = await connector.poll({
      subscription: SUB,
      credential: TOKEN,
      cursor: {
        emittedThreadKeys: ['old:a', 'old:b', 'old:c', 'old:d'],
      },
    });
    expect(result.events).toHaveLength(2);
    // Cap=3 means we keep the most recent 3 out of the merged set
    // { old:a, old:b, old:c, old:d, <new1>, <new2> }.
    expect(result.nextCursor.emittedThreadKeys).toHaveLength(3);
    expect(result.nextCursor.emittedThreadKeys).toEqual([
      'old:d',
      'slack:acme:C01:1716900000.000100',
      'slack:acme:C01:1716900100.000200',
    ]);
  });
});

describe('createSlackConnector — rate limiting', () => {
  it('throws SlackRateLimitError on HTTP 429 with Retry-After', async () => {
    const fetchImpl: FetchFn = async () =>
      new Response('rate-limited', {
        status: 429,
        headers: { 'Retry-After': '20' },
      });
    const fixedNow = new Date('2026-05-21T12:00:00Z');
    const connector = createSlackConnector({
      fetchImpl,
      closingReaction: 'lock',
      now: () => fixedNow,
    });
    await expect(
      connector.poll({ subscription: SUB, credential: TOKEN, cursor: null }),
    ).rejects.toBeInstanceOf(SlackRateLimitError);
    try {
      await connector.poll({ subscription: SUB, credential: TOKEN, cursor: null });
    } catch (err) {
      expect((err as SlackRateLimitError).resetAt).toEqual(
        new Date(fixedNow.getTime() + 20_000),
      );
    }
  });

  it('throws SlackRateLimitError on Slack `ratelimited` envelope', async () => {
    // Slack sometimes returns 200 with `{ ok: false, error: 'ratelimited' }`
    // and a `Retry-After` header instead of a real 429. Cover both paths.
    const fetchImpl: FetchFn = async () =>
      new Response(JSON.stringify({ ok: false, error: 'ratelimited' }), {
        status: 200,
        headers: {
          'Retry-After': '15',
          'content-type': 'application/json',
        },
      });
    const fixedNow = new Date('2026-05-21T13:00:00Z');
    const connector = createSlackConnector({
      fetchImpl,
      closingReaction: 'lock',
      now: () => fixedNow,
    });
    await expect(
      connector.poll({ subscription: SUB, credential: TOKEN, cursor: null }),
    ).rejects.toBeInstanceOf(SlackRateLimitError);
  });

  it('surfaces non-ratelimit Slack errors as plain Errors', async () => {
    const fetchImpl: FetchFn = async () =>
      new Response(JSON.stringify({ ok: false, error: 'missing_scope' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const connector = createSlackConnector({ fetchImpl, closingReaction: 'lock' });
    await expect(
      connector.poll({ subscription: SUB, credential: TOKEN, cursor: null }),
    ).rejects.toThrowError(/missing_scope/);
  });
});

describe('createSlackConnector — input guards', () => {
  it('throws when credential is null', async () => {
    const fetchImpl: FetchFn = async () => {
      throw new Error('should not be called');
    };
    const connector = createSlackConnector({ fetchImpl, closingReaction: 'lock' });
    await expect(
      connector.poll({ subscription: SUB, credential: null, cursor: null }),
    ).rejects.toThrowError(/missing credential/);
  });

  it('throws on an empty pattern', async () => {
    const fetchImpl: FetchFn = async () => {
      throw new Error('should not be called');
    };
    const connector = createSlackConnector({ fetchImpl, closingReaction: 'lock' });
    await expect(
      connector.poll({
        subscription: { ...SUB, pattern: '   ' },
        credential: TOKEN,
        cursor: null,
      }),
    ).rejects.toThrowError(/non-empty/);
  });

  it('throws on a whitespace-bearing pattern', async () => {
    const fetchImpl: FetchFn = async () => {
      throw new Error('should not be called');
    };
    const connector = createSlackConnector({ fetchImpl, closingReaction: 'lock' });
    await expect(
      connector.poll({
        subscription: { ...SUB, pattern: 'my workspace' },
        credential: TOKEN,
        cursor: null,
      }),
    ).rejects.toThrowError(/workspace label/);
  });
});

describe('createSlackConnector.verifyCredential', () => {
  it('returns ok=true on auth.test ok envelope', async () => {
    const fetchImpl: FetchFn = async () =>
      new Response(JSON.stringify({ ok: true, team: 'acme', user: 'thinkbot' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const connector = createSlackConnector({ fetchImpl, closingReaction: 'lock' });
    const r = await connector.verifyCredential!('xoxb-any');
    expect(r.ok).toBe(true);
  });

  it('returns ok=false on Slack `invalid_auth` envelope', async () => {
    const fetchImpl: FetchFn = async () =>
      new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const connector = createSlackConnector({ fetchImpl, closingReaction: 'lock' });
    const r = await connector.verifyCredential!('xoxb-bad');
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/invalid_auth/);
  });

  it('returns ok=false on HTTP 401', async () => {
    const fetchImpl: FetchFn = async () =>
      new Response('Unauthorized', { status: 401 });
    const connector = createSlackConnector({ fetchImpl, closingReaction: 'lock' });
    const r = await connector.verifyCredential!('xoxb-bad');
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/401/);
  });

  it('rejects an empty credential without making an HTTP call', async () => {
    let called = false;
    const fetchImpl: FetchFn = async () => {
      called = true;
      throw new Error('should not be called');
    };
    const connector = createSlackConnector({ fetchImpl, closingReaction: 'lock' });
    const r = await connector.verifyCredential!('');
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });

  it('does not echo the credential into the detail on network failure', async () => {
    const SECRET = 'xoxb-super-secret-bot-token-zzz';
    const fetchImpl: FetchFn = async () => {
      throw new Error('econnreset');
    };
    const connector = createSlackConnector({ fetchImpl, closingReaction: 'lock' });
    const r = await connector.verifyCredential!(SECRET);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});
