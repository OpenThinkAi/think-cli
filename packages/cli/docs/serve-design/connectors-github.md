# GitHub connector — design sketch

**Status**: design only. There is no live GitHub connector in `0.4.0`. The
real implementation lands in AGT-029+ alongside credential storage at
`packages/cli/src/serve/connectors/github.ts` and will register itself in
`connectors/registry.ts`. Today this markdown is the only artifact —
`mock.ts` already implements `SourceConnector` so tsc enforces the
interface contract without a placeholder file.

## Why GitHub got the pressure-test slot

When `SourceConnector` was being designed, GitHub was picked deliberately
as the "design-against" target because it pushes on every dimension a
real-world source has:

- **Conditional GET**: ETag + `If-None-Match` and `Last-Modified` +
  `If-Modified-Since`, on a per-endpoint basis.
- **Rate limits**: a primary budget exposed via `X-RateLimit-Remaining` /
  `X-RateLimit-Reset`, and a secondary `429 Too Many Requests` with
  `Retry-After`. Both are per-credential, not per-process.
- **Multiple endpoints per subscription**: a single subscription can
  legitimately need to hit `/notifications` *and* one or more per-repo
  `/repos/{owner}/{repo}/events` feeds in a single poll cycle.

If `SourceConnector` can't express those without contortion, the
abstraction is wrong — better to learn that before the framework freezes
than after the second connector ships.

## Cursor shape — per-endpoint, not flat

GitHub's cursor is necessarily a per-endpoint map:

```ts
interface GitHubEndpointCursor {
  etag?: string;
  lastModified?: string;
  /** ISO8601 timestamp passed as `?since=` for endpoints that support it. */
  since?: string;
}

interface GitHubCursor {
  /** Keyed by full path including query (e.g. `/notifications?all=true`). */
  endpoints: Record<string, GitHubEndpointCursor>;
}
```

A flat `{ etag, lastModified, since }` for the whole subscription would
either lose precision (one endpoint's 304 forces another endpoint into a
redundant full fetch) or invalidate everything when any single endpoint
changes. Per-endpoint state avoids both, and the framework cooperates by
treating `nextCursor` as opaque JSON it persists verbatim.

## Rate-limit signalling — typed error, scheduler decides

The connector throws a typed error rather than returning a sentinel:

```ts
class RateLimitedError extends Error {
  readonly resetAt: Date;
  constructor(resetAt: Date) {
    super(`github rate-limited until ${resetAt.toISOString()}`);
    this.name = 'RateLimitedError';
    this.resetAt = resetAt;
  }
}
```

The scheduler's per-poll error branch already logs and isolates failures
without touching `last_polled_at`, so a rate-limit is just another
fail-fast. v0.4.0 retries on the next tick; a future scheduler can read
`resetAt` and skip the subscription until then. The framework does not
need to know what `RateLimitedError` is — it only needs the failure
isolation it already has.

## Endpoints fan-out

A subscription's `pattern` parses into a list of paths to poll inside one
`poll()` call:

```ts
function endpointsFor(pattern: string): string[] {
  const endpoints: string[] = ['/notifications?all=true'];
  if (/^[\w.-]+\/[\w.-]+$/.test(pattern)) {
    endpoints.push(`/repos/${pattern}/events`);
  }
  return endpoints;
}
```

Real impl will likely want this configurable per-subscription rather than
inferred from `pattern`. The shape that matters here is "one subscription
can fan out to N HTTP requests inside a single `poll()` and still produce
one merged `{ events, nextCursor }` result." The framework doesn't need
to change to support that.

## End-to-end pseudocode

The full `poll()` body, kept in pseudocode so we don't need to pull
`fetch` / `octokit` into the design doc to demonstrate that the interface
holds:

```ts
async poll(ctx: PollContext<GitHubCursor>): Promise<PollResult<GitHubCursor>> {
  const token = ctx.credential;
  if (!token) throw new Error('github connector requires a credential');
  // TODO(AGT-029): consume vault-decrypted PAT from ctx.credential

  const cursor: GitHubCursor = ctx.cursor ?? { endpoints: {} };
  const events: EventInput[] = [];
  const nextCursor: GitHubCursor = { endpoints: { ...cursor.endpoints } };

  for (const path of endpointsFor(ctx.subscription.pattern)) {
    const prev = cursor.endpoints[path] ?? {};
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'open-think-server',
    };
    if (prev.etag) headers['If-None-Match'] = prev.etag;
    if (prev.lastModified) headers['If-Modified-Since'] = prev.lastModified;

    const url = prev.since
      ? `https://api.github.com${path}${path.includes('?') ? '&' : '?'}since=${encodeURIComponent(prev.since)}`
      : `https://api.github.com${path}`;

    const res = await fetch(url, { headers });

    // Rate-limit branches.
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('Retry-After') ?? '60');
      throw new RateLimitedError(new Date(Date.now() + retryAfter * 1000));
    }
    if (res.headers.get('X-RateLimit-Remaining') === '0') {
      const reset = Number(res.headers.get('X-RateLimit-Reset') ?? '0');
      throw new RateLimitedError(new Date(reset * 1000));
    }

    // 304 → no new events for this endpoint, retain its cursor as-is.
    if (res.status === 304) continue;

    // 2xx → record updated conditional-GET headers.
    const next: GitHubEndpointCursor = {
      etag: res.headers.get('ETag') ?? prev.etag,
      lastModified: res.headers.get('Last-Modified') ?? prev.lastModified,
      since: new Date().toISOString(),
    };
    nextCursor.endpoints[path] = next;

    const items = (await res.json()) as Array<{ id: string }>;
    for (const item of items) {
      events.push({ id: `${path}#${item.id}`, payload: item });
    }
  }

  return { events, nextCursor };
}
```

The pseudocode proves four things about the framework contract:

1. **Opaque `nextCursor` accommodates a per-endpoint map.** No framework
   change needed for richer cursor shapes.
2. **`RateLimitedError` exits via the framework's failure-isolation
   branch.** The connector throws, the scheduler logs the outcome, other
   subscriptions in the same tick keep polling.
3. **304 maps cleanly to `{ events: [], nextCursor: ... }`.** A
   "successful poll that produced no new events" is the same shape as a
   normal poll that happened to have an empty result.
4. **`endpointsFor()` proves we can fan a single subscription out to
   multiple HTTP requests inside one `poll()` call** without the
   framework needing to know.

## Turning the draft into a real connector

When AGT-029 is ready to ship the live GitHub connector:

1. Implement the `poll()` body per the pseudocode above (or the evolved
   version of it).
2. Create `src/connectors/github.ts` — there is no draft skeleton to
   replace; this design doc is the only forward-looking artifact today.
3. Import + register in `connectors/registry.ts`.
4. Add a `tests/connectors/github.test.ts` with `nock` or `msw` covering
   conditional-GET, rate-limit, and the multi-endpoint fan-out.
5. Wire credential lookup once the credential store from AGT-029 lands —
   `ctx.credential` is already plumbed through `PollContext`.
