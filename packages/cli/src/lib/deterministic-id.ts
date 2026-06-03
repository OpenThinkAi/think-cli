import crypto from 'node:crypto';
import { v5 as uuidv5 } from 'uuid';

// Stable namespace for deterministic ID generation across all sync adapters.
// Changing this value will cause duplicate memories on the next sync.
const THINK_UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

export function deterministicId(ts: string, author: string, content: string): string {
  const hash = crypto.createHash('sha256').update(`${ts}|${author}|${content}`).digest('hex');
  return uuidv5(hash, THINK_UUID_NAMESPACE);
}

/**
 * The L2 primary key for a memory entry: its explicit `id` when present — the
 * key the daemon pull-loop ingests under and that `supersedes`/`compacted_from`
 * point to — falling back to a content-derived {@link deterministicId} only for
 * legacy pre-v7 lines that have no `id`. All paths that index memories into L2
 * (reindex, git-adapter) must route through this so a reindex is idempotent
 * against daemon-ingested rows instead of duplicating them under a second key.
 */
export function resolveMemoryId(entry: {
  id?: string;
  ts: string;
  author: string;
  content: string;
}): string {
  return typeof entry.id === 'string' && entry.id
    ? entry.id
    : deterministicId(entry.ts, entry.author, entry.content);
}

// Separate namespace-prefixed hash for long-term events so they can't
// collide with memory IDs even if ts/author/content happen to match.
export function deterministicEventId(ts: string, author: string, title: string, content: string): string {
  const hash = crypto.createHash('sha256').update(`lte|${ts}|${author}|${title}|${content}`).digest('hex');
  return uuidv5(hash, THINK_UUID_NAMESPACE);
}
