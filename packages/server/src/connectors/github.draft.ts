// =============================================================================
// DRAFT — design pressure test for the SourceConnector interface.
// NOT registered, NOT shipped, NOT tested. Does not call out to GitHub.
//
// Purpose: encode the rate-limit, ETag/If-None-Match, and multi-endpoint
// shape GitHub demands, and verify the SourceConnector interface in
// connectors/types.ts can express them without contortion. If a real-world
// connector can't fit the interface, the interface needs to change BEFORE
// the framework freezes — not after the second connector ships.
//
// To turn this into a real connector (AGT-029+):
//   - implement the marked `// TODO` blocks
//   - import + register in connectors/registry.ts
//   - add a tests/connectors/github.test.ts with nock or msw
//   - flip the file rename: github.draft.ts → github.ts
// =============================================================================

import type { PollContext, PollResult, SourceConnector } from './types.js';

/**
 * GitHub's cursor is necessarily a per-endpoint map. `/notifications`,
 * each `/repos/{owner}/{repo}/events`, and any other endpoint a single
 * subscription wants to track each have their own ETag + Last-Modified +
 * `since` parameter — they are independent conditional-GET state machines.
 *
 * Storing one flat `{ etag, lastModified, since }` for the whole
 * subscription would either lose precision (one endpoint's 304 forces
 * another endpoint into a redundant full fetch) or invalidate everything
 * on any single endpoint change. Per-endpoint state avoids both.
 */
export interface GitHubEndpointCursor {
  etag?: string;
  lastModified?: string;
  /** ISO8601 timestamp passed as `?since=` for endpoints that support it. */
  since?: string;
}

export interface GitHubCursor {
  /** Keyed by full path including query (e.g. `/notifications?all=true`). */
  endpoints: Record<string, GitHubEndpointCursor>;
}

/**
 * Thrown when GitHub returns `X-RateLimit-Remaining: 0` (primary) or
 * `429 Too Many Requests` (secondary). The scheduler logs and skips the
 * subscription for this tick — `resetAt` lets a future scheduler avoid
 * polling again until the limit resets, but v0.4.0 just retries on the
 * next tick.
 */
export class RateLimitedError extends Error {
  readonly resetAt: Date;
  constructor(resetAt: Date) {
    super(`github rate-limited until ${resetAt.toISOString()}`);
    this.name = 'RateLimitedError';
    this.resetAt = resetAt;
  }
}

/**
 * Endpoints to poll for one subscription. v1 sketch covers the two most
 * useful: the user's notifications stream and one user-supplied per-repo
 * events feed (parsed out of `subscription.pattern`, e.g. `"owner/repo"`).
 * Real impl will likely want this to be configurable per-subscription.
 */
function endpointsFor(pattern: string): string[] {
  const endpoints: string[] = ['/notifications?all=true'];
  if (/^[\w.-]+\/[\w.-]+$/.test(pattern)) {
    endpoints.push(`/repos/${pattern}/events`);
  }
  return endpoints;
}

export const githubConnectorDraft: SourceConnector<GitHubCursor> = {
  kind: 'github',
  async poll(_ctx: PollContext<GitHubCursor>): Promise<PollResult<GitHubCursor>> {
    // -------------------------------------------------------------------
    // Pseudocode — kept as comments so this file compiles without pulling
    // in fetch/octokit while still pressure-testing the interface shape.
    //
    //   const token = ctx.credential;
    //   if (!token) throw new Error('github connector requires a credential');
    //   // TODO(AGT-029): consume vault-decrypted PAT from ctx.credential
    //
    //   const cursor: GitHubCursor = ctx.cursor ?? { endpoints: {} };
    //   const events: EventInput[] = [];
    //   const nextCursor: GitHubCursor = { endpoints: { ...cursor.endpoints } };
    //
    //   for (const path of endpointsFor(ctx.subscription.pattern)) {
    //     const prev = cursor.endpoints[path] ?? {};
    //     const headers: Record<string, string> = {
    //       Authorization: `Bearer ${token}`,
    //       Accept: 'application/vnd.github+json',
    //       'User-Agent': 'open-think-server',
    //     };
    //     if (prev.etag) headers['If-None-Match'] = prev.etag;
    //     if (prev.lastModified) headers['If-Modified-Since'] = prev.lastModified;
    //
    //     const url = prev.since
    //       ? `https://api.github.com${path}${path.includes('?') ? '&' : '?'}since=${encodeURIComponent(prev.since)}`
    //       : `https://api.github.com${path}`;
    //
    //     const res = await fetch(url, { headers });
    //
    //     // Rate-limit branches.
    //     if (res.status === 429) {
    //       const retryAfter = Number(res.headers.get('Retry-After') ?? '60');
    //       throw new RateLimitedError(new Date(Date.now() + retryAfter * 1000));
    //     }
    //     if (res.headers.get('X-RateLimit-Remaining') === '0') {
    //       const reset = Number(res.headers.get('X-RateLimit-Reset') ?? '0');
    //       throw new RateLimitedError(new Date(reset * 1000));
    //     }
    //
    //     // 304 → no new events for this endpoint, retain its cursor as-is.
    //     if (res.status === 304) continue;
    //
    //     // 2xx → record updated conditional-GET headers.
    //     const next: GitHubEndpointCursor = {
    //       etag: res.headers.get('ETag') ?? prev.etag,
    //       lastModified: res.headers.get('Last-Modified') ?? prev.lastModified,
    //       since: new Date().toISOString(),
    //     };
    //     nextCursor.endpoints[path] = next;
    //
    //     const items = (await res.json()) as Array<{ id: string }>;
    //     for (const item of items) {
    //       events.push({ id: `${path}#${item.id}`, payload: item });
    //     }
    //   }
    //
    //   return { events, nextCursor };
    //
    // The shape above proves the interface holds:
    //   - opaque `nextCursor` accommodates a per-endpoint map
    //   - `RateLimitedError` exits via the framework's failure-isolation
    //     branch — connector throws, scheduler logs, other subs proceed
    //   - 304 maps cleanly to `{ events: [], nextCursor: ... }`
    //   - `endpointsFor()` proves we can fan a single subscription out to
    //     multiple HTTP requests inside one `poll()` call
    // -------------------------------------------------------------------
    void endpointsFor;
    throw new Error('github.draft.ts is not registered — design sketch only');
  },
};
