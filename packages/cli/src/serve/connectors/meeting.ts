import type {
  EventInput,
  PollContext,
  PollResult,
  SourceConnector,
  VerifyCredentialResult,
} from './types.js';

/**
 * Meeting transcript connector (AGT-393). Emits **only terminal events**:
 *
 *   - meeting finalized → `meeting:<provider>:<meeting-id>`
 *
 * Spike (2026-05-21): picked **Granola** for v1 because (a) its public API
 * exposes a stable `updated_since` filter and surfaces both raw transcript
 * and structured AI highlights (TL;DR, decisions, action_items), (b) a
 * single workspace-scoped API key authenticates polling — the same shape
 * as the GitHub PAT model — and (c) it's the tool the operator already
 * uses day-to-day. Fathom (next-cleanest API, also viable) and Zoom AI
 * Companion (closed ecosystem, weakest fit) are deferred. The provider
 * dispatcher inside `poll()` keeps the route open for additional
 * providers — they slot in next to `pollGranola()` without touching the
 * registry or admin surface.
 *
 * Subscription pattern is the provider name (e.g. `granola`). One
 * connector instance services every meeting subscription.
 *
 * Credentials are API keys read from `ctx.credential` (decrypted by the
 * vault). The connector throws on missing credential — the scheduler's
 * per-poll error branch isolates the failure.
 *
 * Cursor strategy
 * ---------------
 * Granola's `/v2/meetings?updated_since=` returns meetings whose
 * `updated_at` is greater than or equal to the timestamp. We bound the
 * window by tracking the newest `updated_at` we've considered and
 * bumping it 1ms before feeding it back in on the next tick (mirrors
 * the GitHub connector — boundary re-fetches are wasted bandwidth even
 * though the `events_sub_id_unique` index would dedup the row).
 *
 * Meetings still in progress (`state != 'completed'`) or with the
 * transcript still being processed (empty/missing `transcript`) are
 * skipped — they re-surface on a later tick when their `updated_at`
 * bumps past the cursor.
 *
 * Rate limiting
 * -------------
 * 429 → throw `MeetingRateLimitError`. The scheduler's per-poll error
 * branch records the failure without bumping `last_polled_at`; the next
 * tick retries.
 *
 * Episode key vs event id
 * -----------------------
 * `episodeKey` groups sibling memories under one meeting — a long
 * multi-topic call may produce N memories sharing `meeting:<p>:<id>`
 * once the curator segments it. `id` is per-emission and deterministic
 * so re-polls `INSERT OR IGNORE` against the existing row:
 * `meeting:<provider>:<meeting-id>:finalized`. There's exactly one
 * terminal pathway per meeting (finalized) so no extra suffix
 * disambiguation is needed today.
 *
 * Webhook mode (follow-on)
 * ------------------------
 * Granola supports HMAC-signed webhooks for the `meeting.finalized`
 * event. v1 ships polling only — simpler ops, no public ingress to
 * stand up, and it matches the proven GitHub pattern. The webhook
 * handler is intentionally a type-only stub at the bottom of this file
 * so the follow-on PR has a clear seam.
 *
 * Tests pass a `fetchImpl` and `now` to make HTTP and time injectable
 * without spinning up a real Granola.
 */

export interface MeetingCursor {
  /**
   * `updated_at` of the newest meeting we've already considered, ISO8601.
   * Passed verbatim as `updated_since=` on the next poll, after a 1ms
   * bump so Granola's inclusive boundary doesn't re-return the same row.
   * We bump it *after* a successful poll completes, even if the items
   * were already-emitted — a re-emission via the unique index is
   * harmless but a re-fetch is wasteful.
   */
  updatedSince?: string;
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface CreateMeetingConnectorOptions {
  /**
   * HTTP impl. Defaults to global `fetch`. Tests inject a stub that
   * returns canned responses keyed by URL.
   */
  fetchImpl?: FetchFn;
  /** Base URL override for tests. Defaults to `https://api.granola.ai`. */
  granolaBaseUrl?: string;
  /** Clock seam for tests; defaults to `() => new Date()`. */
  now?: () => Date;
}

export class MeetingRateLimitError extends Error {
  readonly resetAt: Date;
  constructor(resetAt: Date) {
    super(`meeting connector rate-limited until ${resetAt.toISOString()}`);
    this.name = 'MeetingRateLimitError';
    this.resetAt = resetAt;
  }
}

interface GranolaAttendee {
  email?: string | null;
  name?: string | null;
}

interface GranolaCreator {
  email?: string | null;
  name?: string | null;
}

/**
 * Subset of Granola's meeting record we read. The API returns more
 * fields we currently ignore. `state` transitions:
 * `scheduled` → `in_progress` → `completed`. We only emit on
 * `completed` with a non-empty `transcript`.
 */
interface GranolaMeeting {
  id: string;
  title: string | null;
  state: 'scheduled' | 'in_progress' | 'completed' | string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  ended_at: string | null;
  creator?: GranolaCreator | null;
  attendees?: GranolaAttendee[];
  /** Plaintext transcript. May be null/empty while post-processing runs. */
  transcript?: string | null;
  /** AI-enhanced notes/summary text. Null until processing completes. */
  notes?: string | null;
  /** Structured highlights when the source provides them. */
  highlights?: GranolaHighlights | null;
}

interface GranolaActionItem {
  owner?: string | null;
  text: string;
}

interface GranolaHighlights {
  tldr?: string | null;
  decisions?: string[] | null;
  action_items?: GranolaActionItem[] | null;
  key_topics?: string[] | null;
}

const DEFAULT_GRANOLA_BASE_URL = 'https://api.granola.ai';
const PROVIDER_GRANOLA = 'granola';

function parsePattern(pattern: string): { provider: string } {
  const trimmed = pattern.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]*$/.test(trimmed)) {
    throw new Error(
      `meeting connector: pattern must be a provider name (e.g. "granola"), got ${JSON.stringify(pattern)}`,
    );
  }
  return { provider: trimmed };
}

function maxIso(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

export function createMeetingConnector(
  opts: CreateMeetingConnectorOptions = {},
): SourceConnector<MeetingCursor> {
  const granolaBaseUrl = opts.granolaBaseUrl ?? DEFAULT_GRANOLA_BASE_URL;
  const now = opts.now ?? (() => new Date());
  // Defer the global-fetch lookup to call time so test environments that
  // patch globalThis.fetch after this module loads still get picked up.
  const fetchImpl: FetchFn = opts.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));

  async function granolaFetch(
    token: string,
    path: string,
    extra?: { query?: Record<string, string> },
  ): Promise<unknown> {
    const url = new URL(granolaBaseUrl + path);
    if (extra?.query) {
      for (const [k, v] of Object.entries(extra.query)) {
        url.searchParams.set(k, v);
      }
    }
    const res = await fetchImpl(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': 'open-think-server',
      },
    });

    // Rate-limit branch — throw a typed error so the scheduler's per-poll
    // error branch reports it without bumping last_polled_at.
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('Retry-After') ?? '60');
      throw new MeetingRateLimitError(new Date(now().getTime() + retryAfter * 1000));
    }
    if (res.status === 401) {
      throw new Error(
        `granola ${path}: 401 unauthorized (API key may be invalid or revoked)`,
      );
    }
    if (!res.ok) {
      throw new Error(`granola ${path}: ${res.status} ${res.statusText}`);
    }

    return await res.json();
  }

  async function listGranolaMeetings(
    token: string,
    updatedSince: string | undefined,
  ): Promise<GranolaMeeting[]> {
    // TODO(pagination): Single-page fetch (per_page=100, no cursor loop).
    // For workspaces that finalize >100 meetings between poll ticks the
    // tail is silently deferred to the next tick (the `updated_since`
    // cursor advances past page 1's newest, so older items beyond
    // position 100 are not re-fetched). Acceptable for low-volume teams;
    // revisit when a high-volume workspace adopts the proxy.
    const query: Record<string, string> = {
      per_page: '100',
      sort: 'updated_at:asc',
    };
    if (updatedSince) query.updated_since = updatedSince;
    const json = (await granolaFetch(token, '/v2/meetings', { query })) as
      | { meetings: GranolaMeeting[] }
      | GranolaMeeting[];
    // Granola's documented response shape is `{ meetings: [...] }`.
    // Defensive against a future flat-array variant.
    if (Array.isArray(json)) return json;
    if (json && Array.isArray(json.meetings)) return json.meetings;
    return [];
  }

  function shapeAttendee(a: GranolaAttendee) {
    return {
      email: a.email ?? null,
      name: a.name ?? null,
    };
  }

  function shapeHighlights(h: GranolaHighlights | null | undefined) {
    if (!h) return null;
    return {
      tldr: h.tldr ?? null,
      decisions: h.decisions ?? null,
      action_items: h.action_items ?? null,
      key_topics: h.key_topics ?? null,
    };
  }

  function emitForGranolaMeeting(m: GranolaMeeting): EventInput {
    return {
      id: `meeting:${PROVIDER_GRANOLA}:${m.id}:finalized`,
      episodeKey: `meeting:${PROVIDER_GRANOLA}:${m.id}`,
      terminal: true,
      payload: JSON.stringify({
        kind: 'meeting.finalized',
        provider: PROVIDER_GRANOLA,
        meeting_id: m.id,
        title: m.title ?? null,
        creator: m.creator
          ? { email: m.creator.email ?? null, name: m.creator.name ?? null }
          : null,
        attendees: (m.attendees ?? []).map(shapeAttendee),
        started_at: m.started_at,
        ended_at: m.ended_at,
        updated_at: m.updated_at,
        transcript: m.transcript ?? '',
        notes: m.notes ?? null,
        highlights: shapeHighlights(m.highlights),
        final_state: 'finalized',
      }),
    };
  }

  async function pollGranola(
    ctx: PollContext<MeetingCursor>,
  ): Promise<PollResult<MeetingCursor>> {
    if (!ctx.credential) {
      throw new Error(
        'meeting connector: missing credential (store a Granola API key via vault)',
      );
    }
    const token = ctx.credential;
    const cursorIn = ctx.cursor ?? {};
    let updatedSince = cursorIn.updatedSince;

    const meetings = await listGranolaMeetings(token, updatedSince);
    const events: EventInput[] = [];
    for (const m of meetings) {
      // Connector-side terminal gate: emit only when the meeting is
      // finalized AND a transcript is present. A 'completed' meeting
      // whose transcript is still processing will re-surface on a later
      // tick once its `updated_at` bumps past the cursor — at which
      // point the transcript will be available.
      //
      // No special-case topic-segmentation logic lives here. AC #2
      // forbids it: a multi-topic meeting goes out as one big event,
      // and the curator (`runTerminalEventCuration`) is responsible
      // for splitting it into N memories.
      const isFinalized =
        m.state === 'completed' &&
        typeof m.transcript === 'string' &&
        m.transcript.length > 0;
      if (isFinalized) {
        events.push(emitForGranolaMeeting(m));
      }
      // Advance the cursor whether we emit or not. Re-fetching a
      // still-processing meeting is wasted bandwidth, and once the
      // transcript lands the meeting's `updated_at` will bump again
      // past wherever the cursor is. The events unique index protects
      // against any boundary re-emission if we underestimate.
      updatedSince = maxIso(updatedSince, m.updated_at);
    }

    // Bump cursor 1ms past the newest we just considered so Granola's
    // inclusive `updated_since` doesn't re-return the same row.
    const nextUpdatedSince = bumpSinceBy1Ms(updatedSince);
    return {
      events,
      nextCursor: {
        ...(nextUpdatedSince !== undefined ? { updatedSince: nextUpdatedSince } : {}),
      },
    };
  }

  async function poll(
    ctx: PollContext<MeetingCursor>,
  ): Promise<PollResult<MeetingCursor>> {
    const { provider } = parsePattern(ctx.subscription.pattern);
    if (provider === PROVIDER_GRANOLA) {
      return pollGranola(ctx);
    }
    throw new Error(
      `meeting connector: provider "${provider}" not yet supported (v1 ships granola only)`,
    );
  }

  async function verifyCredential(credential: string): Promise<VerifyCredentialResult> {
    if (credential.length === 0) {
      return { ok: false, detail: 'meeting connector requires a non-empty API key' };
    }
    // verifyCredential receives only the credential — not the
    // subscription pattern — so it can't dispatch per-provider. v1
    // ships granola only, so we probe granola's `/v2/me`. When a second
    // provider lands, this needs a per-provider switch (either the
    // contract gains a hint or we pre-flight all known providers).
    try {
      const res = await fetchImpl(`${granolaBaseUrl}/v2/me`, {
        headers: {
          Authorization: `Bearer ${credential}`,
          Accept: 'application/json',
          'User-Agent': 'open-think-server',
        },
      });
      if (res.status === 200) return { ok: true };
      if (res.status === 401) return { ok: false, detail: 'granola 401: invalid API key' };
      return { ok: false, detail: `granola ${res.status}` };
    } catch (err) {
      // Don't echo the credential — surface only the underlying error
      // message. The no-leak audit test guards this at the route layer
      // but defense-in-depth here too.
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, detail: `meeting verify failed: ${message}` };
    }
  }

  return {
    kind: 'meeting',
    poll,
    verifyCredential,
  };
}

/**
 * Add 1 millisecond to an ISO8601 timestamp so an `updated_since=`
 * re-poll doesn't re-return the boundary row. Returns undefined if
 * input is undefined.
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

/**
 * Webhook handler stub (AGT-393 follow-on). When a meeting provider
 * supports HMAC-signed webhooks on `meeting.finalized`, route
 * verification and EventInput construction will live here. Intentionally
 * not wired into any HTTP route — exporting the type only so the
 * follow-on PR has a clear seam.
 */
export interface MeetingWebhookEnvelope {
  provider: string;
  meeting_id: string;
  /** HMAC signature header value (Granola: `X-Granola-Signature`). */
  signature: string;
  /** Raw request body — required intact for HMAC verification. */
  raw_body: string;
}
