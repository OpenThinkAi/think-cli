import {
  getMemoriesBySyncVersion,
  insertMemoryIfNotExists,
  getSyncCursor,
  setSyncCursor,
} from '../db/memory-queries.js';
import { getConfig } from '../lib/config.js';
import type { SyncAdapter, SyncResult } from './types.js';

const PUSH_BATCH = 500;
const PULL_BATCH = 500;

interface RemoteMemory {
  id: string;
  ts: string;
  author: string;
  content: string;
  source_ids: string[];
  episode_key: string | null;
  decisions: string[] | null;
}

function authHint(status: number): string {
  if (status === 401 || status === 403) {
    return ' Run `think cortex setup --server <url> --token <token>` to update credentials.';
  }
  return '';
}

/**
 * SyncAdapter that talks to an open-think-server (BLOOM-123) over HTTP.
 *
 * Wire format invariants:
 * - The CLI sends each memory's local `id` verbatim. Callers are expected to
 *   produce content-addressed ids (`deterministicId(ts, author, content)`) so
 *   two peers writing the same content collapse to one server row.
 * - Memories are immutable across the wire (no `deleted_at` field). Engrams
 *   are never sent. See SyncAdapter doc for the full contract.
 * - The push cursor is the local `sync_version`; the pull cursor is the
 *   server's `server_seq`. Stored independently per direction in
 *   `sync_cursors`.
 */
export class HttpSyncAdapter implements SyncAdapter {
  readonly name = 'http';

  isAvailable(): boolean {
    const cfg = getConfig().cortex?.server;
    return !!(cfg?.url && cfg.token);
  }

  private getServerConfig(): { url: string; token: string } {
    const cfg = getConfig().cortex?.server;
    if (!cfg?.url || !cfg.token) {
      throw new Error('http sync backend not configured (run: think cortex setup --server <url> --token <token>)');
    }
    return { url: cfg.url.replace(/\/+$/, ''), token: cfg.token };
  }

  private async authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const { url, token } = this.getServerConfig();
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    if (init.body !== undefined && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    return fetch(`${url}${path}`, { ...init, headers });
  }

  async push(cortex: string): Promise<SyncResult> {
    const result: SyncResult = { pushed: 0, pulled: 0, errors: [] };

    const cursorStr = getSyncCursor(cortex, this.name, 'push');
    let lastVersion = cursorStr ? parseInt(cursorStr, 10) : 0;

    // Loop in case there are more than PUSH_BATCH rows pending. Each round
    // takes a fixed-size window of newly-versioned rows, ships the live
    // ones, and advances the cursor past the whole window — including any
    // tombstones we silently dropped (memories are immutable via sync).
    for (;;) {
      const slice = getMemoriesBySyncVersion(cortex, lastVersion).slice(0, PUSH_BATCH);
      if (slice.length === 0) break;

      const live = slice.filter(m => !m.deleted_at);
      const cursorTo = slice[slice.length - 1].sync_version;

      if (live.length > 0) {
        const body = {
          memories: live.map(m => ({
            id: m.id,
            ts: m.ts,
            author: m.author,
            content: m.content,
            source_ids: JSON.parse(m.source_ids),
            episode_key: m.episode_key ?? undefined,
            decisions: m.decisions ? JSON.parse(m.decisions) : undefined,
          })),
        };

        const res = await this.authedFetch(`/v1/cortexes/${encodeURIComponent(cortex)}/memories`, {
          method: 'POST',
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          result.errors.push(`push failed (${res.status}): ${text || res.statusText}.${authHint(res.status)}`);
          return result;
        }

        const json = await res.json() as { accepted: number; inserted: number };
        result.pushed += json.accepted;
      }

      setSyncCursor(cortex, this.name, 'push', String(cursorTo));
      lastVersion = cursorTo;

      // Drained the queue when the slice was a partial batch.
      if (slice.length < PUSH_BATCH) break;
    }

    return result;
  }

  async pull(cortex: string): Promise<SyncResult> {
    const result: SyncResult = { pushed: 0, pulled: 0, errors: [] };
    let since = getSyncCursor(cortex, this.name, 'pull') ?? '0';

    for (;;) {
      const path = `/v1/cortexes/${encodeURIComponent(cortex)}/memories?since=${encodeURIComponent(since)}&limit=${PULL_BATCH}`;
      const res = await this.authedFetch(path);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        result.errors.push(`pull failed (${res.status}): ${text || res.statusText}.${authHint(res.status)}`);
        return result;
      }

      const json = await res.json() as { memories: RemoteMemory[]; next_since: string };
      for (const m of json.memories) {
        const inserted = insertMemoryIfNotExists(cortex, {
          id: m.id,
          ts: m.ts,
          author: m.author,
          content: m.content,
          source_ids: m.source_ids ?? [],
          episode_key: m.episode_key ?? undefined,
          decisions: m.decisions ?? undefined,
        });
        if (inserted) result.pulled++;
      }

      // Advance cursor even when nothing was inserted — the server told us
      // it's already caught up to next_since.
      since = json.next_since;
      setSyncCursor(cortex, this.name, 'pull', since);

      if (json.memories.length < PULL_BATCH) break;
    }

    return result;
  }

  async sync(cortex: string): Promise<SyncResult> {
    // Run push even if pull errored — they're independent units of work and
    // a stalled pull (e.g. server briefly returning a transient error on
    // some range) shouldn't block local writes from going out.
    const pullResult = await this.pull(cortex);
    const pushResult = await this.push(cortex);
    return {
      pushed: pushResult.pushed,
      pulled: pullResult.pulled,
      errors: [...pullResult.errors, ...pushResult.errors],
    };
  }

  async listRemoteCortexes(): Promise<string[]> {
    const res = await this.authedFetch('/v1/cortexes');
    if (!res.ok) {
      throw new Error(`list cortexes failed: ${res.status} ${res.statusText}`);
    }
    const json = await res.json() as { cortexes: string[] };
    return json.cortexes;
  }

  async createCortex(cortex: string): Promise<void> {
    const res = await this.authedFetch('/v1/cortexes', {
      method: 'POST',
      body: JSON.stringify({ name: cortex }),
    });
    // 201 (created) and 200 (already existed) are both fine; treat anything
    // else as failure.
    if (res.status !== 200 && res.status !== 201) {
      const text = await res.text().catch(() => '');
      throw new Error(`create cortex failed: ${res.status} ${text || res.statusText}`);
    }
  }
}
