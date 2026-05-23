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
 * Cursor strategy (AGT-409)
 * -------------------------
 * Issues/PRs are fetched with `sort=updated&direction=asc&since=<cursor>`,
 * a monotonic ascending-by-`updated_at` stream. Within a tick we walk
 * `Link: rel="next"` pages until one of: the last page, a per-tick page
 * cap (`maxListPagesPerTick`), or `X-RateLimit-Remaining` dropping below a
 * floor (`rateLimitFloor`). After processing the consumed prefix we
 * advance the cursor to the max `updated_at` seen.
 *
 * The cursor bump is conditional, and that is the crux of the no-skip
 * guarantee. GitHub's `updated_at` and `since` are *second*-granularity:
 *   - **Fully drained** (reached the last page AND enriched every item):
 *     advance `since` to `max(updated_at) + 1ms` so the inclusive `since`
 *     boundary row isn't re-fetched next tick. Safe — nothing remains at
 *     or below that second.
 *   - **Stopped early** (page/rate budget, or a rate-limit mid-walk):
 *     advance `since` to `max(updated_at)` with **no** bump, so the next
 *     tick re-includes that boundary second and items sharing it that fell
 *     past the cutoff are not skipped. The `events_sub_id_unique` index
 *     dedups the harmless re-emission. A naive +1ms here would skip the
 *     overflow of any second straddling a page/budget boundary — the one
 *     real silent-skip bug this ticket closes.
 *
 * Releases use an `emittedIds` set (the `/releases` endpoint has no
 * `since`); they paginate fully each tick (cheap — no per-item enrichment).
 *
 * Rate limiting
 * -------------
 * 429 or `X-RateLimit-Remaining: 0` → `GitHubRateLimitError`. If it fires
 * mid-tick *after* events have already been gathered, `poll` returns the
 * partial batch with a no-bump (resumable) cursor rather than discarding a
 * tick's progress; with zero progress it propagates so the scheduler
 * records an error and retries without bumping `last_polled_at`. The
 * pagination floor stops the walk *before* exhaustion, so a hard throw is
 * the exception, not the rule. Low-but-nonzero remaining (`< 100`) still
 * logs a warning.
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
  /**
   * Per-tick cap on issue/PR list pages walked via the `Link: rel="next"`
   * loop (each page = up to 100 items). Bounds per-tick wall-clock and
   * memory on a fresh backfill of a large repo; the rest drains over
   * subsequent ticks with no skips (see cursor strategy). Defaults to
   * `THINK_GITHUB_MAX_LIST_PAGES` then `DEFAULT_MAX_LIST_PAGES`.
   */
  maxListPagesPerTick?: number;
  /**
   * Stop paginating once `X-RateLimit-Remaining` drops below this floor,
   * leaving budget for the per-item enrichment that follows (3 calls per
   * closed PR). This is what keeps a heavy backfill from exhausting a
   * PAT's hourly quota mid-walk. Defaults to `THINK_GITHUB_RATE_FLOOR`
   * then `DEFAULT_RATE_FLOOR`.
   */
  rateLimitFloor?: number;
  /**
   * Per-tick cap on release list pages. Releases re-walk from page 1 each
   * tick (no `since` cursor) and carry no enrichment, so the cap is
   * generous — it exists only to bound a pathological repo. Defaults to
   * `DEFAULT_MAX_RELEASE_PAGES`.
   */
  maxReleasePagesPerTick?: number;
  /**
   * ISO-8601 floor for what to ingest. Applies to BOTH event families:
   * issues/PRs use it as the `since` floor (so a fresh subscription only
   * walks items updated on/after this, with no per-subscription cursor
   * seeding), and releases with `published_at` before it are skipped
   * (GitHub's `/releases` endpoint has no `since` param, so this is the
   * only date gate releases get). A subscription whose cursor has already
   * advanced past the floor keeps its cursor — the floor never rewinds
   * progress. Defaults to `THINK_GITHUB_INGEST_SINCE`, else unset (ingest
   * all history). Malformed values are ignored.
   */
  ingestSince?: string;
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

interface GhResponse {
  body: unknown;
  /** Raw `Link` response header, or null. Drives `rel="next"` pagination. */
  linkHeader: string | null;
  /** Parsed `X-RateLimit-Remaining`, or null when the header is absent. */
  rateRemaining: number | null;
}

const DEFAULT_BASE_URL = 'https://api.github.com';
const DEFAULT_RELEASE_MEMORY = 200;
const RATE_LIMIT_WARN_THRESHOLD = 100;
const DEFAULT_MAX_LIST_PAGES = 10;
const DEFAULT_RATE_FLOOR = 200;
const DEFAULT_MAX_RELEASE_PAGES = 50;

/**
 * Result of a budgeted `Link`-header pagination walk. `drainedFully` is
 * true only when we reached the last page (no `rel="next"`) within budget;
 * a `false` means we stopped early (page cap, rate floor, or a rate-limit
 * after ≥1 page) and the caller must NOT bump its cursor past the last
 * consumed item — see the cursor strategy in the module JSDoc.
 */
interface PaginateResult<T> {
  items: T[];
  drainedFully: boolean;
}

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

function numFromEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Extract the `rel="next"` URL from a GitHub `Link` header, or null.
 * Format: `<https://api.github.com/...&page=2>; rel="next", <...>; rel="last"`.
 * We follow GitHub's own absolute next-URL rather than reconstructing page
 * numbers — robust against opaque cursor-style pagination.
 */
export function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m) return m[1];
  }
  return null;
}

export function createGitHubConnector(
  opts: CreateGitHubConnectorOptions = {},
): SourceConnector<GitHubCursor> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  // The origin we'll allow paginated `Link: rel="next"` URLs to target.
  // Link headers are server-controlled; following a cross-origin one would
  // forward the PAT (Authorization header) to an unexpected host.
  const expectedOrigin = new URL(baseUrl).origin;
  const now = opts.now ?? (() => new Date());
  const releaseMemorySize = opts.releaseIdMemorySize ?? DEFAULT_RELEASE_MEMORY;
  const maxListPages =
    opts.maxListPagesPerTick ??
    numFromEnv(process.env.THINK_GITHUB_MAX_LIST_PAGES) ??
    DEFAULT_MAX_LIST_PAGES;
  const rateFloor =
    opts.rateLimitFloor ?? numFromEnv(process.env.THINK_GITHUB_RATE_FLOOR) ?? DEFAULT_RATE_FLOOR;
  const maxReleasePages = opts.maxReleasePagesPerTick ?? DEFAULT_MAX_RELEASE_PAGES;
  // ISO floor for ingestion (issues/PRs `since` + releases `published_at`).
  // Validate via Date.parse so a malformed env value is ignored rather than
  // silently passed to GitHub or used in a string compare.
  const ingestSinceRaw = opts.ingestSince ?? process.env.THINK_GITHUB_INGEST_SINCE;
  // Normalize to canonical ISO-8601: the release gate compares lexicographically
  // (`published_at < ingestSince`) and GitHub's `since=` expects ISO, but
  // Date.parse also accepts non-ISO inputs ("Jan 1 2026") that would break the
  // string compare. new Date(...).toISOString() canonicalizes both uses.
  const ingestSince =
    ingestSinceRaw && Number.isFinite(Date.parse(ingestSinceRaw))
      ? new Date(ingestSinceRaw).toISOString()
      : undefined;
  // Defer the global-fetch lookup to call time so test environments that
  // patch globalThis.fetch after this module loads still get picked up.
  const fetchImpl: FetchFn = opts.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));

  function buildUrl(path: string, query?: Record<string, string>): string {
    const url = new URL(baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        url.searchParams.set(k, v);
      }
    }
    return url.toString();
  }

  /**
   * Single authenticated GET. Returns the parsed body alongside the
   * `Link` header (for pagination) and the parsed `X-RateLimit-Remaining`
   * (for the floor cutoff). Hard rate-limit branches throw a typed error;
   * the soft warning fires here so every request — including paginated
   * ones — is covered.
   */
  async function ghRequest(token: string, url: string): Promise<GhResponse> {
    const res = await fetchImpl(url, {
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
      throw new Error(`github ${url}: 403 forbidden (PAT may lack required scope)`);
    }
    if (!res.ok) {
      throw new Error(`github ${url}: ${res.status} ${res.statusText}`);
    }

    const remainingHeader = res.headers.get('X-RateLimit-Remaining');
    const rateRemaining =
      remainingHeader !== null && Number.isFinite(Number(remainingHeader))
        ? Number(remainingHeader)
        : null;

    // Soft warning when budget is running low.
    if (rateRemaining !== null && rateRemaining > 0 && rateRemaining < RATE_LIMIT_WARN_THRESHOLD) {
      console.warn(
        `[open-think serve] github rate limit low: ${rateRemaining} remaining (url=${url})`,
      );
    }

    return {
      body: await res.json(),
      linkHeader: res.headers.get('Link'),
      rateRemaining,
    };
  }

  async function ghFetch(
    token: string,
    path: string,
    extra?: { query?: Record<string, string>; expectArray?: boolean },
  ): Promise<unknown> {
    return (await ghRequest(token, buildUrl(path, extra?.query))).body;
  }

  /**
   * Walk `Link: rel="next"` pages, accumulating array items, until one of:
   * the last page (no next link → `drainedFully: true`), the page cap, the
   * rate floor, or a rate-limit thrown after we already have items. A
   * rate-limit or non-rate error on the *first* page (zero items) is
   * rethrown so the caller's first-call semantics are preserved.
   */
  async function fetchAllPages<T>(
    token: string,
    path: string,
    query: Record<string, string>,
    pageOpts: { maxPages: number },
  ): Promise<PaginateResult<T>> {
    const items: T[] = [];
    let url = buildUrl(path, query);
    let pages = 0;
    for (;;) {
      let res: GhResponse;
      try {
        res = await ghRequest(token, url);
      } catch (err) {
        if (err instanceof GitHubRateLimitError && items.length > 0) {
          return { items, drainedFully: false };
        }
        throw err;
      }
      if (Array.isArray(res.body)) items.push(...(res.body as T[]));
      pages += 1;

      const next = parseNextLink(res.linkHeader);
      if (!next) return { items, drainedFully: true };
      // Only follow a next-page URL on the same origin as `baseUrl`. A
      // cross-origin (or unparseable) Link target is treated as an early
      // stop — NOT a full drain — so the cursor isn't bumped past unseen
      // items and the PAT is never sent off-origin.
      let nextOrigin: string | null = null;
      try {
        nextOrigin = new URL(next).origin;
      } catch {
        nextOrigin = null;
      }
      if (nextOrigin !== expectedOrigin) {
        console.warn(
          '[open-think serve] github: Link next-page origin mismatch; stopping pagination',
        );
        return { items, drainedFully: false };
      }
      if (pages >= pageOpts.maxPages) return { items, drainedFully: false };
      if (res.rateRemaining !== null && res.rateRemaining < rateFloor) {
        return { items, drainedFully: false };
      }
      url = next;
    }
  }

  async function listClosedIssues(
    token: string,
    p: ParsedPattern,
    since: string | undefined,
  ): Promise<PaginateResult<GitHubIssueListItem>> {
    // `sort=updated&direction=asc` makes the `since` cursor a monotonic
    // high-water mark: each page is the oldest-updated batch ≥ `since`, so
    // advancing the cursor to the page's max never jumps past an unseen
    // item (AGT-409). We walk `rel="next"` pages within budget; the tail of
    // a huge repo drains over subsequent ticks with no skips.
    const query: Record<string, string> = {
      state: 'closed',
      sort: 'updated',
      direction: 'asc',
      per_page: '100',
      filter: 'all',
    };
    if (since) query.since = since;
    return fetchAllPages<GitHubIssueListItem>(token, `/repos/${p.owner}/${p.repo}/issues`, query, {
      maxPages: maxListPages,
    });
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
  ): Promise<PaginateResult<GitHubRelease>> {
    // Releases have no `since` filter, so we re-walk from page 1 each tick
    // and dedup via the emitted-id set. Pagination is cheap here (no
    // per-item enrichment), so the page cap is generous — it only bounds a
    // pathological repo. The id-set + events unique index make re-emission
    // across ticks harmless.
    return fetchAllPages<GitHubRelease>(
      token,
      `/repos/${p.owner}/${p.repo}/releases`,
      { per_page: '100' },
      { maxPages: maxReleasePages },
    );
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
      // Guarded above (`if (!item.closed_at) return null`), so this is a
      // clean source date — the moment the issue settled.
      occurredAt: item.closed_at,
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
      // Prefer the merge moment; fall back to close for unmerged PRs.
      // `?? undefined` so a null from the API leaves it unset (writer then
      // falls back to insertion time) rather than stamping `ts: null`.
      occurredAt: detail.merged_at ?? detail.closed_at ?? undefined,
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
      // Only published releases reach here (drafts filtered upstream), so
      // `published_at` is the clean settle date. `?? undefined` guards a
      // null from the API.
      occurredAt: release.published_at ?? undefined,
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
    // Floor the cursor at `ingestSince`: a fresh sub (no cursor) starts at the
    // floor; a sub already past it keeps its progress (maxIso never rewinds).
    let issuesSince = maxIso(cursorIn.issuesSince, ingestSince);
    const releaseIdSet = new Set(cursorIn.emittedReleaseIds ?? []);

    // --- Issues + PRs ---------------------------------------------------
    // GitHub's `/issues` endpoint returns both issues AND PRs (PRs are a
    // superset of issues in GH's data model). We filter to closed ones
    // and dispatch on the presence of `pull_request` for shape. Items
    // arrive ascending by `updated_at` (across pages), so advancing
    // `issuesSince` per processed item leaves a resumable high-water mark.
    const closed = await listClosedIssues(token, pattern, issuesSince);
    // `processedAll` flips false if a rate-limit interrupts enrichment
    // after we've already gathered events — we keep the partial batch and
    // resume next tick rather than discarding the whole tick's progress.
    let processedAll = true;
    try {
      for (const item of closed.items) {
        // Defensive guard — only closed items have a closed_at, but a row
        // that flipped open→closed→open between list and read could lack
        // one. Skip rather than emit a malformed event.
        if (item.state !== 'closed' || !item.closed_at) continue;

        const isPR = !!item.pull_request;
        const evt = isPR
          ? await emitForClosedPull(token, pattern, item)
          : await emitForClosedIssue(token, pattern, item);
        if (evt) events.push(evt);
        // Advance only AFTER a successful emit so a mid-item throw leaves
        // the cursor at the last fully-processed item.
        issuesSince = maxIso(issuesSince, item.updated_at);
      }
    } catch (err) {
      if (err instanceof GitHubRateLimitError && events.length > 0) {
        processedAll = false;
      } else {
        throw err;
      }
    }

    // --- Releases -------------------------------------------------------
    // No `since` filter on /releases. We list and filter by id-set
    // membership. Draft releases are non-terminal (still being edited),
    // so we skip them; the moment they publish, `published_at` flips
    // and they show up on a subsequent poll. Skip the releases pass
    // entirely if issue enrichment was cut short by a rate-limit — there's
    // no budget left and the next tick re-walks releases from page 1.
    const releases = processedAll ? await listReleases(token, pattern) : { items: [], drainedFully: false };
    const newlyEmittedIds: number[] = [];
    for (const r of releases.items) {
      if (r.draft) continue;
      if (!r.published_at) continue; // not yet published
      // Releases have no `since` param, so the ingest floor is applied here
      // by publish date (ISO strings compare lexically). Skips pre-cutoff
      // history — including CI auto-tag releases — without emitting them.
      if (ingestSince && r.published_at < ingestSince) continue;
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

    // Conditional cursor bump (AGT-409). Only bump +1ms past the newest
    // consumed item when we KNOW nothing remains at or below that second:
    // the list fully drained AND every item was enriched. Otherwise leave
    // the cursor at the exact max `updated_at` (no bump) so the next tick
    // re-includes that boundary second — items sharing it that fell past a
    // page/budget/rate cutoff are then picked up, and the events unique
    // index dedups the overlap. A +1ms here would silently skip them.
    const fullyComplete = closed.drainedFully && processedAll;
    const nextIssuesSince = fullyComplete ? bumpSinceBy1Ms(issuesSince) : issuesSince;

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
