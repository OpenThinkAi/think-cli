import os from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import type { Database } from './db.js';

/**
 * Proxy peer-id storage + resolution (AGT-385, think-proxy-events PE-05).
 *
 * The proxy stamps every memory it curates into the team cortex with a
 * single stable `origin_peer_id`. This is intentionally distinct from
 * `lib/config.ts:getPeerId()` (per-machine CLI identity in `~/.config/think/
 * config.json`) — the proxy is its own actor in the cortex, not a fan-out
 * of any one user's machine.
 *
 * Naming convention for auto-generated ids:
 *
 *   proxy-<hostname-short>-<short-uuid>
 *
 * The hostname segment is `os.hostname()` lowercased, trimmed at the first
 * `.` (so `proxy-anglepoint-foo.local` → `proxy-anglepoint-foo`), with any
 * char outside `[a-z0-9-]` collapsed to `-`. Length-capped at 32 chars so
 * the full id stays under ~50 chars even on long hostnames. If the host
 * has no usable name, the segment is omitted and the id becomes
 * `proxy-<uuid>` — the uuid alone is still a stable identifier.
 *
 * Why include the hostname: a unique `proxy-<uuid>` would do, but in
 * practice operators run one proxy per team and want a glanceable id in
 * `think serve status` output and in `origin_peer_id` fields downstream
 * (recall hits, audit logs). The hostname segment makes that legible
 * without sacrificing uniqueness — the uuid suffix collides with
 * probability zero in any realistic deployment.
 *
 * Operators who want a fixed name (e.g. `proxy-anglepoint`) pass
 * `--peer-id proxy-anglepoint` to `think serve`; the override is persisted
 * so subsequent restarts without the flag still come back with the same
 * id.
 */

const PROXY_PEER_ID_KEY = 'peer_id';
const HOSTNAME_SEGMENT_MAX_LEN = 32;

function sanitizeHostnameSegment(raw: string): string {
  const lowered = raw.toLowerCase();
  const trimmedAtDot = lowered.split('.', 1)[0] ?? '';
  // Replace runs of non-`[a-z0-9-]` chars with a single `-`, then trim
  // leading/trailing hyphens so the segment never starts or ends with one.
  const collapsed = trimmedAtDot.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (collapsed.length === 0) return '';
  return collapsed.slice(0, HOSTNAME_SEGMENT_MAX_LEN);
}

/**
 * Builds a fresh proxy peer-id. Exposed for tests; production callers go
 * through `getProxyPeerId` which writes the result back to sqlite.
 */
export function generateProxyPeerId(opts: { hostname?: string } = {}): string {
  const rawHost = opts.hostname ?? os.hostname();
  const hostSeg = sanitizeHostnameSegment(rawHost);
  // Short uuid suffix: first 8 hex chars of a uuidv4. Full uuid is
  // overkill in the id string — collision space of 16^8 (~4 billion) is
  // more than enough for "one proxy per team, maybe two in dev". The
  // persisted value is the only source of truth either way.
  const shortUuid = uuidv4().replace(/-/g, '').slice(0, 8);
  if (hostSeg.length === 0) {
    return `proxy-${shortUuid}`;
  }
  return `proxy-${hostSeg}-${shortUuid}`;
}

/**
 * Reads the persisted proxy peer-id. Returns `null` when none has been
 * persisted yet — callers (boot) use that to decide between auto-generate
 * and reuse.
 */
export function readProxyPeerId(db: Database): string | null {
  const row = db
    .prepare('SELECT value FROM proxy_kv WHERE key = ?')
    .get(PROXY_PEER_ID_KEY) as { value: string } | undefined;
  if (!row) return null;
  return row.value;
}

/**
 * Upserts the persisted proxy peer-id. Caller is responsible for choosing
 * the value (generated id, operator override via `--peer-id`).
 */
export function writeProxyPeerId(db: Database, value: string): void {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error('proxy peer-id must be a non-empty string');
  }
  const nowIso = new Date().toISOString();
  db.prepare(
    `INSERT INTO proxy_kv (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(PROXY_PEER_ID_KEY, trimmed, nowIso);
}

export interface ResolveProxyPeerIdOptions {
  /**
   * Operator override (e.g. from `think serve --peer-id <value>`). When
   * provided and non-empty, replaces any persisted value and is persisted
   * itself so subsequent restarts without the flag pick up the same id.
   */
  override?: string;
  /** Test hook: lets test code force a hostname instead of calling `os.hostname()`. */
  hostname?: string;
}

/**
 * Resolves the proxy peer-id, persisting on first-boot or on override.
 *
 * Order of precedence:
 *   1. `opts.override` (CLI flag) — writes through to sqlite so future
 *      restarts without the flag reuse it.
 *   2. Existing `proxy_kv.peer_id` row — returned as-is.
 *   3. Fresh `generateProxyPeerId()` — written and returned.
 *
 * Always returns a non-empty string. Idempotent on second boot.
 *
 * Downstream modules (cortex-writer for AGT-384, the curator for PE-04)
 * should call this exactly once at boot and pass the resolved id down,
 * rather than calling per-write. Per-write SQL would still be correct
 * (sqlite handles the read fast) but is unnecessary work.
 */
export function getProxyPeerId(db: Database, opts: ResolveProxyPeerIdOptions = {}): string {
  const override = opts.override?.trim();
  if (override && override.length > 0) {
    writeProxyPeerId(db, override);
    return override;
  }
  const existing = readProxyPeerId(db);
  if (existing !== null && existing.length > 0) {
    return existing;
  }
  const generated = generateProxyPeerId({ hostname: opts.hostname });
  writeProxyPeerId(db, generated);
  return generated;
}
