import type { RetroKind, RetroRow } from '../db/retro-queries.js';
import { VALID_KINDS } from '../db/retro-queries.js';

/**
 * Wire shape of a single retro line in `<peer>-retros.jsonl`. AGT-192 will
 * call these helpers from the local-fs and git sync adapters; AGT-191 only
 * locks the format and the origin_peer_id round-trip semantics.
 *
 * Local-only relegation signal (promoted, last_recalled_at, recalled_count,
 * sync_version) is intentionally not on the wire — propagating it across
 * peers would conflate machine-local recall stats with cross-peer truth.
 */
export interface RetroEntry {
  id: string;
  content: string;
  kind: RetroKind | null;
  created_at: string;
  occurrences: number;
  tombstoned_at?: string;
  tombstone_reason?: string;
  origin_peer_id?: string;
}

const VALID_KIND_SET = new Set<string>(VALID_KINDS);

export function serializeRetroForSync(row: RetroRow): string {
  return JSON.stringify({
    id: row.id,
    content: row.content,
    kind: row.kind,
    created_at: row.created_at,
    occurrences: row.occurrences,
    ...(row.tombstoned_at ? { tombstoned_at: row.tombstoned_at } : {}),
    ...(row.tombstone_reason ? { tombstone_reason: row.tombstone_reason } : {}),
    ...(row.origin_peer_id ? { origin_peer_id: row.origin_peer_id } : {}),
  });
}

export function parseRetrosJsonl(content: string): RetroEntry[] {
  if (!content.trim()) return [];
  const entries: RetroEntry[] = [];
  for (const line of content.trim().split('\n')) {
    if (!line.trim()) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const id = typeof parsed.id === 'string' ? parsed.id : null;
    const text = typeof parsed.content === 'string' ? parsed.content : null;
    const createdAt = typeof parsed.created_at === 'string' ? parsed.created_at : null;
    if (!id || !text || !createdAt) continue;

    const rawKind = typeof parsed.kind === 'string' ? parsed.kind : null;
    const kind: RetroKind | null = rawKind && VALID_KIND_SET.has(rawKind) ? (rawKind as RetroKind) : null;

    const occurrences = typeof parsed.occurrences === 'number' && Number.isFinite(parsed.occurrences)
      ? parsed.occurrences
      : 1;

    const entry: RetroEntry = {
      id,
      content: text,
      kind,
      created_at: createdAt,
      occurrences,
    };

    if (typeof parsed.tombstoned_at === 'string' && parsed.tombstoned_at.length > 0) {
      entry.tombstoned_at = parsed.tombstoned_at;
    }
    if (typeof parsed.tombstone_reason === 'string' && parsed.tombstone_reason.length > 0) {
      entry.tombstone_reason = parsed.tombstone_reason;
    }
    if (typeof parsed.origin_peer_id === 'string' && parsed.origin_peer_id.length > 0) {
      entry.origin_peer_id = parsed.origin_peer_id;
    }

    entries.push(entry);
  }
  return entries;
}
