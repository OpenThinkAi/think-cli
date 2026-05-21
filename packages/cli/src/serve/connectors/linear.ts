import type {
  EventInput,
  PollContext,
  PollResult,
  SourceConnector,
  VerifyCredentialResult,
} from './types.js';

/**
 * Linear source connector (AGT-392). Emits **only terminal events**:
 *
 *   - issue moved into a `completed`-type workflow state → `:completed:<iso>`
 *   - issue moved into a `canceled`-type workflow state  → `:canceled:<iso>`
 *
 * Subscription pattern is a Linear team key (e.g. `ENG`, `PROD`). One
 * connector instance services many subscriptions because the framework
 * hands the pattern in via `PollContext`.
 *
 * Credentials are personal API keys (`lin_api_...`) read from
 * `ctx.credential`. Linear personal keys go in the `Authorization` header
 * **without** a `Bearer` prefix — that's the format Linear's docs document
 * and what their server accepts. Linear OAuth tokens use `Bearer` but
 * we don't support those here.
 *
 * Cursor strategy
 * ---------------
 * Linear's GraphQL `issues` query accepts a `filter: { updatedAt: { gt } }`
 * date comparator that is **strictly greater than**, so we can store the
 * literal newest `updatedAt` we've seen and feed it back verbatim — no
 * 1ms bump needed (unlike the GitHub `since=` parameter which is inclusive).
 * Issues are returned sorted by `updatedAt` ASC so the cursor advances
 * monotonically through history.
 *
 * Episode key vs event id
 * -----------------------
 * `episodeKey = linear:<identifier>` (e.g. `linear:ENG-123`) groups every
 * closure cycle of the same ticket under one source artifact. `id` includes
 * the terminal `completedAt`/`canceledAt` timestamp so a reopen-then-close
 * cycle produces a distinct id (and therefore a distinct memory) while
 * still sharing the episode key with prior closures of the same ticket.
 *
 * Same-tick reopen-close-reopen-close cycles are not preserved — the
 * `issues` query returns the issue's *current* state, not its transition
 * history. Default poll cadence (600s) makes this corner case rare in
 * practice; capturing every transition would require iterating
 * `issueHistory` which is more API budget than the value warrants for now.
 *
 * Rate limiting
 * -------------
 * Linear surfaces `X-RateLimit-Requests-Remaining` and -Reset headers
 * plus 429 with `Retry-After` on hard exhaustion. We throw
 * `LinearRateLimitError` so the scheduler's per-poll error branch records
 * the failure without bumping `last_polled_at`; the next tick retries.
 * Low-but-nonzero remaining (`< 50`) logs a warning. GraphQL errors
 * (200 with `errors[]` body) propagate as plain `Error`.
 *
 * Tests inject `fetchImpl` and `now` to keep HTTP and time deterministic.
 */

export interface LinearCursor {
  /**
   * `updatedAt` of the newest issue we've already considered, ISO8601.
   * Fed back as `gt` on the next poll's `issues` filter. Updated *after*
   * a successful poll completes whether or not the items were emitted —
   * a non-terminal issue still advances the cursor, otherwise we'd
   * re-fetch the same backlog rows forever.
   */
  issuesUpdatedSince?: string;
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface CreateLinearConnectorOptions {
  /**
   * HTTP impl. Defaults to global `fetch`. Tests inject a stub that
   * returns canned GraphQL responses.
   */
  fetchImpl?: FetchFn;
  /** Base URL override for tests. Defaults to `https://api.linear.app/graphql`. */
  endpoint?: string;
  /** Clock seam for tests; defaults to `() => new Date()`. */
  now?: () => Date;
  /** Page size for the `issues` query. Linear caps at 250; we default to 50. */
  pageSize?: number;
}

export class LinearRateLimitError extends Error {
  readonly resetAt: Date;
  constructor(resetAt: Date) {
    super(`linear rate-limited until ${resetAt.toISOString()}`);
    this.name = 'LinearRateLimitError';
    this.resetAt = resetAt;
  }
}

interface LinearUser {
  name: string | null;
  displayName: string | null;
  email?: string | null;
}

interface LinearComment {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  user: LinearUser | null;
}

interface LinearLabel {
  name: string;
}

interface LinearState {
  name: string;
  type: string;
}

interface LinearTeam {
  key: string;
  name: string;
}

interface LinearIssue {
  id: string;
  number: number;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  priority: number | null;
  priorityLabel: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  canceledAt: string | null;
  startedAt: string | null;
  archivedAt: string | null;
  state: LinearState;
  team: LinearTeam;
  assignee: LinearUser | null;
  creator: LinearUser | null;
  labels: { nodes: LinearLabel[] } | null;
  comments: { nodes: LinearComment[] } | null;
}

interface LinearIssuesPage {
  nodes: LinearIssue[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface GraphQLError {
  message: string;
  extensions?: { code?: string; type?: string };
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: GraphQLError[];
}

const DEFAULT_ENDPOINT = 'https://api.linear.app/graphql';
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGES_PER_POLL = 20;
const RATE_LIMIT_WARN_THRESHOLD = 50;

const TERMINAL_STATE_TYPES = new Set(['completed', 'canceled']);

const ISSUES_QUERY = `
  query PollIssues($teamKey: String!, $first: Int!, $after: String, $since: DateTimeOrDuration) {
    issues(
      first: $first,
      after: $after,
      orderBy: updatedAt,
      sort: [{ updatedAt: { order: Ascending } }],
      filter: {
        team: { key: { eq: $teamKey } },
        updatedAt: { gt: $since }
      }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        number
        identifier
        title
        description
        url
        priority
        priorityLabel
        createdAt
        updatedAt
        completedAt
        canceledAt
        startedAt
        archivedAt
        state { name type }
        team { key name }
        assignee { name displayName }
        creator { name displayName }
        labels(first: 50) { nodes { name } }
        comments(first: 100) {
          nodes {
            id
            body
            createdAt
            updatedAt
            user { name displayName }
          }
        }
      }
    }
  }
`;

const VIEWER_QUERY = `query Viewer { viewer { id name email } }`;

function validateTeamKey(pattern: string): string {
  const trimmed = pattern.trim();
  // Linear team keys are uppercase alphanumeric (digits allowed, no
  // dashes). We don't try to validate against the actual Linear workspace
  // — the API will return an empty result set on an unknown key, and
  // surfacing a 400 here would be a maintenance burden every time Linear
  // expands their character set.
  if (!/^[A-Z][A-Z0-9_]*$/.test(trimmed)) {
    throw new Error(
      `linear connector: pattern must be an uppercase team key (e.g. "ENG"), got ${JSON.stringify(pattern)}`,
    );
  }
  return trimmed;
}

export function createLinearConnector(
  opts: CreateLinearConnectorOptions = {},
): SourceConnector<LinearCursor> {
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
  const now = opts.now ?? (() => new Date());
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  // Defer the global-fetch lookup to call time so test environments that
  // patch globalThis.fetch after this module loads still pick up the
  // patched version.
  const fetchImpl: FetchFn = opts.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));

  async function linearFetch<T>(
    apiKey: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        // Linear personal API keys go in `Authorization` with no `Bearer`
        // prefix — their docs are explicit about this and an OAuth-style
        // Bearer is rejected for personal tokens.
        Authorization: apiKey,
        'Content-Type': 'application/json',
        'User-Agent': 'open-think-server',
      },
      body: JSON.stringify({ query, variables }),
    });

    // Hard rate-limit branches. Throw a typed error so the scheduler's
    // per-poll error branch records it without bumping last_polled_at.
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('Retry-After') ?? '60');
      throw new LinearRateLimitError(new Date(now().getTime() + retryAfter * 1000));
    }
    const remainingHeader = res.headers.get('X-RateLimit-Requests-Remaining');
    if (res.status === 403 && remainingHeader === '0') {
      const reset = Number(res.headers.get('X-RateLimit-Requests-Reset') ?? '0');
      // Linear's reset header is milliseconds since epoch (their docs
      // specify ms, not seconds — different from GitHub).
      throw new LinearRateLimitError(new Date(reset));
    }
    if (!res.ok) {
      throw new Error(`linear graphql: ${res.status} ${res.statusText}`);
    }

    // Soft warning when budget is running low. Threshold is loose; the
    // scheduler's per-tick cadence (600s default) means we have plenty of
    // headroom relative to Linear's per-minute budget.
    if (remainingHeader !== null) {
      const remaining = Number(remainingHeader);
      if (Number.isFinite(remaining) && remaining > 0 && remaining < RATE_LIMIT_WARN_THRESHOLD) {
        console.warn(
          `[open-think serve] linear rate limit low: ${remaining} remaining`,
        );
      }
    }

    const body = (await res.json()) as GraphQLResponse<T>;
    if (body.errors && body.errors.length > 0) {
      // GraphQL endpoints return 200 with an `errors[]` array on
      // validation/authz/etc failures. Surface the first message —
      // operator-facing, no token in it (we don't include variables).
      throw new Error(`linear graphql errors: ${body.errors.map((e) => e.message).join('; ')}`);
    }
    if (!body.data) {
      throw new Error('linear graphql: empty data');
    }
    return body.data;
  }

  function shapeComment(c: LinearComment) {
    return {
      id: c.id,
      author: c.user?.displayName ?? c.user?.name ?? null,
      body: c.body,
      created_at: c.createdAt,
      updated_at: c.updatedAt,
    };
  }

  function emitForTerminalIssue(issue: LinearIssue): EventInput | null {
    const stateType = issue.state.type;
    if (!TERMINAL_STATE_TYPES.has(stateType)) return null;

    // Linear nullifies completedAt/canceledAt when an issue is reopened
    // and writes a fresh timestamp on re-closure. Using that timestamp
    // in the event id makes each closure cycle a distinct event (new
    // memory) while episodeKey stays stable across cycles.
    const closedAt =
      stateType === 'completed' ? issue.completedAt : issue.canceledAt;
    if (!closedAt) {
      // Defensive: in transit between state transitions the timestamps
      // can lag. Skip rather than emit a malformed event — the next
      // poll will pick it up once Linear has settled.
      return null;
    }

    const finalState = stateType === 'completed' ? 'completed' : 'canceled';
    const comments = issue.comments?.nodes ?? [];
    const labels = (issue.labels?.nodes ?? []).map((l) => l.name);

    return {
      id: `linear:${issue.identifier}:${finalState}:${closedAt}`,
      episodeKey: `linear:${issue.identifier}`,
      terminal: true,
      payload: JSON.stringify({
        kind: stateType === 'completed' ? 'issue.completed' : 'issue.canceled',
        team_key: issue.team.key,
        team_name: issue.team.name,
        identifier: issue.identifier,
        number: issue.number,
        url: issue.url,
        title: issue.title,
        description: issue.description,
        priority: issue.priority,
        priority_label: issue.priorityLabel,
        state_name: issue.state.name,
        state_type: stateType,
        final_state: finalState,
        assignee: issue.assignee?.displayName ?? issue.assignee?.name ?? null,
        creator: issue.creator?.displayName ?? issue.creator?.name ?? null,
        labels,
        created_at: issue.createdAt,
        updated_at: issue.updatedAt,
        started_at: issue.startedAt,
        completed_at: issue.completedAt,
        canceled_at: issue.canceledAt,
        archived_at: issue.archivedAt,
        comments: comments.map(shapeComment),
      }),
    };
  }

  async function poll(
    ctx: PollContext<LinearCursor>,
  ): Promise<PollResult<LinearCursor>> {
    if (!ctx.credential) {
      throw new Error('linear connector: missing credential (store an API key via vault)');
    }
    const teamKey = validateTeamKey(ctx.subscription.pattern);
    const apiKey = ctx.credential;

    const cursorIn = ctx.cursor ?? {};
    const since = cursorIn.issuesUpdatedSince;
    const events: EventInput[] = [];
    let newestUpdatedAt: string | undefined = since;

    // Page through issues whose updatedAt is strictly greater than the
    // cursor. Per-poll cap (`MAX_PAGES_PER_POLL`) bounds worst-case work
    // if the cursor is far behind — leftover pages are deferred to the
    // next tick and the cursor advances to the newest considered, so we
    // never re-fetch already-seen rows.
    let after: string | null = null;
    for (let pageNum = 0; pageNum < MAX_PAGES_PER_POLL; pageNum++) {
      const data: { issues: LinearIssuesPage } = await linearFetch<{ issues: LinearIssuesPage }>(
        apiKey,
        ISSUES_QUERY,
        {
          teamKey,
          first: pageSize,
          after,
          since: since ?? null,
        },
      );
      const page: LinearIssuesPage = data.issues;
      for (const issue of page.nodes) {
        // Advance cursor for *every* row we considered, terminal or not.
        // A backlog row that updates without becoming terminal still
        // counts as "seen" — otherwise the next poll would re-fetch it.
        if (!newestUpdatedAt || issue.updatedAt > newestUpdatedAt) {
          newestUpdatedAt = issue.updatedAt;
        }
        const evt = emitForTerminalIssue(issue);
        if (evt) events.push(evt);
      }
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
      if (!after) break; // defensive — hasNextPage=true with null cursor shouldn't happen
    }

    return {
      events,
      nextCursor: {
        ...(newestUpdatedAt !== undefined ? { issuesUpdatedSince: newestUpdatedAt } : {}),
      },
    };
  }

  async function verifyCredential(credential: string): Promise<VerifyCredentialResult> {
    if (credential.length === 0) {
      return { ok: false, detail: 'linear requires a non-empty API key' };
    }
    try {
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: credential,
          'Content-Type': 'application/json',
          'User-Agent': 'open-think-server',
        },
        body: JSON.stringify({ query: VIEWER_QUERY }),
      });
      if (res.status === 401) return { ok: false, detail: 'linear 401: invalid API key' };
      if (!res.ok) return { ok: false, detail: `linear ${res.status}` };
      const body = (await res.json()) as GraphQLResponse<{
        viewer: { id: string };
      }>;
      if (body.errors && body.errors.length > 0) {
        // First error only, no credential. The errors array can include
        // `AUTHENTICATION_ERROR` extensions; we surface the message text
        // since that's what the operator needs to act on.
        return { ok: false, detail: `linear graphql error: ${body.errors[0].message}` };
      }
      if (!body.data?.viewer?.id) {
        return { ok: false, detail: 'linear graphql: no viewer returned' };
      }
      return { ok: true };
    } catch (err) {
      // Don't echo the credential in error messages. The no-leak audit
      // test guards this at the route layer but defense-in-depth here too.
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, detail: `linear verify failed: ${message}` };
    }
  }

  return {
    kind: 'linear',
    poll,
    verifyCredential,
  };
}
