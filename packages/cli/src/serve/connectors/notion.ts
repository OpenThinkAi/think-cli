import type {
  EventInput,
  PollContext,
  PollResult,
  SourceConnector,
  VerifyCredentialResult,
} from './types.js';

/**
 * Notion source connector (AGT-395). Emits a **terminal event** every
 * time a page is observed with the "canonical" signal set on the
 * configured property — including each subsequent edit that re-asserts
 * the signal.
 *
 *   - canonical page observed   → `notion:<pattern>:<page-id>:<edit-iso>`
 *
 * Notion pages are perpetually living, so unlike GitHub PRs there's no
 * intrinsic terminal state. The team opts in to capture per-page by
 * setting a property (default: a checkbox named `canonical` flipped to
 * `true`); the connector treats each observation of the asserted signal
 * as a terminal event. Subsequent edits that leave the signal asserted
 * produce **new** events under the same `episodeKey`, so the curator
 * sees a fresh memory while recall groups it with prior versions.
 *
 * Subscription pattern shapes
 * ---------------------------
 * Two forms, both with optional `?prop=...&type=...&value=...` query
 * for non-default canonical-property configuration:
 *
 *   - `db:<database-uuid>` — uses `POST /v1/databases/{id}/query` with a
 *     `last_edited_time` filter (server-side incremental). Most efficient;
 *     recommended whenever the source-of-truth is a single Notion database.
 *   - `ws:<alias>` — uses `POST /v1/search` and filters post-fetch on the
 *     canonical property. `alias` is operator-chosen and only used to
 *     name the episode_key — Notion internal-integration tokens are
 *     workspace-scoped, so the token itself selects the workspace.
 *
 * Defaults: `prop=canonical`, `type=checkbox`. For select/multi_select,
 * pass `value=Canonical` (or whatever option name marks the doc).
 *
 *   `db:abc...def`                                     → checkbox `canonical` = true
 *   `db:abc...def?prop=status&type=select&value=Done`  → select `status` is "Done"
 *   `ws:eng?prop=publish&type=checkbox`                → checkbox `publish` = true (workspace-wide)
 *
 * Credentials are Notion internal-integration tokens read from
 * `ctx.credential`. The connector throws on missing credential — the
 * scheduler's per-poll error branch isolates the failure.
 *
 * Cursor strategy
 * ---------------
 * `lastEditedTime` is the ISO `last_edited_time` of the newest page we've
 * already evaluated. The `db:` form passes it back to Notion as the
 * `last_edited_time > X` filter (server-side); the `ws:` form pages
 * results descending by `last_edited_time` and breaks at the cursor.
 * On every successful poll we advance to the max seen — even pages whose
 * canonical signal was *not* set still advance the cursor so we don't
 * re-evaluate them on the next tick.
 *
 * Event id encodes the edit time (millisecond precision), so an edit
 * that re-asserts canonical at a later timestamp produces a distinct
 * event id under the same `episodeKey`. The proxy's
 * `events_sub_id_unique` index catches any boundary-case re-emissions
 * within the same edit timestamp.
 *
 * Content serialization
 * ---------------------
 * `blocks.children.list` is recursive in Notion's data model. We walk
 * the tree (single page_size=100 per level — paginate when `has_more`)
 * and serialize each block to a markdown-ish line based on `type`:
 *
 *   - `paragraph` / `quote` / `callout`         → plain text line
 *   - `heading_1|2|3`                            → `#` / `##` / `###`
 *   - `bulleted_list_item`                       → `- `
 *   - `numbered_list_item`                       → `1. `
 *   - `to_do`                                    → `- [ ] ` or `- [x] `
 *   - `code`                                     → ```` ``` ```` fenced (with language)
 *   - `divider`                                  → `---`
 *   - other (toggle, child_page, …)              → flatten rich_text if any
 *
 * Markdown-ish on purpose — the downstream curator handles narrative
 * shaping, so we don't need to be precise. The goal is "all the words
 * the page contains, in roughly the order they appear, with enough
 * structural markers for a human to skim".
 *
 * Rate limiting
 * -------------
 * Notion's documented rate limit is roughly 3 requests/second average
 * per integration; bursts return `429 Too Many Requests` with
 * `Retry-After`. Mirroring github.ts: throw a typed error on 429 so the
 * scheduler's per-poll error branch reports it without bumping
 * `last_polled_at`; the next tick retries.
 *
 * Tests pass a `fetchImpl` and `now` to make HTTP and time injectable
 * without spinning up a real Notion workspace.
 */

export interface NotionCursor {
  /**
   * ISO `last_edited_time` of the newest page we've already considered.
   * Used as `last_edited_time > X` filter for `db:` patterns and as a
   * descending-paging break condition for `ws:` patterns.
   */
  lastEditedTime?: string;
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface CreateNotionConnectorOptions {
  /** HTTP impl. Defaults to global `fetch`. Tests inject a stub. */
  fetchImpl?: FetchFn;
  /** Base URL override for tests. Defaults to `https://api.notion.com`. */
  baseUrl?: string;
  /** Clock seam for tests; defaults to `() => new Date()`. */
  now?: () => Date;
  /** Notion API version header. Defaults to a pinned stable value. */
  notionVersion?: string;
}

export class NotionRateLimitError extends Error {
  readonly resetAt: Date;
  constructor(resetAt: Date) {
    super(`notion rate-limited until ${resetAt.toISOString()}`);
    this.name = 'NotionRateLimitError';
    this.resetAt = resetAt;
  }
}

type CanonicalType = 'checkbox' | 'select' | 'multi_select';

interface ParsedPattern {
  /** `db` (database-scoped) or `ws` (workspace-search-scoped). */
  scope: 'db' | 'ws';
  /** Database UUID for `db:`; operator-chosen alias for `ws:`. */
  ref: string;
  /** Property name to inspect for the canonical signal. */
  prop: string;
  /** Property type — picks the comparison branch. */
  type: CanonicalType;
  /**
   * For `select` / `multi_select`, the option name that marks a page as
   * canonical. Ignored for `checkbox` (boolean compare against `true`).
   */
  value?: string;
}

interface NotionRichText {
  plain_text?: string;
  text?: { content?: string };
}

interface NotionUser {
  id?: string;
  name?: string | null;
  type?: string;
}

interface NotionProperty {
  id?: string;
  type?: string;
  checkbox?: boolean;
  select?: { id?: string; name?: string } | null;
  multi_select?: Array<{ id?: string; name?: string }>;
  title?: NotionRichText[];
  rich_text?: NotionRichText[];
}

interface NotionPage {
  id: string;
  object?: 'page';
  created_time?: string;
  last_edited_time: string;
  archived?: boolean;
  properties?: Record<string, NotionProperty>;
  parent?: { type?: string; database_id?: string; page_id?: string; workspace?: boolean };
  url?: string;
  created_by?: NotionUser | null;
  last_edited_by?: NotionUser | null;
}

interface NotionPageList {
  results: NotionPage[];
  has_more?: boolean;
  next_cursor?: string | null;
}

interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  archived?: boolean;
  paragraph?: { rich_text?: NotionRichText[] };
  heading_1?: { rich_text?: NotionRichText[] };
  heading_2?: { rich_text?: NotionRichText[] };
  heading_3?: { rich_text?: NotionRichText[] };
  bulleted_list_item?: { rich_text?: NotionRichText[] };
  numbered_list_item?: { rich_text?: NotionRichText[] };
  to_do?: { rich_text?: NotionRichText[]; checked?: boolean };
  quote?: { rich_text?: NotionRichText[] };
  callout?: { rich_text?: NotionRichText[] };
  code?: { rich_text?: NotionRichText[]; language?: string };
  // Fallback: arbitrary unknown block types may still carry rich_text.
  [extra: string]: unknown;
}

interface NotionBlockList {
  results: NotionBlock[];
  has_more?: boolean;
  next_cursor?: string | null;
}

const DEFAULT_BASE_URL = 'https://api.notion.com';
const DEFAULT_NOTION_VERSION = '2022-06-28';
const DEFAULT_PROP = 'canonical';
const DEFAULT_TYPE: CanonicalType = 'checkbox';
const PAGE_SIZE = 100;

/**
 * Parse the subscription pattern into the connector's internal shape.
 * The grammar is intentionally narrow — operators paste a pattern from
 * docs; we'd rather throw clearly than misinterpret a typo.
 *
 * Exported for tests.
 */
export function parsePattern(pattern: string): ParsedPattern {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) {
    throw new Error('notion connector: pattern is empty');
  }
  // Split into "<scope>:<ref>" and optional "?query".
  const [pathPart, queryPart] = trimmed.split('?', 2);
  const colon = pathPart.indexOf(':');
  if (colon < 0) {
    throw new Error(
      `notion connector: pattern must start with "db:" or "ws:", got ${JSON.stringify(pattern)}`,
    );
  }
  const scopeRaw = pathPart.slice(0, colon);
  const ref = pathPart.slice(colon + 1).trim();
  if (scopeRaw !== 'db' && scopeRaw !== 'ws') {
    throw new Error(
      `notion connector: unsupported scope ${JSON.stringify(scopeRaw)} — use "db:<database-uuid>" or "ws:<alias>"`,
    );
  }
  if (ref.length === 0) {
    throw new Error(
      `notion connector: pattern ${JSON.stringify(pattern)} missing ${scopeRaw === 'db' ? 'database uuid' : 'workspace alias'}`,
    );
  }

  let prop = DEFAULT_PROP;
  let type: CanonicalType = DEFAULT_TYPE;
  let value: string | undefined;
  if (queryPart) {
    const params = new URLSearchParams(queryPart);
    const propParam = params.get('prop');
    if (propParam) prop = propParam;
    const typeParam = params.get('type');
    if (typeParam) {
      if (typeParam !== 'checkbox' && typeParam !== 'select' && typeParam !== 'multi_select') {
        throw new Error(
          `notion connector: unsupported canonical type ${JSON.stringify(typeParam)} — use checkbox|select|multi_select`,
        );
      }
      type = typeParam;
    }
    const valueParam = params.get('value');
    if (valueParam !== null) value = valueParam;
  }

  if ((type === 'select' || type === 'multi_select') && (!value || value.length === 0)) {
    throw new Error(
      `notion connector: type=${type} requires a non-empty value= in pattern (e.g. "?type=select&value=Canonical")`,
    );
  }

  return { scope: scopeRaw, ref, prop, type, value };
}

/**
 * Per-pattern episode-key namespace. `notion:db:<uuid>:<page-id>` for
 * database-scoped subs, `notion:ws:<alias>:<page-id>` for workspace
 * search subs. Including the scope keeps two different subs that happen
 * to surface the same page-id from colliding in episode_key.
 */
function episodeKeyFor(p: ParsedPattern, pageId: string): string {
  return `notion:${p.scope}:${p.ref}:${pageId}`;
}

function eventIdFor(p: ParsedPattern, page: NotionPage): string {
  return `${episodeKeyFor(p, page.id)}:${page.last_edited_time}`;
}

function maxIso(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function richTextToString(rt: NotionRichText[] | undefined): string {
  if (!rt) return '';
  return rt
    .map((r) => r.plain_text ?? r.text?.content ?? '')
    .join('')
    .trim();
}

/**
 * Walk a page's block tree and serialize to a markdown-ish string. The
 * downstream curator handles narrative shaping, so we keep this simple:
 * preserve order, retain enough structural markers for skim.
 *
 * Exported for tests.
 */
export function serializeBlocks(blocks: NotionBlock[], indent = 0): string {
  const lines: string[] = [];
  const pad = '  '.repeat(indent);
  for (const b of blocks) {
    const t = b.type;
    const rt = (b as Record<string, unknown>)[t] as
      | { rich_text?: NotionRichText[]; language?: string; checked?: boolean }
      | undefined;
    const text = richTextToString(rt?.rich_text);
    switch (t) {
      case 'paragraph':
      case 'quote':
      case 'callout':
        if (text) lines.push(`${pad}${text}`);
        break;
      case 'heading_1':
        if (text) lines.push(`${pad}# ${text}`);
        break;
      case 'heading_2':
        if (text) lines.push(`${pad}## ${text}`);
        break;
      case 'heading_3':
        if (text) lines.push(`${pad}### ${text}`);
        break;
      case 'bulleted_list_item':
        if (text) lines.push(`${pad}- ${text}`);
        break;
      case 'numbered_list_item':
        if (text) lines.push(`${pad}1. ${text}`);
        break;
      case 'to_do': {
        const mark = rt?.checked ? 'x' : ' ';
        if (text) lines.push(`${pad}- [${mark}] ${text}`);
        break;
      }
      case 'code': {
        const lang = rt?.language ?? '';
        lines.push(`${pad}\`\`\`${lang}`);
        if (text) lines.push(text);
        lines.push(`${pad}\`\`\``);
        break;
      }
      case 'divider':
        lines.push(`${pad}---`);
        break;
      default:
        // Unknown block type — fall back to whatever rich_text we found.
        if (text) lines.push(`${pad}${text}`);
        break;
    }
    // Children are fetched and attached out-of-band by the connector
    // (see `fetchBlockTree`); they appear under `_children` here so the
    // serializer can recurse without making another HTTP call.
    const children = (b as { _children?: NotionBlock[] })._children;
    if (children && children.length > 0) {
      lines.push(serializeBlocks(children, indent + 1));
    }
  }
  return lines.filter((l) => l.length > 0).join('\n');
}

/**
 * Read the page title out of `properties`. Notion guarantees exactly
 * one `title`-typed property per page; the property name varies (often
 * "Name" for database pages, "title" for pages with no parent
 * database). We scan rather than assume a key.
 */
function pageTitle(page: NotionPage): string {
  const props = page.properties ?? {};
  for (const value of Object.values(props)) {
    if (value?.type === 'title') {
      return richTextToString(value.title);
    }
  }
  return '';
}

function isCanonical(page: NotionPage, p: ParsedPattern): boolean {
  const prop = page.properties?.[p.prop];
  if (!prop) return false;
  if (p.type === 'checkbox') {
    return prop.type === 'checkbox' && prop.checkbox === true;
  }
  if (p.type === 'select') {
    return prop.type === 'select' && prop.select?.name === p.value;
  }
  if (p.type === 'multi_select') {
    return (
      prop.type === 'multi_select' &&
      Array.isArray(prop.multi_select) &&
      prop.multi_select.some((o) => o.name === p.value)
    );
  }
  return false;
}

export function createNotionConnector(
  opts: CreateNotionConnectorOptions = {},
): SourceConnector<NotionCursor> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const now = opts.now ?? (() => new Date());
  const notionVersion = opts.notionVersion ?? DEFAULT_NOTION_VERSION;
  // Defer the global-fetch lookup to call time so test environments that
  // patch globalThis.fetch after this module loads still get picked up.
  const fetchImpl: FetchFn = opts.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));

  async function notionFetch(
    token: string,
    path: string,
    init?: { method?: 'GET' | 'POST'; body?: unknown },
  ): Promise<unknown> {
    const url = baseUrl + path;
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Notion-Version': notionVersion,
      'User-Agent': 'open-think-server',
    };
    if (init?.body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetchImpl(url, {
      method,
      headers,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });

    if (res.status === 429) {
      // Retry-After is documented as seconds. Default to 30s if absent —
      // long enough to space out the next tick, short enough that a
      // misconfigured proxy isn't stuck.
      const retryAfter = Number(res.headers.get('Retry-After') ?? '30');
      throw new NotionRateLimitError(new Date(now().getTime() + retryAfter * 1000));
    }
    if (res.status === 401) {
      throw new Error(`notion ${path}: 401 unauthorized (check integration token)`);
    }
    if (!res.ok) {
      throw new Error(`notion ${path}: ${res.status} ${res.statusText}`);
    }
    return await res.json();
  }

  async function queryDatabase(
    token: string,
    databaseId: string,
    lastEditedTime: string | undefined,
  ): Promise<NotionPage[]> {
    // TODO(pagination): Single-page fetch (page_size=100, no has_more loop).
    // For databases that mutate >100 rows between poll ticks the tail is
    // silently deferred to the next tick — the `last_edited_time > X`
    // filter on the ascending sort plus the advancing cursor will pick it
    // up on subsequent polls. Acceptable for low-volume sources; revisit
    // when we add a connector for a busier source.
    const body: Record<string, unknown> = {
      page_size: PAGE_SIZE,
      sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }],
    };
    if (lastEditedTime) {
      body.filter = {
        timestamp: 'last_edited_time',
        last_edited_time: { after: lastEditedTime },
      };
    }
    const json = (await notionFetch(token, `/v1/databases/${databaseId}/query`, {
      method: 'POST',
      body,
    })) as NotionPageList;
    return Array.isArray(json.results) ? json.results : [];
  }

  async function searchWorkspace(
    token: string,
    lastEditedTime: string | undefined,
  ): Promise<NotionPage[]> {
    // TODO(pagination): Same single-page caveat as queryDatabase. Search has
    // no server-side last_edited_time filter — we sort descending and break
    // when we cross the cursor boundary. A workspace with >100 page edits
    // between ticks defers the tail to the next poll.
    const body: Record<string, unknown> = {
      page_size: PAGE_SIZE,
      filter: { value: 'page', property: 'object' },
      sort: { timestamp: 'last_edited_time', direction: 'descending' },
    };
    const json = (await notionFetch(token, `/v1/search`, {
      method: 'POST',
      body,
    })) as NotionPageList;
    const all = Array.isArray(json.results) ? json.results : [];
    if (!lastEditedTime) return all;
    // Filter to "newer than cursor" — descending order means we can
    // safely take-while, but a defensive `filter` is robust against
    // future API changes that drop sort guarantees.
    return all.filter((p) => p.last_edited_time > lastEditedTime);
  }

  async function fetchBlockChildren(
    token: string,
    blockId: string,
  ): Promise<{ blocks: NotionBlock[]; truncated: boolean }> {
    // TODO(pagination): Single-page fetch. Pages with >100 top-level blocks
    // get their tail dropped; the head still curates. Recurses one level for
    // blocks marked `has_children`. Deep nesting (>1 level beyond root) is
    // followed via the recursive call. `truncated` is surfaced upward so the
    // caller can flag a partial event payload (downstream consumers — and the
    // curator — get to know the page content may be incomplete).
    const json = (await notionFetch(
      token,
      `/v1/blocks/${blockId}/children?page_size=${PAGE_SIZE}`,
    )) as NotionBlockList;
    const blocks = Array.isArray(json.results) ? json.results : [];
    let truncated = json.has_more === true;
    for (const b of blocks) {
      if (b.has_children) {
        const child = await fetchBlockChildren(token, b.id);
        (b as { _children?: NotionBlock[] })._children = child.blocks;
        if (child.truncated) truncated = true;
      }
    }
    return { blocks, truncated };
  }

  async function emitForCanonicalPage(
    token: string,
    p: ParsedPattern,
    page: NotionPage,
  ): Promise<EventInput> {
    const { blocks, truncated } = await fetchBlockChildren(token, page.id);
    const content = serializeBlocks(blocks);
    return {
      id: eventIdFor(p, page),
      episodeKey: episodeKeyFor(p, page.id),
      terminal: true,
      payload: JSON.stringify({
        kind: 'notion.page.canonical',
        scope: p.scope,
        ref: p.ref,
        page_id: page.id,
        title: pageTitle(page),
        url: page.url ?? null,
        property: p.prop,
        property_type: p.type,
        property_value: p.value ?? null,
        last_edited_time: page.last_edited_time,
        created_time: page.created_time ?? null,
        last_edited_by: page.last_edited_by?.id ?? null,
        archived: page.archived ?? false,
        content,
        // True if ANY block-fetch in the recursive walk hit `has_more`.
        // Curator + downstream consumers can flag the memory as partial.
        content_truncated: truncated,
        final_state: 'canonical',
      }),
    };
  }

  async function poll(ctx: PollContext<NotionCursor>): Promise<PollResult<NotionCursor>> {
    if (!ctx.credential) {
      throw new Error('notion connector: missing credential (store an integration token via vault)');
    }
    const pattern = parsePattern(ctx.subscription.pattern);
    const token = ctx.credential;
    const cursorIn = ctx.cursor ?? {};
    let lastEditedTime = cursorIn.lastEditedTime;

    const pages =
      pattern.scope === 'db'
        ? await queryDatabase(token, pattern.ref, lastEditedTime)
        : await searchWorkspace(token, lastEditedTime);

    const events: EventInput[] = [];
    for (const page of pages) {
      // Always advance the cursor past this page's edit time, even when
      // canonical is *not* set — otherwise a non-canonical edit at time T
      // would cause the same row to re-poll forever. The unique index on
      // (subscription_id, event_id) is the safety net for any boundary
      // re-emission within the same edit timestamp.
      lastEditedTime = maxIso(lastEditedTime, page.last_edited_time);
      if (page.archived) continue;
      if (!isCanonical(page, pattern)) continue;
      events.push(await emitForCanonicalPage(token, pattern, page));
    }

    return {
      events,
      nextCursor: lastEditedTime !== undefined ? { lastEditedTime } : {},
    };
  }

  async function verifyCredential(credential: string): Promise<VerifyCredentialResult> {
    // Probe `GET /v1/users/me` — cheapest authenticated endpoint, also
    // confirms the token type (returns the bot user for integration
    // tokens). 200 → ok, 401 → bad token, anything else → uncertain
    // but surfaceable.
    if (credential.length === 0) {
      return { ok: false, detail: 'notion requires a non-empty integration token' };
    }
    try {
      const res = await fetchImpl(`${baseUrl}/v1/users/me`, {
        headers: {
          Authorization: `Bearer ${credential}`,
          'Notion-Version': notionVersion,
          'User-Agent': 'open-think-server',
        },
      });
      if (res.status === 200) return { ok: true };
      if (res.status === 401) return { ok: false, detail: 'notion 401: invalid integration token' };
      return { ok: false, detail: `notion ${res.status}` };
    } catch (err) {
      // Don't echo the credential — surface only the underlying error
      // message. The no-leak audit test guards this at the route layer
      // but defense-in-depth here too.
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, detail: `notion verify failed: ${message}` };
    }
  }

  return {
    kind: 'notion',
    poll,
    verifyCredential,
  };
}
