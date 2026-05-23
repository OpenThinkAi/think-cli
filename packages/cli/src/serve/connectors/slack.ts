import type {
  EventInput,
  PollContext,
  PollResult,
  SourceConnector,
  VerifyCredentialResult,
} from './types.js';

/**
 * Slack source connector (AGT-394). Emits one terminal event per thread
 * that the team has marked "settled" via a designated closing reaction
 * on the thread root.
 *
 * Why reaction-driven, not state-transition driven
 * -------------------------------------------------
 * Slack threads have no native "closed" state — they just go quiet. To
 * keep capture opt-in and operator-controlled, the convention is:
 *
 *     a designated reaction (default `:lock:`) on the thread ROOT
 *     means "this thread is settled — curate it now."
 *
 * Teams that don't adopt the convention get nothing — same shape as the
 * GitHub-PR-merge signal: no terminal event without a deliberate human
 * action. The closing emoji is configurable via the
 * `THINK_SLACK_CLOSING_REACTION` env var; default is `lock`. (Bare name,
 * no colons — Slack's reaction `name` field is colon-less.)
 *
 * Subscription pattern is `<workspace>` — a free-form label the operator
 * picks (e.g. `acme`, `T01234`). It only flows through to the
 * `episodeKey`, so two proxies pointed at the same workspace can use
 * different labels without colliding. The framework hands the pattern in
 * via `PollContext`, so a single registered connector instance services
 * every Slack subscription.
 *
 * Polling strategy
 * ----------------
 * Slack's RTM is deprecated and the Events API requires a public webhook
 * endpoint the proxy doesn't have. So the connector polls. Per tick:
 *
 *   1. `users.conversations` lists channels the bot user is a member of.
 *      (The bot has to be invited — Slack returns nothing for channels
 *      the bot isn't in, which is the access-control surface.)
 *   2. For each channel, `conversations.history` returns the most recent
 *      page of top-level messages.
 *   3. For each thread-root message whose `reactions[]` includes the
 *      closing reaction, the connector checks the cursor's
 *      `emittedThreadKeys`. If not yet emitted, it fetches the full
 *      thread via `conversations.replies` and emits one terminal event
 *      keyed `slack:<workspace>:<channel>:<thread-ts>`.
 *
 * The `emittedThreadKeys` set in the cursor caps thread re-emission. The
 * proxy's `events_sub_id_unique` index is the dedup floor below the
 * cap — a key that falls out of the FIFO window and the same thread
 * resurfaces gets dropped at insert time.
 *
 * Cursor shape
 * ------------
 * No reaction-event timestamp exists on the `reactions[]` array (Slack
 * doesn't expose per-reaction-add timestamps), so we can't advance a
 * monotonic `since`. We track which thread roots we've already emitted
 * instead. A page-1-only `conversations.history` scan keeps the cost
 * bounded: high-volume channels will scroll past old roots, but those
 * already have an emitted key and are caught by the dedup index even on
 * a future re-scroll.
 *
 * Rate limiting
 * -------------
 * Slack rate limits are method-tier-based. `conversations.history` and
 * `conversations.replies` are Tier 3 (~50/min per workspace). On 429 we
 * read `Retry-After` and throw `SlackRateLimitError` so the scheduler
 * records an `error` outcome without bumping `last_polled_at`. Slack
 * also surfaces rate-limit failures via the `ok: false` envelope with
 * `error: 'ratelimited'` — handled equivalently.
 *
 * User resolution
 * ---------------
 * Participants are emitted as user IDs in v1. A future enrichment pass
 * can call `users.info` (or batch via `users.list`) to resolve display
 * names — out of scope for AGT-394 to keep the per-poll API budget
 * predictable.
 *
 * Tests pass `fetchImpl`, `now`, and `closingReaction` to make HTTP,
 * time, and the convention injectable without spinning up a real Slack.
 */

export interface SlackCursor {
  /**
   * Episode keys we've already emitted a terminal event for. Capped via
   * `closedThreadMemorySize` (FIFO). Below the cap, dedup falls through
   * to the events table's unique index.
   */
  emittedThreadKeys?: string[];
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface CreateSlackConnectorOptions {
  /** HTTP impl. Defaults to global `fetch`. Tests inject a stub. */
  fetchImpl?: FetchFn;
  /** Base URL override for tests. Defaults to `https://slack.com/api`. */
  baseUrl?: string;
  /** Clock seam for tests; defaults to `() => new Date()`. */
  now?: () => Date;
  /**
   * Closing reaction name (no colons). Defaults to the
   * `THINK_SLACK_CLOSING_REACTION` env var, then `lock`. Tests pass
   * this explicitly to avoid env coupling.
   */
  closingReaction?: string;
  /** Max thread keys retained in cursor. Defaults to 500. */
  closedThreadMemorySize?: number;
}

export class SlackRateLimitError extends Error {
  readonly resetAt: Date;
  constructor(resetAt: Date) {
    super(`slack rate-limited until ${resetAt.toISOString()}`);
    this.name = 'SlackRateLimitError';
    this.resetAt = resetAt;
  }
}

interface SlackReaction {
  name: string;
  users?: string[];
  count?: number;
}

interface SlackMessage {
  ts: string;
  thread_ts?: string;
  user?: string;
  username?: string;
  bot_id?: string;
  text?: string;
  reactions?: SlackReaction[];
  subtype?: string;
}

interface SlackChannel {
  id: string;
  name?: string;
  is_archived?: boolean;
}

const DEFAULT_BASE_URL = 'https://slack.com/api';
const DEFAULT_CLOSED_THREAD_MEMORY = 500;
const DEFAULT_CLOSING_REACTION = 'lock';
const HISTORY_PAGE_SIZE = 100;
const CHANNELS_PAGE_SIZE = 200;

function normalizeReactionName(raw: string): string {
  // Operators sometimes paste `:lock:` from Slack's emoji picker. Slack's
  // API uses the bare name. Strip leading/trailing colons defensively so
  // either form works.
  return raw.replace(/^:+|:+$/g, '').trim();
}

function parsePattern(pattern: string): string {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) {
    throw new Error('slack connector: pattern (workspace label) must be non-empty');
  }
  if (/\s/.test(trimmed)) {
    // Whitespace in the episodeKey component would be ugly and likely a
    // copy-paste mistake. Reject early with a clear message.
    throw new Error(
      `slack connector: pattern must be a single workspace label without whitespace, got ${JSON.stringify(pattern)}`,
    );
  }
  return trimmed;
}

export function createSlackConnector(
  opts: CreateSlackConnectorOptions = {},
): SourceConnector<SlackCursor> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const now = opts.now ?? (() => new Date());
  const closingReaction = normalizeReactionName(
    opts.closingReaction ??
      process.env.THINK_SLACK_CLOSING_REACTION ??
      DEFAULT_CLOSING_REACTION,
  );
  const memorySize = opts.closedThreadMemorySize ?? DEFAULT_CLOSED_THREAD_MEMORY;
  // Defer the global-fetch lookup to call time so test environments that
  // patch globalThis.fetch after this module loads still get picked up.
  const fetchImpl: FetchFn = opts.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));

  async function slackFetch(
    token: string,
    method: string,
    query: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const url = new URL(`${baseUrl}/${method}`);
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, v);
    }
    const res = await fetchImpl(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': 'open-think-server',
      },
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('Retry-After') ?? '30');
      throw new SlackRateLimitError(new Date(now().getTime() + retryAfter * 1000));
    }
    if (!res.ok) {
      throw new Error(`slack ${method}: ${res.status} ${res.statusText}`);
    }

    const json = (await res.json()) as Record<string, unknown>;
    if (json.ok !== true) {
      const errorCode = String(json.error ?? 'unknown_error');
      if (errorCode === 'ratelimited') {
        const retryAfter = Number(res.headers.get('Retry-After') ?? '30');
        throw new SlackRateLimitError(new Date(now().getTime() + retryAfter * 1000));
      }
      // `missing_scope` / `invalid_auth` / `not_in_channel` / etc. surface
      // verbatim — actionable for the operator without leaking the token.
      throw new Error(`slack ${method}: ${errorCode}`);
    }
    return json;
  }

  async function listBotChannels(token: string): Promise<SlackChannel[]> {
    // `users.conversations` with no `user=` defaults to the auth'd user —
    // for a bot token that's the bot user. Single page only (cap at
    // CHANNELS_PAGE_SIZE) to keep per-poll cost bounded. Bots in >200
    // channels is rare for the opt-in adoption model; if it becomes a
    // problem the cursor will need a channel-pagination shape.
    const json = await slackFetch(token, 'users.conversations', {
      types: 'public_channel,private_channel',
      exclude_archived: 'true',
      limit: String(CHANNELS_PAGE_SIZE),
    });
    return (json.channels as SlackChannel[]) ?? [];
  }

  async function listChannelHistory(
    token: string,
    channelId: string,
  ): Promise<SlackMessage[]> {
    const json = await slackFetch(token, 'conversations.history', {
      channel: channelId,
      limit: String(HISTORY_PAGE_SIZE),
    });
    return (json.messages as SlackMessage[]) ?? [];
  }

  async function listThreadReplies(
    token: string,
    channelId: string,
    threadTs: string,
  ): Promise<{ messages: SlackMessage[]; hasMore: boolean }> {
    // TODO(pagination): Single-page fetch. Threads longer than HISTORY_PAGE_SIZE
    // (100) get their tail dropped; `has_more` is surfaced in the payload so
    // downstream consumers (and the curator) can flag the memory as partial.
    const json = await slackFetch(token, 'conversations.replies', {
      channel: channelId,
      ts: threadTs,
      limit: String(HISTORY_PAGE_SIZE),
    });
    const messages = (json.messages as SlackMessage[]) ?? [];
    const hasMore = json.has_more === true;
    return { messages, hasMore };
  }

  function isThreadRoot(msg: SlackMessage): boolean {
    // A Slack message is a thread root when either it has no `thread_ts`
    // (no replies yet) or `thread_ts === ts` (it IS the root). Replies
    // carry `thread_ts !== ts`. We only emit on roots — the closing
    // reaction goes on the root by convention.
    return !msg.thread_ts || msg.thread_ts === msg.ts;
  }

  function hasClosingReaction(msg: SlackMessage): boolean {
    return (msg.reactions ?? []).some((r) => r.name === closingReaction);
  }

  function shapeMessage(m: SlackMessage) {
    return {
      ts: m.ts,
      user: m.user ?? null,
      username: m.username ?? null,
      bot_id: m.bot_id ?? null,
      text: m.text ?? '',
      subtype: m.subtype ?? null,
    };
  }

  function collectParticipants(messages: SlackMessage[]): string[] {
    const set = new Set<string>();
    for (const m of messages) {
      if (m.user) set.add(m.user);
    }
    return [...set];
  }

  function tsToIso(ts: string): string | null {
    // Slack ts is `<unix-seconds>.<microseconds>`. Convert to ISO for
    // a human-readable time-range in the payload.
    const secs = Number.parseFloat(ts);
    if (!Number.isFinite(secs)) return null;
    return new Date(secs * 1000).toISOString();
  }

  async function emitForClosedThread(
    token: string,
    workspace: string,
    channel: SlackChannel,
    root: SlackMessage,
  ): Promise<EventInput> {
    const { messages: thread, hasMore } = await listThreadReplies(token, channel.id, root.ts);
    // `conversations.replies` returns the root as the first element plus
    // every reply, in chronological order. Empty array would be a Slack
    // bug, but treat defensively: if empty, fall back to the root we
    // already have so the event still ships.
    const messages = thread.length > 0 ? thread : [root];
    const participants = collectParticipants(messages);
    const firstTs = messages[0]?.ts ?? root.ts;
    const lastTs = messages[messages.length - 1]?.ts ?? root.ts;
    const episodeKey = `slack:${workspace}:${channel.id}:${root.ts}`;
    return {
      id: episodeKey + ':closed',
      episodeKey,
      terminal: true,
      // The thread root's creation time — the chronological anchor for
      // "when this conversation happened" (matches root.ts in episodeKey).
      // Slack exposes no per-reaction timestamp, so the settle moment
      // (:hive: added) isn't available; the root time is the stable,
      // deterministic choice. `?? undefined` keeps a malformed ts from
      // stamping the memory — the writer falls back to insertion time.
      // This is what makes future old-Slack backfill land threads at their
      // real dates instead of clustering at import time.
      occurredAt: tsToIso(root.ts) ?? undefined,
      payload: JSON.stringify({
        kind: 'thread.closed',
        workspace,
        channel_id: channel.id,
        channel_name: channel.name ?? null,
        thread_ts: root.ts,
        closing_reaction: closingReaction,
        participants,
        message_count: messages.length,
        // True when the thread has more replies beyond `HISTORY_PAGE_SIZE`
        // that we didn't fetch in v1. Curator + downstream consumers can
        // flag the memory as partial when this is set.
        has_more: hasMore,
        started_at: tsToIso(firstTs),
        ended_at: tsToIso(lastTs),
        messages: messages.map(shapeMessage),
        final_state: 'closed',
      }),
    };
  }

  async function poll(
    ctx: PollContext<SlackCursor>,
  ): Promise<PollResult<SlackCursor>> {
    if (!ctx.credential) {
      throw new Error(
        'slack connector: missing credential — run `think serve creds add slack <pattern>` to store a bot token',
      );
    }
    const workspace = parsePattern(ctx.subscription.pattern);
    const token = ctx.credential;

    const events: EventInput[] = [];
    const cursorIn = ctx.cursor ?? {};
    const emitted = new Set<string>(cursorIn.emittedThreadKeys ?? []);

    const channels = await listBotChannels(token);
    for (const ch of channels) {
      if (ch.is_archived) continue;
      const history = await listChannelHistory(token, ch.id);
      for (const msg of history) {
        if (!isThreadRoot(msg)) continue;
        if (!hasClosingReaction(msg)) continue;
        const episodeKey = `slack:${workspace}:${ch.id}:${msg.ts}`;
        if (emitted.has(episodeKey)) continue;
        const evt = await emitForClosedThread(token, workspace, ch, msg);
        events.push(evt);
        emitted.add(episodeKey);
      }
    }

    // FIFO trim — keep the most recent N keys. Older keys age out and
    // rely on the events unique index as the dedup floor. Iteration
    // order on Set preserves insertion order in JS, so the head of the
    // array is the oldest entry.
    const allKeys = [...emitted];
    const trimmedKeys = allKeys.slice(Math.max(0, allKeys.length - memorySize));

    return {
      events,
      nextCursor: {
        emittedThreadKeys: trimmedKeys,
      },
    };
  }

  async function verifyCredential(credential: string): Promise<VerifyCredentialResult> {
    // Probe `auth.test` — cheapest authenticated endpoint, returns
    // workspace/team metadata. 200 + `ok: true` → good token; any other
    // shape → surface the error code.
    //
    // NOTE: This path uses `fetchImpl` directly (not `slackFetch`) so a 429
    // here falls into the generic catch below and surfaces as
    // `ok: false, detail: 'slack verify failed: ...'` rather than as a
    // typed `SlackRateLimitError`. Intentional — credential setup is not
    // the poll hot path, and operators triggering this manually will see
    // the underlying error in `detail`. Don't "fix" by routing through
    // `slackFetch` without also reshaping the return type.
    if (credential.length === 0) {
      return { ok: false, detail: 'slack requires a non-empty bot token' };
    }
    try {
      const res = await fetchImpl(`${baseUrl}/auth.test`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential}`,
          Accept: 'application/json',
          'User-Agent': 'open-think-server',
        },
      });
      if (res.status === 401) return { ok: false, detail: 'slack 401: invalid token' };
      if (!res.ok) return { ok: false, detail: `slack ${res.status}` };
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (json.ok === true) return { ok: true };
      return { ok: false, detail: `slack auth.test: ${json.error ?? 'unknown_error'}` };
    } catch (err) {
      // Don't echo the credential. The route-layer audit guards this
      // already; defense-in-depth here too.
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, detail: `slack verify failed: ${message}` };
    }
  }

  return {
    kind: 'slack',
    poll,
    verifyCredential,
  };
}
