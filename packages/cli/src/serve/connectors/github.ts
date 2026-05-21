import type {
  EventInput,
  PollContext,
  PollResult,
  SourceConnector,
  VerifyCredentialResult,
} from './types.js';

/**
 * GitHub source connector (AGT-387). Emits **only terminal events**:
 *
 *   - PR merged                → `github:<owner>/<repo>#<number>`
 *   - PR closed-unmerged       → `github:<owner>/<repo>#<number>`
 *   - issue closed             → `github:<owner>/<repo>#<number>`
 *   - release published        → `github:<owner>/<repo>@<tag>`
 *
 * Subscription pattern is `<owner>/<repo>` — one connector instance polls
 * many repos because the framework hands the pattern in via `PollContext`.
 *
 * Credentials are PATs read from `ctx.credential` (decrypted by the vault).
 * The connector throws on missing credential — the scheduler's per-poll
 * error branch isolates the failure.
 *
 * Cursor strategy
 * ---------------
 * `since` parameter on GitHub's `/issues` endpoint returns rows whose
 * `updated_at` is greater than or equal to the timestamp. We bound the
 * window by tracking the most recent `updated_at` we've seen and feeding
 * it back in on the next tick. The `events_sub_id_unique` index in the
 * proxy schema catches any boundary-case re-emissions (issues updated at
 * the same second we just polled). Releases use an `emittedIds` set
 * because the `/releases` endpoint has no `since` filter — the
 * release-publication event is identified by release id.
 *
 * Rate limiting
 * -------------
 * 429 or `X-RateLimit-Remaining: 0` → throw `GitHubRateLimitError`. The
 * scheduler catches it and records an `error` outcome without bumping
 * `last_polled_at`; the next tick retries. Low-but-nonzero remaining
 * (`< 100`) logs a warning. No crash.
 *
 * Episode key vs event id
 * -----------------------
 * `episodeKey` groups sibling memories under one source artifact (e.g.
 * the issue itself). `id` is per-emission and deterministic so re-polls
 * `INSERT OR IGNORE` against the existing row: `github:<owner>/<repo>:
 * pr:<n>:merged`, `:pr:<n>:closed-unmerged`, `:issue:<n>:closed`,
 * `:release:<id>:published`.
 *
 * Tests pass a `fetchImpl` and `now` to make HTTP and time injectable
 * without spinning up a real GitHub.
 */

export interface GitHubCursor {
  /**
   * `updated_at` of the newest issue/PR we've already considered, ISO8601.
   * Passed verbatim as `since=` on the next poll. We bump it *after* a
   * successful poll completes, even if the items were already-emitted —
   * a re-emission via the unique index is harmless but a re-fetch is
   * wasteful.
   */
  issuesSince?: string;
  /**
   * Set of release ids the connector has already emitted. The releases
   * endpoint doesn't accept `since`, so we track by id. Capped at 200
   * entries (FIFO) to avoid unbounded growth on very release-heavy
   * repos; older releases that fall out of the window are caught by the
   * proxy's events unique index on the next re-emission.
   */
  emittedReleaseIds?: number[];
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface CreateGitHubConnectorOptions {
  /**
   * HTTP impl. Defaults to global `fetch`. Tests inject a stub that
   * returns canned responses keyed by URL.
   */
  fetchImpl?: FetchFn;
  /** Base URL override for tests. Defaults to `https://api.github.com`. */
  baseUrl?: string;
  /** Clock seam for tests; defaults to `() => new Date()`. */
  now?: () => Date;
  /**
   * Maximum number of release ids retained in the cursor. The connector
   * tolerates duplicates anyway (the events index dedups), so this is
   * just a cap on cursor JSON size.
   */
  releaseIdMemorySize?: number;
}

export class GitHubRateLimitError extends Error {
  readonly resetAt: Date;
  constructor(resetAt: Date) {
    super(`github rate-limited until ${resetAt.toISOString()}`);
    this.name = 'GitHubRateLimitError';
    this.resetAt = resetAt;
  }
}

interface GitHubUser {
  login: string;
}

interface GitHubIssueListItem {
  number: number;
  title: string;
  state: 'open' | 'closed';
  state_reason?: string | null;
  body?: string | null;
  closed_at: string | null;
  updated_at: string;
  user?: GitHubUser | null;
  pull_request?: { url?: string } | null;
  labels?: Array<{ name: string }>;
}

interface GitHubPullDetail extends GitHubIssueListItem {
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  requested_reviewers?: GitHubUser[];
  base?: { ref: string };
  head?: { ref: string; sha: string };
}

interface GitHubComment {
  id: number;
  user: GitHubUser | null;
  body: string;
  created_at: string;
  updated_at: string;
}

interface GitHubReview {
  id: number;
  user: GitHubUser | null;
  state: string;
  body: string | null;
  submitted_at: string | null;
}

interface GitHubRelease {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  created_at: string;
  published_at: string | null;
  author: GitHubUser | null;
  target_commitish?: string;
}

interface ParsedPattern {
  owner: string;
  repo: string;
}

const DEFAULT_BASE_URL = 'https://api.github.com';
const DEFAULT_RELEASE_MEMORY = 200;
const RATE_LIMIT_WARN_THRESHOLD = 100;

function parsePattern(pattern: string): ParsedPattern {
  const trimmed = pattern.trim();
  const match = /^([\w.-]+)\/([\w.-]+)$/.exec(trimmed);
  if (!match) {
    throw new Error(
      `github connector: pattern must be "<owner>/<repo>", got ${JSON.stringify(pattern)}`,
    );
  }
  return { owner: match[1], repo: match[2] };
}

function maxIso(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

export function createGitHubConnector(
  opts: CreateGitHubConnectorOptions = {},
): SourceConnector<GitHubCursor> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const now = opts.now ?? (() => new Date());
  const releaseMemorySize = opts.releaseIdMemorySize ?? DEFAULT_RELEASE_MEMORY;
  // Defer the global-fetch lookup to call time so test environments that
  // patch globalThis.fetch after this module loads still get picked up.
  const fetchImpl: FetchFn = opts.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));

  async function ghFetch(
    token: string,
    path: string,
    extra?: { query?: Record<string, string>; expectArray?: boolean },
  ): Promise<unknown> {
    const url = new URL(baseUrl + path);
    if (extra?.query) {
      for (const [k, v] of Object.entries(extra.query)) {
        url.searchParams.set(k, v);
      }
    }
    const res = await fetchImpl(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'open-think-server',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    // Hard rate-limit branches. Throw a typed error so the scheduler's
    // per-poll error branch reports it without bumping last_polled_at.
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('Retry-After') ?? '60');
      throw new GitHubRateLimitError(new Date(now().getTime() + retryAfter * 1000));
    }
    if (res.status === 403) {
      const remaining = res.headers.get('X-RateLimit-Remaining');
      if (remaining === '0') {
        const reset = Number(res.headers.get('X-RateLimit-Reset') ?? '0');
        throw new GitHubRateLimitError(new Date(reset * 1000));
      }
      throw new Error(`github ${path}: 403 forbidden (PAT may lack required scope)`);
    }
    if (!res.ok) {
      throw new Error(`github ${path}: ${res.status} ${res.statusText}`);
    }

    // Soft warning when budget is running low.
    const remainingHeader = res.headers.get('X-RateLimit-Remaining');
    if (remainingHeader !== null) {
      const remaining = Number(remainingHeader);
      if (Number.isFinite(remaining) && remaining > 0 && remaining < RATE_LIMIT_WARN_THRESHOLD) {
        console.warn(
          `[open-think serve] github rate limit low: ${remaining} remaining (path=${path})`,
        );
      }
    }

    return await res.json();
  }

  async function listClosedIssues(
    token: string,
    p: ParsedPattern,
    since: string | undefined,
  ): Promise<GitHubIssueListItem[]> {
    // TODO(pagination): Single-page fetch (per_page=100, no Link-header loop).
    // For repos that close >100 items between poll ticks the tail is silently
    // deferred to the next tick (the `since` cursor advances past page 1's
    // newest, so older items beyond position 100 are not re-fetched). Acceptable
    // for low-volume repos; revisit when we add a connector for a busier source.
    const query: Record<string, string> = {
      state: 'closed',
      sort: 'updated',
      direction: 'asc',
      per_page: '100',
      filter: 'all',
    };
    if (since) query.since = since;
    const json = (await ghFetch(token, `/repos/${p.owner}/${p.repo}/issues`, {
      query,
    })) as GitHubIssueListItem[];
    return Array.isArray(json) ? json : [];
  }

  async function getPullDetail(
    token: string,
    p: ParsedPattern,
    number: number,
  ): Promise<GitHubPullDetail> {
    return (await ghFetch(token, `/repos/${p.owner}/${p.repo}/pulls/${number}`)) as GitHubPullDetail;
  }

  async function listIssueComments(
    token: string,
    p: ParsedPattern,
    number: number,
  ): Promise<GitHubComment[]> {
    const json = (await ghFetch(token, `/repos/${p.owner}/${p.repo}/issues/${number}/comments`, {
      query: { per_page: '100' },
    })) as GitHubComment[];
    return Array.isArray(json) ? json : [];
  }

  async function listPullReviews(
    token: string,
    p: ParsedPattern,
    number: number,
  ): Promise<GitHubReview[]> {
    const json = (await ghFetch(token, `/repos/${p.owner}/${p.repo}/pulls/${number}/reviews`, {
      query: { per_page: '100' },
    })) as GitHubReview[];
    return Array.isArray(json) ? json : [];
  }

  async function listReleases(
    token: string,
    p: ParsedPattern,
  ): Promise<GitHubRelease[]> {
    // TODO(pagination): Same single-page caveat as listClosedIssues. Releases
    // have no `since` parameter; we dedupe via the emitted-id set instead. A
    // repo that publishes >100 releases between ticks loses the tail until a
    // future poll picks it up via re-emission (rare in practice for releases).
    const json = (await ghFetch(token, `/repos/${p.owner}/${p.repo}/releases`, {
      query: { per_page: '100' },
    })) as GitHubRelease[];
    return Array.isArray(json) ? json : [];
  }

  function shapeComment(c: GitHubComment) {
    return {
      id: c.id,
      author: c.user?.login ?? null,
      body: c.body,
      created_at: c.created_at,
      updated_at: c.updated_at,
    };
  }

  function shapeReview(r: GitHubReview) {
    return {
      id: r.id,
      author: r.user?.login ?? null,
      state: r.state,
      body: r.body,
      submitted_at: r.submitted_at,
    };
  }

  async function emitForClosedIssue(
    token: string,
    p: ParsedPattern,
    item: GitHubIssueListItem,
  ): Promise<EventInput | null> {
    // Skip the rare case of a row that came back from /issues?state=closed
    // without a closed_at — defensively treat as non-terminal.
    if (!item.closed_at) return null;
    const comments = await listIssueComments(token, p, item.number);
    return {
      id: `github:${p.owner}/${p.repo}:issue:${item.number}:closed`,
      episodeKey: `github:${p.owner}/${p.repo}#${item.number}`,
      terminal: true,
      payload: JSON.stringify({
        kind: 'issue.closed',
        repo: `${p.owner}/${p.repo}`,
        number: item.number,
        title: item.title,
        body: item.body ?? null,
        author: item.user?.login ?? null,
        state: item.state,
        state_reason: item.state_reason ?? null,
        labels: (item.labels ?? []).map((l) => l.name),
        closed_at: item.closed_at,
        updated_at: item.updated_at,
        final_state: item.state_reason === 'not_planned' ? 'closed-not-planned' : 'closed',
        comments: comments.map(shapeComment),
      }),
    };
  }

  async function emitForClosedPull(
    token: string,
    p: ParsedPattern,
    item: GitHubIssueListItem,
  ): Promise<EventInput | null> {
    const detail = await getPullDetail(token, p, item.number);
    const [comments, reviews] = await Promise.all([
      listIssueComments(token, p, item.number),
      listPullReviews(token, p, item.number),
    ]);
    const merged = detail.merged === true;
    const suffix = merged ? 'merged' : 'closed-unmerged';
    return {
      id: `github:${p.owner}/${p.repo}:pr:${item.number}:${suffix}`,
      episodeKey: `github:${p.owner}/${p.repo}#${item.number}`,
      terminal: true,
      payload: JSON.stringify({
        kind: merged ? 'pull_request.merged' : 'pull_request.closed_unmerged',
        repo: `${p.owner}/${p.repo}`,
        number: item.number,
        title: detail.title,
        body: detail.body ?? null,
        author: detail.user?.login ?? null,
        state: detail.state,
        merged,
        merged_at: detail.merged_at,
        merge_commit_sha: detail.merge_commit_sha,
        base_ref: detail.base?.ref ?? null,
        head_ref: detail.head?.ref ?? null,
        head_sha: detail.head?.sha ?? null,
        labels: (detail.labels ?? []).map((l) => l.name),
        requested_reviewers: (detail.requested_reviewers ?? []).map((r) => r.login),
        closed_at: detail.closed_at,
        updated_at: detail.updated_at,
        final_state: merged ? 'merged' : 'closed-unmerged',
        comments: comments.map(shapeComment),
        reviews: reviews.map(shapeReview),
      }),
    };
  }

  function emitForPublishedRelease(
    p: ParsedPattern,
    release: GitHubRelease,
  ): EventInput {
    return {
      id: `github:${p.owner}/${p.repo}:release:${release.id}:published`,
      episodeKey: `github:${p.owner}/${p.repo}@${release.tag_name}`,
      terminal: true,
      payload: JSON.stringify({
        kind: 'release.published',
        repo: `${p.owner}/${p.repo}`,
        release_id: release.id,
        tag: release.tag_name,
        name: release.name,
        body: release.body,
        author: release.author?.login ?? null,
        prerelease: release.prerelease,
        target_commitish: release.target_commitish ?? null,
        created_at: release.created_at,
        published_at: release.published_at,
        final_state: 'published',
      }),
    };
  }

  async function poll(
    ctx: PollContext<GitHubCursor>,
  ): Promise<PollResult<GitHubCursor>> {
    if (!ctx.credential) {
      // The vault returned null — no PAT stored for this subscription.
      // Throw rather than silently no-op so the operator gets an
      // actionable error in `outcomes`.
      throw new Error('github connector: missing credential (store a PAT via vault)');
    }
    const pattern = parsePattern(ctx.subscription.pattern);
    const token = ctx.credential;

    const events: EventInput[] = [];
    const cursorIn = ctx.cursor ?? {};
    let issuesSince = cursorIn.issuesSince;
    const releaseIdSet = new Set(cursorIn.emittedReleaseIds ?? []);

    // --- Issues + PRs ---------------------------------------------------
    // GitHub's `/issues` endpoint returns both issues AND PRs (PRs are a
    // superset of issues in GH's data model). We filter to closed ones
    // and dispatch on the presence of `pull_request` for shape.
    const closedItems = await listClosedIssues(token, pattern, issuesSince);
    for (const item of closedItems) {
      // Defensive guard — only closed items have a closed_at, but a row
      // that flipped open→closed→open between list and read could lack
      // one. Skip rather than emit a malformed event.
      if (item.state !== 'closed' || !item.closed_at) continue;

      const isPR = !!item.pull_request;
      const evt = isPR
        ? await emitForClosedPull(token, pattern, item)
        : await emitForClosedIssue(token, pattern, item);
      if (evt) events.push(evt);
      issuesSince = maxIso(issuesSince, item.updated_at);
    }

    // --- Releases -------------------------------------------------------
    // No `since` filter on /releases. We list and filter by id-set
    // membership. Draft releases are non-terminal (still being edited),
    // so we skip them; the moment they publish, `published_at` flips
    // and they show up on a subsequent poll.
    const releases = await listReleases(token, pattern);
    const newlyEmittedIds: number[] = [];
    for (const r of releases) {
      if (r.draft) continue;
      if (!r.published_at) continue; // not yet published
      if (releaseIdSet.has(r.id)) continue;
      events.push(emitForPublishedRelease(pattern, r));
      releaseIdSet.add(r.id);
      newlyEmittedIds.push(r.id);
    }

    // Cap the id memory. Keep the most recent N — releases come back
    // newest-first, so we prefer recent ids. The dedup floor below the
    // window is `events_sub_id_unique`, which will silently drop any
    // resurrected re-emission.
    const allReleaseIds = [...releaseIdSet];
    const trimmedReleaseIds = allReleaseIds.slice(
      Math.max(0, allReleaseIds.length - releaseMemorySize),
    );

    // Advance issuesSince by 1ms past the newest we just considered, so
    // GitHub's inclusive `since=` doesn't re-return the same row on the
    // next tick. The 1ms bump is per AGT-387 design: dedup via the unique
    // index *would* catch a re-fetch, but the API call itself is wasteful.
    const nextIssuesSince = bumpSinceBy1Ms(issuesSince);

    return {
      events,
      nextCursor: {
        ...(nextIssuesSince !== undefined ? { issuesSince: nextIssuesSince } : {}),
        emittedReleaseIds: trimmedReleaseIds,
      },
    };
  }

  async function verifyCredential(credential: string): Promise<VerifyCredentialResult> {
    // Probe `/user` — cheapest authenticated endpoint. 200 → ok, 401 →
    // bad token, anything else → uncertain but surfaceable.
    if (credential.length === 0) {
      return { ok: false, detail: 'github requires a non-empty PAT' };
    }
    try {
      const res = await fetchImpl(`${baseUrl}/user`, {
        headers: {
          Authorization: `Bearer ${credential}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'open-think-server',
        },
      });
      if (res.status === 200) return { ok: true };
      if (res.status === 401) return { ok: false, detail: 'github 401: invalid PAT' };
      return { ok: false, detail: `github ${res.status}` };
    } catch (err) {
      // Don't echo the credential — surface only the underlying error
      // message. The no-leak audit test guards this at the route layer
      // but defense-in-depth here too.
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, detail: `github verify failed: ${message}` };
    }
  }

  return {
    kind: 'github',
    poll,
    verifyCredential,
  };
}

/**
 * Add 1 millisecond to an ISO8601 timestamp so a `since=` re-poll doesn't
 * re-return the boundary row. Returns undefined if input is undefined.
 *
 * Exported for tests; the boundary math is the kind of off-by-one that
 * silently inflates API quota usage and is worth pinning explicitly.
 */
export function bumpSinceBy1Ms(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso; // malformed — pass through unchanged
  return new Date(t + 1).toISOString();
}
