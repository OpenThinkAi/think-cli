import crypto from 'node:crypto';
import { v5 as uuidv5 } from 'uuid';

// Stable namespace for deterministic ID generation across all sync adapters.
// Changing this value will cause duplicate memories on the next sync.
const THINK_UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

export function deterministicId(ts: string, author: string, content: string): string {
  const hash = crypto.createHash('sha256').update(`${ts}|${author}|${content}`).digest('hex');
  return uuidv5(hash, THINK_UUID_NAMESPACE);
}

// Separate namespace-prefixed hash for long-term events so they can't
// collide with memory IDs even if ts/author/content happen to match.
export function deterministicEventId(ts: string, author: string, title: string, content: string): string {
  const hash = crypto.createHash('sha256').update(`lte|${ts}|${author}|${title}|${content}`).digest('hex');
  return uuidv5(hash, THINK_UUID_NAMESPACE);
}
