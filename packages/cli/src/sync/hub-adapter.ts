/**
 * Hub adapter — the authenticated HTTP client half of cortex-sync (AGT-573).
 *
 * This is the OPEN-CORE client: a dumb, authenticated push/pull client that
 * talks the AGT-570 wire protocol (`hub-protocol.ts`, `docs/cortex-sync-
 * protocol.md`) to the AGT-572 `think serve` routes (`POST /v1/cortex-sync/push`,
 * `GET /v1/cortex-sync/pull`). It sits alongside `git-adapter.ts` and
 * `local-fs-adapter.ts` and mirrors the local-fs adapter's structure exactly —
 * same push/pull/sync shape, same serialization, same cursor discipline — but
 * over HTTP instead of the filesystem.
 *
 * ---------------------------------------------------------------------------
 * Open-core boundary (AC4) — load-bearing, do not breach
 * ---------------------------------------------------------------------------
 * This adapter contains ZERO paid / hub-proprietary logic. No billing, no
 * multi-tenant resolution, no org/ACL concepts, no seat math. It is a static-
 * token client: push the lines this peer authored, pull lines by server_seq
 * cursor, with a configured bearer token. A "bring-your-own-hub" user runs
 * `think serve` (also OSS/MIT) and points this adapter at it for free.
 * Anything fancier — tenancy, entitlements, org membership — belongs in the
 * private think-hub repo, never here. Keeping this file dumb is what keeps it
 * MIT-licensable inside think-cli.
 *
 * ---------------------------------------------------------------------------
 * Cursor discipline (AC1, AC2) — mirrors local-fs-adapter
 * ---------------------------------------------------------------------------
 * - **push** uses `memories.sync_version` as the local push cursor, keyed
 *   `(cortex, 'hub', 'push')` in `sync_cursors`. It serializes only rows this
 *   peer authored (the origin_peer_id guard, AGT-250), skips tombstones, and
 *   advances the cursor to `maxVersion` ONLY after the POST succeeds. Replay
 *   on crash is safe: ids are content-derived and the server dedups via
 *   INSERT-OR-IGNORE, so re-pushing an already-stored line is a no-op.
 * - **pull** persists a single integer `server_seq` cursor keyed
 *   `(cortex, 'hub', 'pull')` (stored as the stringified server_seq — simpler
 *   than the fs per-file JSON map). It pages with `?cursor=&limit=`, ingests
 *   each line via `insertMemoryIfNotExists`, advances the cursor to the
 *   response's `nextCursor`, and loops while `hasMore` so one run drains the
 *   backlog. The cursor persists between runs, so a later run resumes
 *   incrementally (no full re-pull).
 *
 * The token is transport-level auth: it rides the `Authorization` header
 * (`bearerHeader`), never the JSON body, and is NEVER logged. Network and auth
 * failures are collected as soft errors into `SyncResult.errors` (never thrown
 * out of push/pull), matching the git/fs adapters' error discipline so a
 * failed sync degrades gracefully instead of crashing the caller.
 */
import { getConfig, getPeerId, type HubBackendConfig } from '../lib/config.js';
import {
  getMemoriesBySyncVersion,
  insertMemoryIfNotExists,
  getSyncCursor,
  setSyncCursor,
} from '../db/memory-queries.js';
import { validateEngramContent } from '../lib/sanitize.js';
import {
  bearerHeader,
  pushResponseSchema,
  pullResponseSchema,
  PULL_MAX_LIMIT,
  type WireMemoryLine,
} from './hub-protocol.js';
import type { SyncAdapter, SyncResult } from './types.js';

/** Page size requested on each pull. Stays at/under the server's hard cap. */
const PULL_PAGE_LIMIT = PULL_MAX_LIMIT;

/**
 * Injectable fetch. Production uses the global `fetch`; tests pass a stub that
 * routes to an in-memory `think serve` app (`app.fetch`) so the client+server
 * contract is exercised end-to-end. Typed against the global signature so the
 * default needs no wrapper.
 */
export type FetchLike = typeof fetch;

export class HubSyncAdapter implements SyncAdapter {
  readonly name = 'hub';

  // Test seam only — production leaves this undefined and uses global fetch.
  private readonly fetchImpl: FetchLike;

  constructor(fetchImpl?: FetchLike) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  isAvailable(): boolean {
    const hub = getConfig().cortex?.hub;
    return !!hub?.url;
  }

  // Cheap reachability probe. The contract (see SyncAdapter.isReachable)
  // requires we report a reachable-but-auth-rejecting host as REACHABLE, so
  // `--if-online` lets the subsequent real sync surface the auth error loudly
  // instead of silently skipping. We therefore probe the unauthenticated
  // health route and treat ANY HTTP response (including 401/403) as reachable;
  // only a transport-level failure (DNS, TCP, timeout) is "unreachable".
  async isReachable(): Promise<boolean> {
    const hub = this.getHub();
    if (!hub) return false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      try {
        // The host answered with *some* HTTP status — reachable, regardless of
        // whether it was 200, 401, 404, or 5xx. An auth-rejecting host must
        // not be reported unreachable (contract).
        await this.fetchImpl(this.url(hub, '/v1/health'), {
          method: 'GET',
          signal: controller.signal,
        });
        return true;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Transport failure (DNS/TCP/timeout/abort) — genuinely unreachable.
      return false;
    }
  }

  // Listing/creating remote cortexes is a hub-management concern with no
  // wire route in the v1 protocol (push/pull only). The hub auto-creates a
  // cortex partition on first push, so there's nothing to pre-create and
  // nothing to enumerate from the client. Honest no-ops keep the interface
  // satisfied without inventing protocol surface that doesn't exist.
  async listRemoteCortexes(): Promise<string[]> {
    return [];
  }

  async createCortex(_cortex: string): Promise<void> {
    // No-op: the hub creates the partition lazily on first push.
  }

  // ---------------------------------------------------------------------------
  // Push (AC1, AC3, AC4)
  // ---------------------------------------------------------------------------

  async push(cortex: string): Promise<SyncResult> {
    const result: SyncResult = { pushed: 0, pulled: 0, errors: [] };

    const hub = this.getHub();
    if (!hub) {
      result.errors.push('hub sync backend not configured (set cortex.hub.url + cortex.hub.token)');
      return result;
    }

    const cursorStr = getSyncCursor(cortex, this.name, 'push');
    const lastVersion = cursorStr ? parseInt(cursorStr, 10) : 0;

    const newMemories = getMemoriesBySyncVersion(cortex, lastVersion);
    if (newMemories.length === 0) return result;

    // Identical serialization + guards to local-fs-adapter.pushMemories:
    //   - skip tombstones (memories are immutable via sync)
    //   - skip rows not authored by this peer (origin_peer_id guard, AGT-250):
    //     a pulled row's sync_version bumps on ingest, so without this filter
    //     it would be re-emitted on the next push.
    // source_ids and decisions are written by us via JSON.stringify on insert,
    // so they parse without try/catch.
    const localPeer = getPeerId();
    const lines: WireMemoryLine[] = [];
    for (const m of newMemories) {
      if (m.deleted_at) continue;
      if (m.origin_peer_id !== localPeer) continue;
      const decisions = m.decisions ? (JSON.parse(m.decisions) as string[]) : [];
      lines.push({
        ts: m.ts,
        author: m.author,
        content: m.content,
        source_ids: JSON.parse(m.source_ids) as string[],
        kind: 'memory',
        ...(m.episode_key ? { episode_key: m.episode_key } : {}),
        ...(decisions.length > 0 ? { decisions } : {}),
        ...(m.origin_peer_id ? { origin_peer_id: m.origin_peer_id } : {}),
      });
    }

    // maxVersion spans ALL scanned rows (local and foreign) so the cursor
    // always advances past every row considered in this batch — mirrors the
    // fs adapter's all-tombstone / all-foreign cursor advance.
    const maxVersion = Math.max(...newMemories.map((m) => m.sync_version));
    const remoteCortex = hub.cortex ?? cortex;

    // Nothing of ours to push, but advance the cursor so we don't re-scan
    // these rows every push (matches local-fs / git adapters).
    if (lines.length === 0) {
      setSyncCursor(cortex, this.name, 'push', String(maxVersion));
      return result;
    }

    try {
      const res = await this.fetchImpl(this.url(hub, '/v1/cortex-sync/push'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: bearerHeader(hub.token),
        },
        body: JSON.stringify({ cortex: remoteCortex, lines }),
      });

      if (!res.ok) {
        // Surface auth/4xx/5xx as a loud soft-error — never a silent success.
        // The status text is included; the token is NEVER part of any logged
        // string (it lives only in the Authorization header above).
        result.errors.push(await this.httpError('push', res));
        return result; // cursor NOT advanced — a later push retries the batch
      }

      // Validate the response against the protocol schema (defensive; a
      // mis-shaped body from a wrong endpoint must not be silently accepted).
      const parsed = pushResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        result.errors.push('hub push: malformed response from server');
        return result; // cursor NOT advanced
      }

      // Cursor advances ONLY after a successful POST. Replay on crash is
      // correct: content-derived ids + server-side INSERT-OR-IGNORE make a
      // re-push idempotent (the server returns status:'duplicate').
      setSyncCursor(cortex, this.name, 'push', String(maxVersion));
      result.pushed += lines.length;
    } catch (err) {
      // Transport failure — soft error, cursor untouched so a later run retries.
      result.errors.push(`hub push failed: ${errMessage(err)}`);
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Pull (AC1, AC2, AC3)
  // ---------------------------------------------------------------------------

  async pull(cortex: string): Promise<SyncResult> {
    const result: SyncResult = { pushed: 0, pulled: 0, errors: [] };

    const hub = this.getHub();
    if (!hub) {
      result.errors.push('hub sync backend not configured (set cortex.hub.url + cortex.hub.token)');
      return result;
    }

    const remoteCortex = hub.cortex ?? cortex;
    // Single integer cursor: the max server_seq consumed so far. Persisted as
    // a string in sync_cursors(cortex,'hub','pull'); 0 means "from the start".
    const cursorStr = getSyncCursor(cortex, this.name, 'pull');
    let cursor = cursorStr ? parseInt(cursorStr, 10) : 0;
    if (!Number.isFinite(cursor) || cursor < 0) cursor = 0; // corrupt cursor → fresh

    // Loop while hasMore so one run drains the whole backlog. The cursor is
    // persisted after EACH page so a crash mid-drain still resumes from the
    // last fully-ingested page rather than re-pulling from zero (AC2).
    for (;;) {
      let res: Response;
      try {
        const params = new URLSearchParams({
          cortex: remoteCortex,
          cursor: String(cursor),
          limit: String(PULL_PAGE_LIMIT),
        });
        res = await this.fetchImpl(this.url(hub, `/v1/cortex-sync/pull?${params.toString()}`), {
          method: 'GET',
          headers: { Authorization: bearerHeader(hub.token) },
        });
      } catch (err) {
        result.errors.push(`hub pull failed: ${errMessage(err)}`);
        return result; // transport failure — cursor already persisted up to last page
      }

      if (!res.ok) {
        result.errors.push(await this.httpError('pull', res));
        return result; // auth/4xx/5xx — loud, not silent; cursor not advanced
      }

      const parsed = pullResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        result.errors.push('hub pull: malformed response from server');
        return result;
      }
      const { lines, nextCursor, hasMore } = parsed.data;

      for (const line of lines) {
        // Memories are immutable via sync — the wire shape carries no
        // tombstone, but guard defensively in case a future field appears.
        const { content: sanitizedContent, warnings } = validateEngramContent(line.content);
        if (warnings.length > 0) {
          result.errors.push(`Pulled memory from ${line.author} flagged: ${warnings.join(', ')}`);
        }
        // The server returns the content-derived id; ingest keyed on it via
        // INSERT-OR-IGNORE. We pass it straight through (the line shape's id
        // equals deterministicId(ts,author,content), which insertMemoryIfNotExists
        // uses as the dedup key).
        const { inserted } = insertMemoryIfNotExists(cortex, {
          id: line.id,
          ts: line.ts,
          author: line.author,
          content: sanitizedContent,
          source_ids: line.source_ids,
          episode_key: line.episode_key,
          decisions: line.decisions,
          // Preserve cross-device attribution from the wire; honest-unknown
          // (null) when the originating peer didn't stamp it.
          origin_peer_id: line.origin_peer_id ?? null,
        });
        if (inserted) result.pulled++;
      }

      // Advance + persist the cursor after the page is fully ingested. Because
      // server_seq is strictly monotonic and the query is server_seq > cursor,
      // the next page can never re-deliver an already-seen line.
      cursor = nextCursor;
      setSyncCursor(cortex, this.name, 'pull', String(cursor));

      if (!hasMore) break;
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Sync
  // ---------------------------------------------------------------------------

  async sync(cortex: string): Promise<SyncResult> {
    // Pull first to surface remote writes before pushing (matches the fs/git
    // adapter ordering). Results merge the same way.
    const pullResult = await this.pull(cortex);
    const pushResult = await this.push(cortex);
    return {
      pushed: pushResult.pushed,
      pulled: pullResult.pulled,
      errors: [...pullResult.errors, ...pushResult.errors],
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private getHub(): HubBackendConfig | null {
    const hub = getConfig().cortex?.hub;
    if (!hub?.url || !hub?.token) return null;
    return hub;
  }

  // Join the configured base URL with a route path, tolerating a trailing
  // slash on the base. The path already starts with `/v1/...`.
  private url(hub: HubBackendConfig, routePath: string): string {
    const base = hub.url.replace(/\/+$/, '');
    return `${base}${routePath}`;
  }

  // Build a readable error line from a non-OK HTTP response WITHOUT ever
  // including the bearer token. We surface the status (so auth rejections
  // read as "401", clearly distinct from "unreachable") and a short snippet
  // of the body if present.
  private async httpError(op: 'push' | 'pull', res: Response): Promise<string> {
    let detail = '';
    try {
      const text = await res.text();
      if (text) detail = `: ${text.slice(0, 200)}`;
    } catch {
      /* body unreadable — status alone is enough signal */
    }
    return `hub ${op} rejected (HTTP ${res.status})${detail}`;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
