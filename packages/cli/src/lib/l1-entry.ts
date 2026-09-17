/**
 * The v3 L1 entry model — the one wire format every L1 writer produces.
 *
 * Extracted from `daemon/sync-handler.ts` (AGT-1298) so the daemon-unreachable
 * CLI fallback (`lib/l1-fallback.ts`) emits byte-identical lines instead of a
 * parallel format. The daemon remains the only *normal* writer; the fallback
 * exists so a write is never lost — or silently parked in a table nothing
 * reads — while the daemon is down.
 *
 * Nothing here touches the filesystem, git, SQLite or the embedding model, so
 * it is safe to import from the CLI hot path.
 */

/** Entry kinds the v3 write path accepts. */
export const ALLOWED_KINDS = ['memory', 'retro', 'event'] as const;
export type EntryKind = (typeof ALLOWED_KINDS)[number];

/**
 * Maximum accepted byte length for `content`. Prevents DoS via oversized
 * payloads that would spin the embedding model CPU indefinitely. The embed
 * module already truncates at 32 KB chars; this gate fires before even
 * reaching the embed call.
 */
export const MAX_CONTENT_BYTES = 64 * 1024; // 64 KB

/** Maximum number of topics accepted per entry. */
export const MAX_TOPICS = 20;
/** Maximum characters per topic string. */
export const MAX_TOPIC_LENGTH = 128;

/**
 * One L1 JSONL line, deserialized.
 *
 * `supersedes` and `compacted_from` are set by AGT-299 compaction; `decisions`
 * and `source_ids` are v2 compat fields; `deleted_at` is the tombstone
 * sentinel. AGT-299's compaction reader looks for these keys — do not strip
 * them.
 */
export interface L1Entry {
  id: string;
  ts: string;
  author: string;
  origin_peer_id: string;
  kind: EntryKind;
  content: string;
  topics: string[];
  supersedes: string[];
  compacted_from: string[] | null;
  decisions: string[];
  source_ids: string[];
  deleted_at: string | null;
}

/**
 * Build the L1 entry object for a fresh (non-compacted, non-tombstone) write.
 * Every caller — the daemon's sync handler and the daemon-down CLI fallback —
 * goes through here so the schema placeholders can never drift apart.
 */
export function buildL1Entry(fields: {
  id: string;
  ts: string;
  author: string;
  origin_peer_id: string;
  kind: EntryKind;
  content: string;
  topics?: string[];
}): L1Entry {
  return {
    id: fields.id,
    ts: fields.ts,
    author: fields.author,
    origin_peer_id: fields.origin_peer_id,
    kind: fields.kind,
    content: fields.content,
    topics: fields.topics ?? [],
    supersedes: [],
    compacted_from: null,
    decisions: [],
    source_ids: [],
    deleted_at: null,
  };
}

/**
 * Validate the fields an L1 entry write accepts, throwing an `Error` whose
 * message names the offending field. Mirrors — and is called by — the daemon's
 * `validateSyncParams`, so an offline write can never enqueue an entry the
 * daemon would have rejected.
 */
export function validateEntryFields(
  content: unknown,
  kind: unknown,
  topics?: unknown,
): void {
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error("invalid field 'content': must be a non-empty string");
  }

  if (Buffer.byteLength(content, 'utf-8') > MAX_CONTENT_BYTES) {
    throw new Error(
      `invalid field 'content': must be at most 64 KB (${MAX_CONTENT_BYTES} bytes)`,
    );
  }

  if (typeof kind !== 'string' || !(ALLOWED_KINDS as readonly string[]).includes(kind)) {
    throw new Error(
      `invalid field 'kind': invalid kind '${String(kind)}'; expected memory|retro|event`,
    );
  }

  if (topics !== undefined) {
    if (!Array.isArray(topics) || !topics.every((t: unknown) => typeof t === 'string')) {
      throw new Error("invalid field 'topics': must be an array of strings when provided");
    }
    if (topics.length > MAX_TOPICS) {
      throw new Error(
        `invalid field 'topics': at most ${MAX_TOPICS} topics allowed per entry`,
      );
    }
    for (const t of topics) {
      if (t.length > MAX_TOPIC_LENGTH) {
        throw new Error(
          `invalid field 'topics': each topic must be at most ${MAX_TOPIC_LENGTH} characters`,
        );
      }
    }
  }
}
