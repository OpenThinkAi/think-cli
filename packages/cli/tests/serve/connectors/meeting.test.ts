import { describe, it, expect } from 'vitest';
import {
  createMeetingConnector,
  MeetingRateLimitError,
  bumpSinceBy1Ms,
  type FetchFn,
  type MeetingCursor,
} from '../../../src/serve/connectors/meeting.js';

/**
 * Unit tests for the meeting connector (AGT-393). The connector talks
 * to Granola via an injected `fetchImpl`, so each test plants a small
 * URL → response map and asserts on the emitted EventInputs.
 *
 * One terminal pathway today (more providers in follow-on tickets):
 *   - meeting finalized → id `:finalized`, payload final_state='finalized'
 *
 * Plus: in-progress / transcript-pending skip, re-poll idempotency
 * (cursor advances past newest updated_at), rate-limit handling,
 * missing-credential, malformed pattern, verifyCredential branches,
 * AC #2 no-segmentation contract (multi-topic payload stays one event).
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

const SUB = { id: 'sub-meet-1', kind: 'meeting', pattern: 'granola' };
const TOKEN = 'grk_test_api_key_xxx';
const BASE = 'https://api.granola.ai';

function matchExact(pathFragment: string) {
  return (url: string) => {
    const base = BASE + pathFragment;
    return url === base || url.startsWith(base + '?');
  };
}

describe('createMeetingConnector — terminal-event emission', () => {
  it('emits one event for a finalized Granola meeting', async () => {
    const fetchImpl = makeFetch({
      routes: [
        {
          match: matchExact('/v2/meetings'),
          response: {
            body: {
              meetings: [
                {
                  id: 'mtg-abc-123',
                  title: 'Weekly product sync',
                  state: 'completed',
                  created_at: '2026-05-20T15:55:00Z',
                  updated_at: '2026-05-20T17:10:00Z',
                  started_at: '2026-05-20T16:00:00Z',
                  ended_at: '2026-05-20T17:00:00Z',
                  creator: { email: 'alice@example.com', name: 'Alice' },
                  attendees: [
                    { email: 'alice@example.com', name: 'Alice' },
                    { email: 'bob@example.com', name: 'Bob' },
                  ],
                  transcript: 'Alice: Welcome everyone…\nBob: Glad to be here.\n',
                  notes: 'Discussed Q3 roadmap and pricing.',
                  highlights: {
                    tldr: 'Roadmap green; pricing deferred.',
                    decisions: ['Ship feature X in July'],
                    action_items: [{ owner: 'bob', text: 'Draft pricing memo' }],
                    key_topics: ['roadmap', 'pricing'],
                  },
                },
              ],
            },
          },
        },
      ],
    });

    const connector = createMeetingConnector({ fetchImpl });
    const result = await connector.poll({
      subscription: SUB,
      credential: TOKEN,
      cursor: null,
    });

    expect(result.events).toHaveLength(1);
    const evt = result.events[0];
    expect(evt.id).toBe('meeting:granola:mtg-abc-123:finalized');
    expect(evt.episodeKey).toBe('meeting:granola:mtg-abc-123');
    expect(evt.terminal).toBe(true);
    const payload = JSON.parse(evt.payload as string) as {
      kind: string;
      provider: string;
      meeting_id: string;
      title: string;
      final_state: string;
      attendees: Array<{ email: string; name: string }>;
      started_at: string;
      ended_at: string;
      transcript: string;
      notes: string;
      highlights: {
        tldr: string;
        decisions: string[];
        action_items: Array<{ owner: string; text: string }>;
        key_topics: string[];
      };
    };
    expect(payload.kind).toBe('meeting.finalized');
    expect(payload.provider).toBe('granola');
    expect(payload.meeting_id).toBe('mtg-abc-123');
    expect(payload.final_state).toBe('finalized');
    expect(payload.attendees).toHaveLength(2);
    expect(payload.attendees[0].email).toBe('alice@example.com');
    expect(payload.transcript).toContain('Alice: Welcome');
    expect(payload.notes).toContain('Q3 roadmap');
    expect(payload.highlights.decisions).toEqual(['Ship feature X in July']);
    expect(payload.highlights.action_items[0].text).toBe('Draft pricing memo');
    expect(payload.highlights.key_topics).toEqual(['roadmap', 'pricing']);
    expect(result.nextCursor.updatedSince).toBe('2026-05-20T17:10:00.001Z');
  });

  it('accepts a flat-array response shape (defensive)', async () => {
    // Granola's documented shape is `{ meetings: [...] }`; the connector
    // also accepts a bare array so a future API revision doesn't break
    // ingestion silently.
    const fetchImpl = makeFetch({
      routes: [
        {
          match: matchExact('/v2/meetings'),
          response: {
            body: [
              {
                id: 'mtg-flat-1',
                title: 'Flat shape',
                state: 'completed',
                created_at: '2026-05-20T15:55:00Z',
                updated_at: '2026-05-20T17:10:00Z',
                started_at: '2026-05-20T16:00:00Z',
                ended_at: '2026-05-20T17:00:00Z',
                transcript: 'some words',
              },
            ],
          },
        },
      ],
    });
    const connector = createMeetingConnector({ fetchImpl });
    const result = await connector.poll({
      subscription: SUB,
      credential: TOKEN,
      cursor: null,
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0].id).toBe('meeting:granola:mtg-flat-1:finalized');
  });

  it('skips meetings that are still in progress', async () => {
    const fetchImpl = makeFetch({
      routes: [
        {
          match: matchExact('/v2/meetings'),
          response: {
            body: {
              meetings: [
                {
                  id: 'mtg-live-1',
                  title: 'Live meeting',
                  state: 'in_progress',
                  created_at: '2026-05-20T15:55:00Z',
                  updated_at: '2026-05-20T16:30:00Z',
                  started_at: '2026-05-20T16:00:00Z',
                  ended_at: null,
                  transcript: 'partial...',
                },
              ],
            },
          },
        },
      ],
    });
    const connector = createMeetingConnector({ fetchImpl });
    const result = await connector.poll({
      subscription: SUB,
      credential: TOKEN,
      cursor: null,
    });
    expect(result.events).toHaveLength(0);
    // But the cursor still advances past the row — the in-progress
    // meeting will re-surface when its updated_at bumps again at
    // finalization time.
    expect(result.nextCursor.updatedSince).toBe('2026-05-20T16:30:00.001Z');
  });

  it('skips finalized meetings whose transcript is still processing', async () => {
    const fetchImpl = makeFetch({
      routes: [
        {
          match: matchExact('/v2/meetings'),
          response: {
            body: {
              meetings: [
                {
                  id: 'mtg-processing-1',
                  title: 'Processing',
                  state: 'completed',
                  created_at: '2026-05-20T15:55:00Z',
                  updated_at: '2026-05-20T17:05:00Z',
                  started_at: '2026-05-20T16:00:00Z',
                  ended_at: '2026-05-20T17:00:00Z',
                  transcript: null, // post-processing not done
                },
                {
                  id: 'mtg-empty-transcript',
                  title: 'Empty',
                  state: 'completed',
                  created_at: '2026-05-20T15:55:00Z',
                  updated_at: '2026-05-20T17:06:00Z',
                  started_at: '2026-05-20T16:00:00Z',
                  ended_at: '2026-05-20T17:00:00Z',
                  transcript: '',
                },
              ],
            },
          },
        },
      ],
    });
    const connector = createMeetingConnector({ fetchImpl });
    const result = await connector.poll({
      subscription: SUB,
      credential: TOKEN,
      cursor: null,
    });
    expect(result.events).toHaveLength(0);
  });

  it('does NOT split a multi-topic transcript inside the connector (AC #2)', async () => {
    // The curator (`runTerminalEventCuration`) owns segmentation. The
    // connector hands the curator one big payload — anything else
    // duplicates segmentation responsibility and breaks the contract.
    const longMultiTopicTranscript = [
      'Topic A: Roadmap...',
      'Topic B: Hiring plan...',
      'Topic C: Pricing changes...',
      'Topic D: Customer escalation...',
    ].join('\n\n');

    const fetchImpl = makeFetch({
      routes: [
        {
          match: matchExact('/v2/meetings'),
          response: {
            body: {
              meetings: [
                {
                  id: 'mtg-multitopic',
                  title: 'Q3 planning',
                  state: 'completed',
                  created_at: '2026-05-20T15:55:00Z',
                  updated_at: '2026-05-20T18:10:00Z',
                  started_at: '2026-05-20T15:00:00Z',
                  ended_at: '2026-05-20T18:00:00Z',
                  transcript: longMultiTopicTranscript,
                  highlights: {
                    key_topics: ['roadmap', 'hiring', 'pricing', 'escalation'],
                  },
                },
              ],
            },
          },
        },
      ],
    });
    const connector = createMeetingConnector({ fetchImpl });
    const result = await connector.poll({
      subscription: SUB,
      credential: TOKEN,
      cursor: null,
    });
    // Exactly one event, transcript untouched. The curator splits it
    // downstream into N memories sharing the episode key.
    expect(result.events).toHaveLength(1);
    const payload = JSON.parse(result.events[0].payload as string) as {
      transcript: string;
      highlights: { key_topics: string[] };
    };
    expect(payload.transcript).toBe(longMultiTopicTranscript);
    expect(payload.highlights.key_topics).toEqual([
      'roadmap',
      'hiring',
      'pricing',
      'escalation',
    ]);
  });

  it('shapes missing attendees / creator / highlights as null-safe values', async () => {
    const fetchImpl = makeFetch({
      routes: [
        {
          match: matchExact('/v2/meetings'),
          response: {
            body: {
              meetings: [
                {
                  id: 'mtg-bare',
                  title: null,
                  state: 'completed',
                  created_at: '2026-05-20T15:55:00Z',
                  updated_at: '2026-05-20T17:10:00Z',
                  started_at: '2026-05-20T16:00:00Z',
                  ended_at: '2026-05-20T17:00:00Z',
                  transcript: 'a few words',
                  // no creator, attendees, highlights, notes
                },
              ],
            },
          },
        },
      ],
    });
    const connector = createMeetingConnector({ fetchImpl });
    const result = await connector.poll({
      subscription: SUB,
      credential: TOKEN,
      cursor: null,
    });
    expect(result.events).toHaveLength(1);
    const payload = JSON.parse(result.events[0].payload as string) as {
      title: string | null;
      creator: unknown;
      attendees: unknown[];
      highlights: unknown;
      notes: unknown;
    };
    expect(payload.title).toBeNull();
    expect(payload.creator).toBeNull();
    expect(payload.attendees).toEqual([]);
    expect(payload.highlights).toBeNull();
    expect(payload.notes).toBeNull();
  });
});

describe('createMeetingConnector — re-poll idempotency', () => {
  it('advances `updatedSince` 1ms past the newest considered row', async () => {
    const log: string[] = [];
    let callCount = 0;
    const responses = [
      {
        meetings: [
          {
            id: 'mtg-first',
            title: 'first',
            state: 'completed',
            created_at: '2026-05-20T15:55:00Z',
            updated_at: '2026-05-20T17:10:00Z',
            started_at: '2026-05-20T16:00:00Z',
            ended_at: '2026-05-20T17:00:00Z',
            transcript: 'words',
          },
        ],
      },
      { meetings: [] }, // second poll returns nothing new
    ];
    const fetchImpl: FetchFn = async (url) => {
      const u = typeof url === 'string' ? url : (url as URL).toString();
      log.push(u);
      const body = responses[Math.min(callCount, responses.length - 1)];
      callCount++;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const connector = createMeetingConnector({ fetchImpl });
    const r1 = await connector.poll({
      subscription: SUB,
      credential: TOKEN,
      cursor: null,
    });
    expect(r1.events).toHaveLength(1);
    expect(r1.nextCursor.updatedSince).toBe('2026-05-20T17:10:00.001Z');

    const r2 = await connector.poll({
      subscription: SUB,
      credential: TOKEN,
      cursor: r1.nextCursor,
    });
    expect(r2.events).toHaveLength(0);
    // First call had no `updated_since`; second call carried the bumped
    // cursor value verbatim.
    expect(log[0]).not.toContain('updated_since=');
    expect(log[1]).toContain('updated_since=2026-05-20T17%3A10%3A00.001Z');
  });

  it('forwards the existing cursor (plus the 1ms bump) when the poll is empty', async () => {
    // The connector always bumps the cursor by 1ms at the end of a
    // successful poll (mirrors the github connector). Empty-result
    // polls therefore drift forward by 1ms each tick — negligible at
    // the project's 600s default poll interval, but the test pins the
    // behavior so a future change is intentional.
    const fetchImpl = makeFetch({
      routes: [
        {
          match: matchExact('/v2/meetings'),
          response: { body: { meetings: [] } },
        },
      ],
      log: [],
    });
    const connector = createMeetingConnector({ fetchImpl });
    const cursor: MeetingCursor = { updatedSince: '2026-05-20T17:10:00.001Z' };
    const result = await connector.poll({
      subscription: SUB,
      credential: TOKEN,
      cursor,
    });
    expect(result.events).toHaveLength(0);
    expect(result.nextCursor.updatedSince).toBe('2026-05-20T17:10:00.002Z');
  });
});

describe('createMeetingConnector — rate limiting', () => {
  it('throws MeetingRateLimitError on 429 with Retry-After', async () => {
    const fetchImpl: FetchFn = async () =>
      new Response(JSON.stringify({ message: 'slow down' }), {
        status: 429,
        headers: { 'Retry-After': '45', 'content-type': 'application/json' },
      });
    const fixedNow = new Date('2026-05-21T12:00:00Z');
    const connector = createMeetingConnector({
      fetchImpl,
      now: () => fixedNow,
    });
    await expect(
      connector.poll({ subscription: SUB, credential: TOKEN, cursor: null }),
    ).rejects.toBeInstanceOf(MeetingRateLimitError);
    try {
      await connector.poll({ subscription: SUB, credential: TOKEN, cursor: null });
    } catch (err) {
      expect((err as MeetingRateLimitError).resetAt).toEqual(
        new Date(fixedNow.getTime() + 45_000),
      );
    }
  });

  it('non-rate-limit 4xx propagates as a plain Error', async () => {
    const fetchImpl: FetchFn = async () =>
      new Response(JSON.stringify({ message: 'Not found' }), {
        status: 404,
        statusText: 'Not Found',
        headers: { 'content-type': 'application/json' },
      });
    const connector = createMeetingConnector({ fetchImpl });
    await expect(
      connector.poll({ subscription: SUB, credential: TOKEN, cursor: null }),
    ).rejects.toThrowError(/404/);
  });

  it('401 from the meetings endpoint surfaces a clear unauthorized error', async () => {
    const fetchImpl: FetchFn = async () =>
      new Response('Unauthorized', { status: 401 });
    const connector = createMeetingConnector({ fetchImpl });
    await expect(
      connector.poll({ subscription: SUB, credential: TOKEN, cursor: null }),
    ).rejects.toThrowError(/401 unauthorized/);
  });
});

describe('createMeetingConnector — input guards', () => {
  it('throws when credential is null', async () => {
    const fetchImpl: FetchFn = async () => {
      throw new Error('should not be called');
    };
    const connector = createMeetingConnector({ fetchImpl });
    await expect(
      connector.poll({ subscription: SUB, credential: null, cursor: null }),
    ).rejects.toThrowError(/missing credential/);
  });

  it('throws on a malformed pattern', async () => {
    const fetchImpl: FetchFn = async () => {
      throw new Error('should not be called');
    };
    const connector = createMeetingConnector({ fetchImpl });
    await expect(
      connector.poll({
        subscription: { ...SUB, pattern: 'not a provider name' },
        credential: TOKEN,
        cursor: null,
      }),
    ).rejects.toThrowError(/provider name/);
  });

  it('throws when the provider is not yet supported', async () => {
    const fetchImpl: FetchFn = async () => {
      throw new Error('should not be called');
    };
    const connector = createMeetingConnector({ fetchImpl });
    await expect(
      connector.poll({
        subscription: { ...SUB, pattern: 'fathom' },
        credential: TOKEN,
        cursor: null,
      }),
    ).rejects.toThrowError(/fathom.*not yet supported/);
  });
});

describe('createMeetingConnector.verifyCredential', () => {
  it('returns ok=true on 200 /v2/me', async () => {
    const fetchImpl: FetchFn = async () =>
      new Response(JSON.stringify({ email: 'alice@example.com' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const connector = createMeetingConnector({ fetchImpl });
    const r = await connector.verifyCredential!('any-key');
    expect(r.ok).toBe(true);
  });

  it('returns ok=false on 401 /v2/me', async () => {
    const fetchImpl: FetchFn = async () =>
      new Response('Unauthorized', { status: 401 });
    const connector = createMeetingConnector({ fetchImpl });
    const r = await connector.verifyCredential!('bad-key');
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/401/);
  });

  it('rejects an empty credential without making an HTTP call', async () => {
    let called = false;
    const fetchImpl: FetchFn = async () => {
      called = true;
      throw new Error('should not be called');
    };
    const connector = createMeetingConnector({ fetchImpl });
    const r = await connector.verifyCredential!('');
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });

  it('does not echo the credential into the detail on network failure', async () => {
    const SECRET = 'grk_super_secret_key_zzz';
    const fetchImpl: FetchFn = async () => {
      throw new Error('econnreset');
    };
    const connector = createMeetingConnector({ fetchImpl });
    const r = await connector.verifyCredential!(SECRET);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});

describe('bumpSinceBy1Ms', () => {
  it('adds 1 millisecond to an ISO timestamp', () => {
    expect(bumpSinceBy1Ms('2026-05-19T12:00:00Z')).toBe('2026-05-19T12:00:00.001Z');
  });

  it('passes through undefined', () => {
    expect(bumpSinceBy1Ms(undefined)).toBeUndefined();
  });

  it('passes through unparseable input unchanged', () => {
    expect(bumpSinceBy1Ms('not-a-date')).toBe('not-a-date');
  });
});
