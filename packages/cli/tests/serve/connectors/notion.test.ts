import { describe, it, expect } from 'vitest';
import {
  createNotionConnector,
  NotionRateLimitError,
  parsePattern,
  serializeBlocks,
  type FetchFn,
  type NotionCursor,
} from '../../../src/serve/connectors/notion.js';

/**
 * Unit tests for the Notion connector (AGT-395). The connector talks to
 * Notion via an injected `fetchImpl`, so each test plants a small URL→
 * response map and asserts on the emitted EventInputs.
 *
 * The terminal pathway exercised here:
 *   - canonical page observed → id `notion:<scope>:<ref>:<page-id>:<edit-iso>`
 *
 * Plus: pattern parsing (db: vs ws:, query params), re-canonicalization
 * after edit produces a NEW event under the same episode_key, non-canonical
 * pages advance the cursor (so they don't re-poll), block serialization,
 * rate-limit handling, missing credential, malformed pattern,
 * verifyCredential ok/bad/empty/no-leak.
 */

interface CannedResponse {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}

interface MockFetchOptions {
  routes: Array<{ match: (url: string, init?: RequestInit) => boolean; response: CannedResponse }>;
  log?: Array<{ url: string; method?: string; body?: string }>;
}

function makeFetch(opts: MockFetchOptions): FetchFn {
  return async (url, init) => {
    const u = typeof url === 'string' ? url : (url as URL).toString();
    opts.log?.push({
      url: u,
      method: (init?.method as string | undefined) ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const route = opts.routes.find((r) => r.match(u, init));
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

const TOKEN = 'secret_xxx';
const BASE = 'https://api.notion.com';
const DB_ID = 'abc123def456';
const SUB_DB = { id: 'sub-notion-db-1', kind: 'notion', pattern: `db:${DB_ID}` };
const SUB_WS = { id: 'sub-notion-ws-1', kind: 'notion', pattern: 'ws:eng' };

function matchPath(method: 'GET' | 'POST', pathFragment: string) {
  return (url: string, init?: RequestInit) => {
    const base = BASE + pathFragment;
    const methodMatches = (init?.method ?? 'GET') === method;
    return methodMatches && (url === base || url.startsWith(base + '?') || url === base);
  };
}

describe('parsePattern', () => {
  it('parses a bare db: pattern with defaults', () => {
    const p = parsePattern(`db:${DB_ID}`);
    expect(p).toEqual({ scope: 'db', ref: DB_ID, prop: 'canonical', type: 'checkbox' });
  });

  it('parses a bare ws: pattern with defaults', () => {
    const p = parsePattern('ws:engineering');
    expect(p.scope).toBe('ws');
    expect(p.ref).toBe('engineering');
    expect(p.prop).toBe('canonical');
    expect(p.type).toBe('checkbox');
  });

  it('parses prop / type / value query params', () => {
    const p = parsePattern(`db:${DB_ID}?prop=status&type=select&value=Done`);
    expect(p).toEqual({
      scope: 'db',
      ref: DB_ID,
      prop: 'status',
      type: 'select',
      value: 'Done',
    });
  });

  it('rejects an unknown scope', () => {
    expect(() => parsePattern('page:abc')).toThrowError(/db:.*ws:/);
  });

  it('rejects missing ref', () => {
    expect(() => parsePattern('db:')).toThrowError(/database uuid/);
  });

  it('rejects an unsupported type', () => {
    expect(() => parsePattern(`db:${DB_ID}?type=number`)).toThrowError(
      /checkbox\|select\|multi_select/,
    );
  });

  it('rejects select/multi_select without a value', () => {
    expect(() => parsePattern(`db:${DB_ID}?type=select`)).toThrowError(
      /requires a non-empty value/,
    );
    expect(() => parsePattern(`db:${DB_ID}?type=multi_select`)).toThrowError(
      /requires a non-empty value/,
    );
  });

  it('rejects empty pattern', () => {
    expect(() => parsePattern('  ')).toThrowError(/empty/);
  });
});

describe('serializeBlocks', () => {
  it('renders headings, paragraphs, lists, todos, code, divider', () => {
    const text = serializeBlocks([
      {
        id: '1',
        type: 'heading_1',
        heading_1: { rich_text: [{ plain_text: 'Title' }] },
      },
      {
        id: '2',
        type: 'paragraph',
        paragraph: { rich_text: [{ plain_text: 'Lead paragraph.' }] },
      },
      {
        id: '3',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ plain_text: 'item a' }] },
      },
      {
        id: '4',
        type: 'numbered_list_item',
        numbered_list_item: { rich_text: [{ plain_text: 'one' }] },
      },
      {
        id: '5',
        type: 'to_do',
        to_do: { rich_text: [{ plain_text: 'tick me' }], checked: true },
      },
      {
        id: '6',
        type: 'code',
        code: { rich_text: [{ plain_text: 'print("hi")' }], language: 'python' },
      },
      { id: '7', type: 'divider' },
    ]);
    expect(text).toContain('# Title');
    expect(text).toContain('Lead paragraph.');
    expect(text).toContain('- item a');
    expect(text).toContain('1. one');
    expect(text).toContain('- [x] tick me');
    expect(text).toContain('```python');
    expect(text).toContain('print("hi")');
    expect(text).toContain('---');
  });

  it('recurses into _children with indentation', () => {
    const text = serializeBlocks([
      {
        id: '1',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ plain_text: 'outer' }] },
        _children: [
          {
            id: '2',
            type: 'bulleted_list_item',
            bulleted_list_item: { rich_text: [{ plain_text: 'inner' }] },
          },
        ],
      } as unknown as Parameters<typeof serializeBlocks>[0][number],
    ]);
    expect(text).toBe('- outer\n  - inner');
  });
});

describe('createNotionConnector — db: subscription, canonical detection', () => {
  it('emits one event per page where the canonical checkbox is true', async () => {
    const log: MockFetchOptions['log'] = [];
    const fetchImpl = makeFetch({
      log,
      routes: [
        {
          match: matchPath('POST', `/v1/databases/${DB_ID}/query`),
          response: {
            body: {
              results: [
                {
                  id: 'page-1',
                  object: 'page',
                  last_edited_time: '2026-05-19T12:00:00.000Z',
                  created_time: '2026-05-18T10:00:00.000Z',
                  archived: false,
                  url: 'https://www.notion.so/page-1',
                  properties: {
                    Name: {
                      type: 'title',
                      title: [{ plain_text: 'Decision: switch to X' }],
                    },
                    canonical: { type: 'checkbox', checkbox: true },
                  },
                  last_edited_by: { id: 'usr-1' },
                },
                {
                  id: 'page-2',
                  object: 'page',
                  last_edited_time: '2026-05-19T13:00:00.000Z',
                  archived: false,
                  properties: {
                    Name: { type: 'title', title: [{ plain_text: 'Draft idea' }] },
                    canonical: { type: 'checkbox', checkbox: false },
                  },
                },
              ],
              has_more: false,
              next_cursor: null,
            },
          },
        },
        {
          match: matchPath('GET', '/v1/blocks/page-1/children'),
          response: {
            body: {
              results: [
                {
                  id: 'blk-1',
                  type: 'paragraph',
                  paragraph: {
                    rich_text: [{ plain_text: 'We are switching to X because Y.' }],
                  },
                  has_children: false,
                },
              ],
              has_more: false,
              next_cursor: null,
            },
          },
        },
      ],
    });

    const connector = createNotionConnector({ fetchImpl });
    const result = await connector.poll({
      subscription: SUB_DB,
      credential: TOKEN,
      cursor: null,
    });

    expect(result.events).toHaveLength(1);
    const evt = result.events[0];
    expect(evt.id).toBe(`notion:db:${DB_ID}:page-1:2026-05-19T12:00:00.000Z`);
    expect(evt.episodeKey).toBe(`notion:db:${DB_ID}:page-1`);
    expect(evt.terminal).toBe(true);
    const payload = JSON.parse(evt.payload as string) as {
      kind: string;
      title: string;
      final_state: string;
      content: string;
      property: string;
      property_type: string;
    };
    expect(payload.kind).toBe('notion.page.canonical');
    expect(payload.title).toBe('Decision: switch to X');
    expect(payload.final_state).toBe('canonical');
    expect(payload.content).toContain('We are switching to X because Y.');
    expect(payload.property).toBe('canonical');
    expect(payload.property_type).toBe('checkbox');

    // Cursor advances to the newest page evaluated — even though page-2
    // was non-canonical, we still moved past its last_edited_time.
    expect(result.nextCursor.lastEditedTime).toBe('2026-05-19T13:00:00.000Z');

    // Database query was a POST with a sort+filter body.
    const dbCall = log.find((c) => c.url.endsWith(`/v1/databases/${DB_ID}/query`));
    expect(dbCall?.method).toBe('POST');
    expect(dbCall?.body).toContain('last_edited_time');
  });

  it('passes the cursor back as a last_edited_time > filter on the next poll', async () => {
    const log: MockFetchOptions['log'] = [];
    const fetchImpl = makeFetch({
      log,
      routes: [
        {
          match: matchPath('POST', `/v1/databases/${DB_ID}/query`),
          response: { body: { results: [], has_more: false, next_cursor: null } },
        },
      ],
    });
    const connector = createNotionConnector({ fetchImpl });
    const cursor: NotionCursor = { lastEditedTime: '2026-05-19T13:00:00.000Z' };
    await connector.poll({ subscription: SUB_DB, credential: TOKEN, cursor });
    const dbCall = log.find((c) => c.method === 'POST');
    expect(dbCall?.body).toContain('2026-05-19T13:00:00.000Z');
    const parsed = JSON.parse(dbCall!.body!) as {
      filter: { timestamp: string; last_edited_time: { after: string } };
    };
    expect(parsed.filter.timestamp).toBe('last_edited_time');
    expect(parsed.filter.last_edited_time.after).toBe('2026-05-19T13:00:00.000Z');
  });

  it('matches select / multi_select canonical signals when configured', async () => {
    const fetchImpl = makeFetch({
      routes: [
        {
          match: matchPath('POST', `/v1/databases/${DB_ID}/query`),
          response: {
            body: {
              results: [
                {
                  id: 'page-s',
                  last_edited_time: '2026-05-19T12:00:00.000Z',
                  properties: {
                    Name: { type: 'title', title: [{ plain_text: 'Selected one' }] },
                    Status: { type: 'select', select: { name: 'Canonical' } },
                  },
                },
                {
                  id: 'page-s2',
                  last_edited_time: '2026-05-19T12:01:00.000Z',
                  properties: {
                    Name: { type: 'title', title: [{ plain_text: 'Not selected' }] },
                    Status: { type: 'select', select: { name: 'Draft' } },
                  },
                },
              ],
            },
          },
        },
        {
          match: matchPath('GET', '/v1/blocks/page-s/children'),
          response: { body: { results: [] } },
        },
      ],
    });
    const connector = createNotionConnector({ fetchImpl });
    const result = await connector.poll({
      subscription: {
        ...SUB_DB,
        pattern: `db:${DB_ID}?prop=Status&type=select&value=Canonical`,
      },
      credential: TOKEN,
      cursor: null,
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0].id).toContain('page-s:');
    expect(result.events[0].id).not.toContain('page-s2:');
  });

  it('skips archived pages', async () => {
    const fetchImpl = makeFetch({
      routes: [
        {
          match: matchPath('POST', `/v1/databases/${DB_ID}/query`),
          response: {
            body: {
              results: [
                {
                  id: 'page-arch',
                  last_edited_time: '2026-05-19T12:00:00.000Z',
                  archived: true,
                  properties: {
                    canonical: { type: 'checkbox', checkbox: true },
                  },
                },
              ],
            },
          },
        },
      ],
    });
    const connector = createNotionConnector({ fetchImpl });
    const result = await connector.poll({
      subscription: SUB_DB,
      credential: TOKEN,
      cursor: null,
    });
    expect(result.events).toHaveLength(0);
    // Cursor still advances past the archived row.
    expect(result.nextCursor.lastEditedTime).toBe('2026-05-19T12:00:00.000Z');
  });

  it('recurses into nested blocks via has_children', async () => {
    const fetchImpl = makeFetch({
      routes: [
        {
          match: matchPath('POST', `/v1/databases/${DB_ID}/query`),
          response: {
            body: {
              results: [
                {
                  id: 'page-nest',
                  last_edited_time: '2026-05-19T12:00:00.000Z',
                  properties: {
                    canonical: { type: 'checkbox', checkbox: true },
                  },
                },
              ],
            },
          },
        },
        {
          match: matchPath('GET', '/v1/blocks/page-nest/children'),
          response: {
            body: {
              results: [
                {
                  id: 'blk-outer',
                  type: 'bulleted_list_item',
                  bulleted_list_item: { rich_text: [{ plain_text: 'outer' }] },
                  has_children: true,
                },
              ],
            },
          },
        },
        {
          match: matchPath('GET', '/v1/blocks/blk-outer/children'),
          response: {
            body: {
              results: [
                {
                  id: 'blk-inner',
                  type: 'bulleted_list_item',
                  bulleted_list_item: { rich_text: [{ plain_text: 'inner' }] },
                  has_children: false,
                },
              ],
            },
          },
        },
      ],
    });
    const connector = createNotionConnector({ fetchImpl });
    const result = await connector.poll({
      subscription: SUB_DB,
      credential: TOKEN,
      cursor: null,
    });
    expect(result.events).toHaveLength(1);
    const payload = JSON.parse(result.events[0].payload as string) as { content: string };
    expect(payload.content).toContain('outer');
    expect(payload.content).toContain('inner');
  });
});

describe('createNotionConnector — re-canonicalization on edit', () => {
  it('emits a NEW event when the canonical page is edited and observed again', async () => {
    // First poll: page with last_edited_time T1, canonical=true.
    const first = makeFetch({
      routes: [
        {
          match: matchPath('POST', `/v1/databases/${DB_ID}/query`),
          response: {
            body: {
              results: [
                {
                  id: 'page-x',
                  last_edited_time: '2026-05-19T12:00:00.000Z',
                  properties: {
                    Name: { type: 'title', title: [{ plain_text: 'X' }] },
                    canonical: { type: 'checkbox', checkbox: true },
                  },
                },
              ],
            },
          },
        },
        {
          match: matchPath('GET', '/v1/blocks/page-x/children'),
          response: { body: { results: [] } },
        },
      ],
    });
    const c1 = createNotionConnector({ fetchImpl: first });
    const r1 = await c1.poll({ subscription: SUB_DB, credential: TOKEN, cursor: null });
    expect(r1.events).toHaveLength(1);
    const id1 = r1.events[0].id;
    expect(id1).toBe(`notion:db:${DB_ID}:page-x:2026-05-19T12:00:00.000Z`);

    // Second poll with that cursor: page edited at T2 with canonical still
    // true — a fresh terminal event under the same episode_key.
    const second = makeFetch({
      routes: [
        {
          match: matchPath('POST', `/v1/databases/${DB_ID}/query`),
          response: {
            body: {
              results: [
                {
                  id: 'page-x',
                  last_edited_time: '2026-05-20T09:00:00.000Z',
                  properties: {
                    Name: { type: 'title', title: [{ plain_text: 'X' }] },
                    canonical: { type: 'checkbox', checkbox: true },
                  },
                },
              ],
            },
          },
        },
        {
          match: matchPath('GET', '/v1/blocks/page-x/children'),
          response: { body: { results: [] } },
        },
      ],
    });
    const c2 = createNotionConnector({ fetchImpl: second });
    const r2 = await c2.poll({ subscription: SUB_DB, credential: TOKEN, cursor: r1.nextCursor });
    expect(r2.events).toHaveLength(1);
    const id2 = r2.events[0].id;
    expect(id2).not.toBe(id1);
    expect(r2.events[0].episodeKey).toBe(r1.events[0].episodeKey);
    expect(id2).toBe(`notion:db:${DB_ID}:page-x:2026-05-20T09:00:00.000Z`);
  });
});

describe('createNotionConnector — ws: workspace search', () => {
  it('uses /v1/search and filters by canonical signal post-fetch', async () => {
    const fetchImpl = makeFetch({
      routes: [
        {
          match: matchPath('POST', '/v1/search'),
          response: {
            body: {
              results: [
                {
                  id: 'wp-1',
                  object: 'page',
                  last_edited_time: '2026-05-19T15:00:00.000Z',
                  properties: {
                    Name: { type: 'title', title: [{ plain_text: 'Settled note' }] },
                    canonical: { type: 'checkbox', checkbox: true },
                  },
                },
                {
                  id: 'wp-2',
                  object: 'page',
                  last_edited_time: '2026-05-19T14:00:00.000Z',
                  properties: {
                    Name: { type: 'title', title: [{ plain_text: 'no canonical property' }] },
                    // No `canonical` property at all — should be skipped.
                  },
                },
              ],
            },
          },
        },
        {
          match: matchPath('GET', '/v1/blocks/wp-1/children'),
          response: { body: { results: [] } },
        },
      ],
    });
    const connector = createNotionConnector({ fetchImpl });
    const result = await connector.poll({
      subscription: SUB_WS,
      credential: TOKEN,
      cursor: null,
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0].episodeKey).toBe('notion:ws:eng:wp-1');
  });

  it('drops pages older than the cursor (descending sort + post-fetch filter)', async () => {
    const fetchImpl = makeFetch({
      routes: [
        {
          match: matchPath('POST', '/v1/search'),
          response: {
            body: {
              results: [
                {
                  id: 'wp-old',
                  last_edited_time: '2026-05-10T00:00:00.000Z',
                  properties: { canonical: { type: 'checkbox', checkbox: true } },
                },
              ],
            },
          },
        },
      ],
    });
    const connector = createNotionConnector({ fetchImpl });
    const result = await connector.poll({
      subscription: SUB_WS,
      credential: TOKEN,
      cursor: { lastEditedTime: '2026-05-19T00:00:00.000Z' },
    });
    // wp-old precedes the cursor, so it's filtered out before the
    // canonical check — no event, cursor unchanged.
    expect(result.events).toHaveLength(0);
    expect(result.nextCursor.lastEditedTime).toBe('2026-05-19T00:00:00.000Z');
  });
});

describe('createNotionConnector — rate limiting', () => {
  it('throws NotionRateLimitError on 429 with Retry-After', async () => {
    const fetchImpl: FetchFn = async () =>
      new Response(JSON.stringify({ code: 'rate_limited' }), {
        status: 429,
        headers: { 'Retry-After': '30', 'content-type': 'application/json' },
      });
    const fixedNow = new Date('2026-05-21T12:00:00Z');
    const connector = createNotionConnector({ fetchImpl, now: () => fixedNow });
    await expect(
      connector.poll({ subscription: SUB_DB, credential: TOKEN, cursor: null }),
    ).rejects.toBeInstanceOf(NotionRateLimitError);
    try {
      await connector.poll({ subscription: SUB_DB, credential: TOKEN, cursor: null });
    } catch (err) {
      expect((err as NotionRateLimitError).resetAt).toEqual(
        new Date(fixedNow.getTime() + 30_000),
      );
    }
  });

  it('non-rate-limit 4xx propagates as a plain Error', async () => {
    const fetchImpl: FetchFn = async () =>
      new Response(JSON.stringify({ code: 'object_not_found' }), {
        status: 404,
        statusText: 'Not Found',
        headers: { 'content-type': 'application/json' },
      });
    const connector = createNotionConnector({ fetchImpl });
    await expect(
      connector.poll({ subscription: SUB_DB, credential: TOKEN, cursor: null }),
    ).rejects.toThrowError(/404/);
  });

  it('surfaces 401 with a clear message', async () => {
    const fetchImpl: FetchFn = async () =>
      new Response('Unauthorized', { status: 401 });
    const connector = createNotionConnector({ fetchImpl });
    await expect(
      connector.poll({ subscription: SUB_DB, credential: TOKEN, cursor: null }),
    ).rejects.toThrowError(/401/);
  });
});

describe('createNotionConnector — input guards', () => {
  it('throws when credential is null', async () => {
    const fetchImpl: FetchFn = async () => {
      throw new Error('should not be called');
    };
    const connector = createNotionConnector({ fetchImpl });
    await expect(
      connector.poll({ subscription: SUB_DB, credential: null, cursor: null }),
    ).rejects.toThrowError(/missing credential/);
  });

  it('throws on a malformed pattern', async () => {
    const fetchImpl: FetchFn = async () => {
      throw new Error('should not be called');
    };
    const connector = createNotionConnector({ fetchImpl });
    await expect(
      connector.poll({
        subscription: { ...SUB_DB, pattern: 'just-a-uuid' },
        credential: TOKEN,
        cursor: null,
      }),
    ).rejects.toThrowError(/db:.*ws:/);
  });
});

describe('createNotionConnector.verifyCredential', () => {
  it('returns ok=true on 200 /v1/users/me', async () => {
    const fetchImpl: FetchFn = async () =>
      new Response(JSON.stringify({ object: 'user', id: 'usr-1', type: 'bot' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const connector = createNotionConnector({ fetchImpl });
    const r = await connector.verifyCredential!('any-token');
    expect(r.ok).toBe(true);
  });

  it('returns ok=false on 401', async () => {
    const fetchImpl: FetchFn = async () =>
      new Response('Unauthorized', { status: 401 });
    const connector = createNotionConnector({ fetchImpl });
    const r = await connector.verifyCredential!('bad-token');
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/401/);
  });

  it('rejects an empty credential without making an HTTP call', async () => {
    let called = false;
    const fetchImpl: FetchFn = async () => {
      called = true;
      throw new Error('should not be called');
    };
    const connector = createNotionConnector({ fetchImpl });
    const r = await connector.verifyCredential!('');
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });

  it('does not echo the credential into the detail on network failure', async () => {
    const SECRET = 'secret_super_zzz_dont_leak';
    const fetchImpl: FetchFn = async () => {
      throw new Error('econnreset');
    };
    const connector = createNotionConnector({ fetchImpl });
    const r = await connector.verifyCredential!(SECRET);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it('sends Notion-Version header', async () => {
    const log: string[][] = [];
    const fetchImpl: FetchFn = async (_url, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      log.push(Object.entries(headers ?? {}).map(([k, v]) => `${k}:${v}`));
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const connector = createNotionConnector({ fetchImpl });
    await connector.verifyCredential!('tkn');
    const flat = log.flat().join('|');
    expect(flat).toMatch(/Notion-Version:/);
  });
});
