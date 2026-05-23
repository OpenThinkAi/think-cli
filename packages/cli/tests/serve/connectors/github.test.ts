import { describe, it, expect, beforeEach } from 'vitest';
import {
  createGitHubConnector,
  GitHubRateLimitError,
  bumpSinceBy1Ms,
  type FetchFn,
  type GitHubCursor,
} from '../../../src/serve/connectors/github.js';

/**
 * Unit tests for the GitHub connector (AGT-387). The connector talks to
 * GitHub via an injected `fetchImpl`, so each test plants a small URL→
 * response map and asserts on the emitted EventInputs.
 *
 * The four terminal pathways exercised here:
 *   1. PR merged          → id `:pr:N:merged`,            payload final_state='merged'
 *   2. PR closed-unmerged → id `:pr:N:closed-unmerged`,   payload final_state='closed-unmerged'
 *   3. issue closed       → id `:issue:N:closed`
 *   4. release published  → id `:release:ID:published`
 *
 * Plus: re-poll idempotency (no double-emit), rate-limit handling,
 * cursor advancement, missing-credential, malformed pattern, draft
 * release skipping.
 */

interface CannedResponse {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}

interface MockFetchOptions {
  /** Map of `METHOD path?query` → response. Path matched flexibly: caller passes a substring of the URL path (no query). */
  routes: Array<{ match: (url: string) => boolean; response: CannedResponse }>;
  /** Optional log of requested URLs for assertions. */
  log?: string[];
}

function makeFetch(opts: MockFetchOptions): FetchFn {
  return async (url) => {
    const u = typeof url === 'string' ? url : (url as URL).toString();
    opts.log?.push(u);
    const route = opts.routes.find((r) => r.match(u));
    if (!route) {
      // Surface unmatched URLs loudly so the test message points right
      // at the missing canned response. The default 404 is what a real
      // server would do, but a mock test should fail-fast on a typo.
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

const SUB = { id: 'sub-gh-1', kind: 'github', pattern: 'octo/widget' };
const TOKEN = 'ghp_test_pat_xxx';
const BASE = 'https://api.github.com';

function matchExact(pathFragment: string) {
  return (url: string) => {
    const base = BASE + pathFragment;
    return url === base || url.startsWith(base + '?');
  };
}

describe('createGitHubConnector — terminal-event emission', () => {
  it('emits one event for a closed-unmerged PR', async () => {
    const fetchImpl = makeFetch({
      routes: [
        {
          match: matchExact('/repos/octo/widget/issues'),
          response: {
            body: [
              {
                number: 42,
                title: 'Half-finished refactor',
                state: 'closed',
                state_reason: null,
                body: 'Trying a different approach',
                closed_at: '2026-05-19T12:00:00Z',
                updated_at: '2026-05-19T12:00:00Z',
                user: { login: 'alice' },
                pull_request: { url: 'https://api.github.com/repos/octo/widget/pulls/42' },
                labels: [{ name: 'wip' }],
              },
            ],
          },
        },
        {
          match: matchExact('/repos/octo/widget/pulls/42'),
          response: {
            body: {
              number: 42,
              title: 'Half-finished refactor',
              state: 'closed',
              merged: false,
              merged_at: null,
              merge_commit_sha: null,
              body: 'Trying a different approach',
              closed_at: '2026-05-19T12:00:00Z',
              updated_at: '2026-05-19T12:00:00Z',
              user: { login: 'alice' },
              requested_reviewers: [{ login: 'bob' }],
              base: { ref: 'main' },
              head: { ref: 'refactor-x', sha: 'deadbeef' },
              labels: [{ name: 'wip' }],
            },
          },
        },
        {
          match: matchExact('/repos/octo/widget/issues/42/comments'),
          response: {
            body: [
              {
                id: 1,
                user: { login: 'carol' },
                body: 'lgtm',
                created_at: '2026-05-19T11:30:00Z',
                updated_at: '2026-05-19T11:30:00Z',
              },
            ],
          },
        },
        {
          match: matchExact('/repos/octo/widget/pulls/42/reviews'),
          response: {
            body: [
              {
                id: 9,
                user: { login: 'bob' },
                state: 'CHANGES_REQUESTED',
                body: 'needs more thought',
                submitted_at: '2026-05-19T11:45:00Z',
              },
            ],
          },
        },
        {
          match: matchExact('/repos/octo/widget/releases'),
          response: { body: [] },
        },
      ],
    });

    const connector = createGitHubConnector({ fetchImpl });
    const result = await connector.poll({
      subscription: SUB,
      credential: TOKEN,
      cursor: null,
    });

    expect(result.events).toHaveLength(1);
    const evt = result.events[0];
    expect(evt.id).toBe('github:octo/widget:pr:42:closed-unmerged');
    expect(evt.episodeKey).toBe('github:octo/widget#42');
    expect(evt.terminal).toBe(true);
    // Unmerged → occurredAt falls back to closed_at (no merge moment).
    expect(evt.occurredAt).toBe('2026-05-19T12:00:00Z');
    const payload = JSON.parse(evt.payload as string) as {
      kind: string;
      final_state: string;
      merged: boolean;
      reviews: unknown[];
      comments: unknown[];
      requested_reviewers: string[];
      merge_commit_sha: string | null;
    };
    expect(payload.kind).toBe('pull_request.closed_unmerged');
    expect(payload.final_state).toBe('closed-unmerged');
    expect(payload.merged).toBe(false);
    expect(payload.merge_commit_sha).toBeNull();
    expect(payload.comments).toHaveLength(1);
    expect(payload.reviews).toHaveLength(1);
    expect(payload.requested_reviewers).toEqual(['bob']);
  });

  it('emits one event for a merged PR with the merge SHA in payload', async () => {
    const fetchImpl = makeFetch({
      routes: [
        {
          match: matchExact('/repos/octo/widget/issues'),
          response: {
            body: [
              {
                number: 101,
                title: 'Add cache layer',
                state: 'closed',
                body: 'A cache lives here now',
                closed_at: '2026-05-20T09:00:00Z',
                updated_at: '2026-05-20T09:00:00Z',
                user: { login: 'dave' },
                pull_request: { url: 'https://api.github.com/repos/octo/widget/pulls/101' },
              },
            ],
          },
        },
        {
          match: matchExact('/repos/octo/widget/pulls/101'),
          response: {
            body: {
              number: 101,
              title: 'Add cache layer',
              state: 'closed',
              merged: true,
              merged_at: '2026-05-20T09:00:00Z',
              merge_commit_sha: 'cafef00d',
              body: 'A cache lives here now',
              closed_at: '2026-05-20T09:00:00Z',
              updated_at: '2026-05-20T09:00:00Z',
              user: { login: 'dave' },
              base: { ref: 'main' },
              head: { ref: 'cache-layer', sha: 'beadface' },
            },
          },
        },
        {
          match: matchExact('/repos/octo/widget/issues/101/comments'),
          response: { body: [] },
        },
        {
          match: matchExact('/repos/octo/widget/pulls/101/reviews'),
          response: { body: [] },
        },
        {
          match: matchExact('/repos/octo/widget/releases'),
          response: { body: [] },
        },
      ],
    });

    const connector = createGitHubConnector({ fetchImpl });
    const result = await connector.poll({
      subscription: SUB,
      credential: TOKEN,
      cursor: null,
    });

    expect(result.events).toHaveLength(1);
    const evt = result.events[0];
    expect(evt.id).toBe('github:octo/widget:pr:101:merged');
    expect(evt.episodeKey).toBe('github:octo/widget#101');
    // Merged → occurredAt prefers merged_at over closed_at.
    expect(evt.occurredAt).toBe('2026-05-20T09:00:00Z');
    const payload = JSON.parse(evt.payload as string) as {
      final_state: string;
      merge_commit_sha: string;
      merged_at: string;
    };
    expect(payload.final_state).toBe('merged');
    expect(payload.merge_commit_sha).toBe('cafef00d');
    expect(payload.merged_at).toBe('2026-05-20T09:00:00Z');
  });

  it('emits one event for a closed issue', async () => {
    const fetchImpl = makeFetch({
      routes: [
        {
          match: matchExact('/repos/octo/widget/issues'),
          response: {
            body: [
              {
                number: 7,
                title: 'CRC mismatch on read',
                state: 'closed',
                state_reason: 'completed',
                body: 'Started seeing this on the staging box',
                closed_at: '2026-05-18T15:00:00Z',
                updated_at: '2026-05-18T15:00:00Z',
                user: { login: 'eve' },
                labels: [{ name: 'bug' }],
                // No `pull_request` field — this is a plain issue.
              },
            ],
          },
        },
        {
          match: matchExact('/repos/octo/widget/issues/7/comments'),
          response: {
            body: [
              {
                id: 100,
                user: { login: 'frank' },
                body: 'Repro on my box, I can take this',
                created_at: '2026-05-18T13:00:00Z',
                updated_at: '2026-05-18T13:00:00Z',
              },
              {
                id: 101,
                user: { login: 'frank' },
                body: 'Root cause was an off-by-one in the digest',
                created_at: '2026-05-18T14:50:00Z',
                updated_at: '2026-05-18T14:50:00Z',
              },
            ],
          },
        },
        {
          match: matchExact('/repos/octo/widget/releases'),
          response: { body: [] },
        },
      ],
    });

    const connector = createGitHubConnector({ fetchImpl });
    const result = await connector.poll({
      subscription: SUB,
      credential: TOKEN,
      cursor: null,
    });

    expect(result.events).toHaveLength(1);
    const evt = result.events[0];
    expect(evt.id).toBe('github:octo/widget:issue:7:closed');
    expect(evt.episodeKey).toBe('github:octo/widget#7');
    expect(evt.terminal).toBe(true);
    const payload = JSON.parse(evt.payload as string) as {
      kind: string;
      final_state: string;
      comments: unknown[];
      labels: string[];
    };
    expect(payload.kind).toBe('issue.closed');
    expect(payload.final_state).toBe('closed');
    expect(payload.comments).toHaveLength(2);
    expect(payload.labels).toEqual(['bug']);
  });

  it('marks a not-planned closed issue with final_state="closed-not-planned"', async () => {
    const fetchImpl = makeFetch({
      routes: [
        {
          match: matchExact('/repos/octo/widget/issues'),
          response: {
            body: [
              {
                number: 8,
                title: 'Add a robot uprising mode',
                state: 'closed',
                state_reason: 'not_planned',
                body: 'A clear no',
                closed_at: '2026-05-18T15:00:00Z',
                updated_at: '2026-05-18T15:00:00Z',
                user: { login: 'eve' },
              },
            ],
          },
        },
        {
          match: matchExact('/repos/octo/widget/issues/8/comments'),
          response: { body: [] },
        },
        {
          match: matchExact('/repos/octo/widget/releases'),
          response: { body: [] },
        },
      ],
    });

    const connector = createGitHubConnector({ fetchImpl });
    const result = await connector.poll({
      subscription: SUB,
      credential: TOKEN,
      cursor: null,
    });
    expect(result.events).toHaveLength(1);
    const payload = JSON.parse(result.events[0].payload as string) as {
      final_state: string;
    };
    expect(payload.final_state).toBe('closed-not-planned');
  });

  it('emits one event for a published release', async () => {
    const fetchImpl = makeFetch({
      routes: [
        {
          match: matchExact('/repos/octo/widget/issues'),
          response: { body: [] },
        },
        {
          match: matchExact('/repos/octo/widget/releases'),
          response: {
            body: [
              {
                id: 9001,
                tag_name: 'v1.2.0',
                name: 'v1.2.0',
                body: 'New features all around',
                draft: false,
                prerelease: false,
                created_at: '2026-05-21T10:00:00Z',
                published_at: '2026-05-21T10:00:00Z',
                author: { login: 'grace' },
                target_commitish: 'main',
              },
            ],
          },
        },
      ],
    });

    const connector = createGitHubConnector({ fetchImpl });
    const result = await connector.poll({
      subscription: SUB,
      credential: TOKEN,
      cursor: null,
    });

    expect(result.events).toHaveLength(1);
    const evt = result.events[0];
    expect(evt.id).toBe('github:octo/widget:release:9001:published');
    expect(evt.episodeKey).toBe('github:octo/widget@v1.2.0');
    expect(evt.terminal).toBe(true);
    const payload = JSON.parse(evt.payload as string) as {
      kind: string;
      tag: string;
      author: string;
    };
    expect(payload.kind).toBe('release.published');
    expect(payload.tag).toBe('v1.2.0');
    expect(payload.author).toBe('grace');
    // Cursor remembers the release id so a re-poll won't double-emit.
    expect(result.nextCursor.emittedReleaseIds).toContain(9001);
  });

  it('skips draft and unpublished releases', async () => {
    const fetchImpl = makeFetch({
      routes: [
        {
          match: matchExact('/repos/octo/widget/issues'),
          response: { body: [] },
        },
        {
          match: matchExact('/repos/octo/widget/releases'),
          response: {
            body: [
              {
                id: 100,
                tag_name: 'v2.0.0-rc1',
                name: 'rc1',
                body: null,
                draft: true,
                prerelease: true,
                created_at: '2026-05-21T08:00:00Z',
                published_at: null,
                author: { login: 'grace' },
              },
              {
                id: 101,
                tag_name: 'v2.0.0',
                name: null,
                body: null,
                draft: false,
                prerelease: false,
                created_at: '2026-05-21T09:00:00Z',
                published_at: null, // not yet published — still terminal-eligible no
                author: { login: 'grace' },
              },
            ],
          },
        },
      ],
    });

    const connector = createGitHubConnector({ fetchImpl });
    const result = await connector.poll({
      subscription: SUB,
      credential: TOKEN,
      cursor: null,
    });
    expect(result.events).toHaveLength(0);
  });
});

describe('createGitHubConnector — re-poll idempotency', () => {
  it('advances `issuesSince` past the newest emitted update so the next poll skips it', async () => {
    const log: string[] = [];
    const issuesResponses = [
      {
        body: [
          {
            number: 42,
            title: 'first',
            state: 'closed',
            body: 'b',
            closed_at: '2026-05-19T12:00:00Z',
            updated_at: '2026-05-19T12:00:00Z',
            user: { login: 'alice' },
          },
        ],
      },
      { body: [] }, // second poll: nothing new
    ];
    let issuesCallCount = 0;
    const fetchImpl: FetchFn = async (url) => {
      const u = typeof url === 'string' ? url : (url as URL).toString();
      log.push(u);
      if (u.startsWith(`${BASE}/repos/octo/widget/issues`) &&
          !u.includes('/issues/42')) {
        const r = issuesResponses[Math.min(issuesCallCount, issuesResponses.length - 1)];
        issuesCallCount++;
        return new Response(JSON.stringify(r.body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.startsWith(`${BASE}/repos/octo/widget/issues/42/comments`)) {
        return new Response('[]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.startsWith(`${BASE}/repos/octo/widget/releases`)) {
        return new Response('[]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unmatched: ${u}`);
    };

    const connector = createGitHubConnector({ fetchImpl });
    const r1 = await connector.poll({
      subscription: SUB,
      credential: TOKEN,
      cursor: null,
    });
    expect(r1.events).toHaveLength(1);
    expect(r1.nextCursor.issuesSince).toBeDefined();
    // 1ms past the row's updated_at to avoid GitHub's inclusive boundary.
    expect(r1.nextCursor.issuesSince).toBe('2026-05-19T12:00:00.001Z');

    const r2 = await connector.poll({
      subscription: SUB,
      credential: TOKEN,
      cursor: r1.nextCursor,
    });
    expect(r2.events).toHaveLength(0);
    // The second issues call MUST have carried the since param, so we
    // assert the URL we logged. The first call had no since.
    const issuesCalls = log.filter(
      (u) => u.startsWith(`${BASE}/repos/octo/widget/issues?`) && !u.includes('/comments'),
    );
    expect(issuesCalls).toHaveLength(2);
    expect(issuesCalls[0]).not.toContain('since=');
    expect(issuesCalls[1]).toContain('since=2026-05-19T12%3A00%3A00.001Z');
  });

  it('does not re-emit a release whose id is in the cursor', async () => {
    const fetchImpl = makeFetch({
      routes: [
        {
          match: matchExact('/repos/octo/widget/issues'),
          response: { body: [] },
        },
        {
          match: matchExact('/repos/octo/widget/releases'),
          response: {
            body: [
              {
                id: 5,
                tag_name: 'v0.5.0',
                name: 'half',
                body: null,
                draft: false,
                prerelease: false,
                created_at: '2026-05-21T10:00:00Z',
                published_at: '2026-05-21T10:00:00Z',
                author: null,
              },
            ],
          },
        },
      ],
    });
    const connector = createGitHubConnector({ fetchImpl });
    const cursor: GitHubCursor = { emittedReleaseIds: [5] };
    const result = await connector.poll({
      subscription: SUB,
      credential: TOKEN,
      cursor,
    });
    expect(result.events).toHaveLength(0);
    // The release id stays remembered so subsequent polls also skip it.
    expect(result.nextCursor.emittedReleaseIds).toContain(5);
  });

  it('caps release id memory at the configured size (FIFO)', async () => {
    // Plant a cursor with 5 ids already remembered, configure cap=3, and
    // emit 2 new ones. Result should retain the most recent 3 — older
    // ids age out, and the events-table unique index catches resurrections.
    const fetchImpl = makeFetch({
      routes: [
        {
          match: matchExact('/repos/octo/widget/issues'),
          response: { body: [] },
        },
        {
          match: matchExact('/repos/octo/widget/releases'),
          response: {
            body: [
              {
                id: 100,
                tag_name: 'v1.0.0',
                name: null,
                body: null,
                draft: false,
                prerelease: false,
                created_at: '2026-05-21T10:00:00Z',
                published_at: '2026-05-21T10:00:00Z',
                author: null,
              },
              {
                id: 101,
                tag_name: 'v1.1.0',
                name: null,
                body: null,
                draft: false,
                prerelease: false,
                created_at: '2026-05-21T11:00:00Z',
                published_at: '2026-05-21T11:00:00Z',
                author: null,
              },
            ],
          },
        },
      ],
    });
    const connector = createGitHubConnector({ fetchImpl, releaseIdMemorySize: 3 });
    const result = await connector.poll({
      subscription: SUB,
      credential: TOKEN,
      cursor: { emittedReleaseIds: [1, 2, 3, 4, 5] },
    });
    // Two new releases emitted; cap=3 means we keep the most recent 3
    // out of the merged set { 1,2,3,4,5,100,101 }.
    expect(result.events).toHaveLength(2);
    expect(result.nextCursor.emittedReleaseIds).toEqual([4, 5, 100, 101].slice(-3));
  });
});

describe('createGitHubConnector — rate limiting', () => {
  it('throws GitHubRateLimitError on 429 with Retry-After', async () => {
    const fetchImpl: FetchFn = async () =>
      new Response(JSON.stringify({ message: 'slow down' }), {
        status: 429,
        headers: { 'Retry-After': '30', 'content-type': 'application/json' },
      });
    const fixedNow = new Date('2026-05-21T12:00:00Z');
    const connector = createGitHubConnector({
      fetchImpl,
      now: () => fixedNow,
    });
    await expect(
      connector.poll({ subscription: SUB, credential: TOKEN, cursor: null }),
    ).rejects.toBeInstanceOf(GitHubRateLimitError);
    try {
      await connector.poll({ subscription: SUB, credential: TOKEN, cursor: null });
    } catch (err) {
      expect((err as GitHubRateLimitError).resetAt).toEqual(
        new Date(fixedNow.getTime() + 30_000),
      );
    }
  });

  it('throws GitHubRateLimitError on 403 + X-RateLimit-Remaining=0', async () => {
    const reset = Math.floor(new Date('2026-05-21T13:00:00Z').getTime() / 1000);
    const fetchImpl: FetchFn = async () =>
      new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
        status: 403,
        headers: {
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(reset),
          'content-type': 'application/json',
        },
      });
    const connector = createGitHubConnector({ fetchImpl });
    await expect(
      connector.poll({ subscription: SUB, credential: TOKEN, cursor: null }),
    ).rejects.toBeInstanceOf(GitHubRateLimitError);
  });

  it('non-rate-limit 4xx propagates as a plain Error (not GitHubRateLimitError)', async () => {
    const fetchImpl: FetchFn = async () =>
      new Response(JSON.stringify({ message: 'Not found' }), {
        status: 404,
        statusText: 'Not Found',
        headers: { 'content-type': 'application/json' },
      });
    const connector = createGitHubConnector({ fetchImpl });
    await expect(
      connector.poll({ subscription: SUB, credential: TOKEN, cursor: null }),
    ).rejects.toThrowError(/404/);
  });

  it('logs a warning when rate-limit remaining is low but does not throw', async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: unknown) => warnings.push(String(msg));
    try {
      const fetchImpl: FetchFn = async () =>
        new Response('[]', {
          status: 200,
          headers: {
            'X-RateLimit-Remaining': '5',
            'content-type': 'application/json',
          },
        });
      const connector = createGitHubConnector({ fetchImpl });
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
});

describe('createGitHubConnector — input guards', () => {
  it('throws when credential is null', async () => {
    const fetchImpl: FetchFn = async () => {
      throw new Error('should not be called');
    };
    const connector = createGitHubConnector({ fetchImpl });
    await expect(
      connector.poll({ subscription: SUB, credential: null, cursor: null }),
    ).rejects.toThrowError(/missing credential/);
  });

  it('throws on a malformed pattern', async () => {
    const fetchImpl: FetchFn = async () => {
      throw new Error('should not be called');
    };
    const connector = createGitHubConnector({ fetchImpl });
    await expect(
      connector.poll({
        subscription: { ...SUB, pattern: 'not a real pattern' },
        credential: TOKEN,
        cursor: null,
      }),
    ).rejects.toThrowError(/<owner>\/<repo>/);
  });
});

describe('createGitHubConnector.verifyCredential', () => {
  it('returns ok=true on 200 /user', async () => {
    const fetchImpl: FetchFn = async () =>
      new Response(JSON.stringify({ login: 'alice' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const connector = createGitHubConnector({ fetchImpl });
    const r = await connector.verifyCredential!('any-pat');
    expect(r.ok).toBe(true);
  });

  it('returns ok=false on 401 /user', async () => {
    const fetchImpl: FetchFn = async () =>
      new Response('Unauthorized', { status: 401 });
    const connector = createGitHubConnector({ fetchImpl });
    const r = await connector.verifyCredential!('bad-pat');
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/401/);
  });

  it('rejects an empty credential without making an HTTP call', async () => {
    let called = false;
    const fetchImpl: FetchFn = async () => {
      called = true;
      throw new Error('should not be called');
    };
    const connector = createGitHubConnector({ fetchImpl });
    const r = await connector.verifyCredential!('');
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });

  it('does not echo the credential into the detail on network failure', async () => {
    const SECRET = 'ghp_super_secret_pat_zzz';
    const fetchImpl: FetchFn = async () => {
      throw new Error('econnreset');
    };
    const connector = createGitHubConnector({ fetchImpl });
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

  it('passes through unparseable input unchanged (no throw)', () => {
    expect(bumpSinceBy1Ms('not-a-date')).toBe('not-a-date');
  });
});
