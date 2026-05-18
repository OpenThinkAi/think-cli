/**
 * Daemon `sync` method handler — AGT-286
 *
 * Accepts: { cortex, content, kind, topics? }
 * Steps:
 *   1. Validate params (content non-empty and within byte limit, kind in
 *      allowed set, cortex exists).
 *   2. Generate uuidv7 id.
 *   3. Build the unified L1 entry object.
 *   4. Append to the active L1 JSONL page (rotate at 1000 entries).
 *   5. Embed content via embed().
 *      NOTE: if embed() throws here, L1 has the entry but L2 does not.
 *      AGT-299 compaction replay is responsible for reconciling L1 → L2
 *      on the next daemon start.
 *   6. INSERT into L2 (memories table) with embedding + assignNextSeq.
 *      kind and topics are stored in L1 only for now — the `memories`
 *      table gains those columns in the L2 schema extension ticket that
 *      follows AGT-286. Until that migration lands, kind-filtered and
 *      topic-scoped L2 queries are not supported. A warning is included
 *      in the response when non-default kind or non-empty topics are used.
 *   7. Return { entry_id, status, warnings }.
 *
 * NOT in this ticket:
 *   - Compaction queue (AGT-299)
 *   - Push-to-remote debounce (AGT-309)
 *   - Retro supersession check (AGT-305)
 *   - L2 kind/topics columns (follow-on L2 schema extension)
 */

import fs from 'node:fs';
import path from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { getConfig, getPeerId } from '../lib/config.js';
import { getIndexDbPath, getRepoPath, sanitizeName } from '../lib/paths.js';
import { getCortexDb } from '../db/engrams.js';
import { assignNextSeq } from '../db/activity-seq.js';
import embed, { EMBEDDING_MODEL_NAME } from '../lib/embed.js';
import { compactionQueue } from './compaction/queue.js';
import { pushDebouncer } from './push-debouncer.js';
import { runSupersessionWorker } from './supersession/worker.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALLOWED_KINDS = ['memory', 'retro', 'event'] as const;
type EntryKind = (typeof ALLOWED_KINDS)[number];

/** Rotate to a new page after this many lines. */
const L1_PAGE_SIZE = 1000;

/**
 * Maximum accepted byte length for `content`. Prevents DoS via oversized
 * payloads that would spin the embedding model CPU indefinitely. The embed
 * module already truncates at 32 KB chars; this gate fires before even
 * reaching the embed call.
 */
const MAX_CONTENT_BYTES = 64 * 1024; // 64 KB

/** Maximum number of topics accepted per entry. */
const MAX_TOPICS = 20;
/** Maximum characters per topic string. */
const MAX_TOPIC_LENGTH = 128;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SyncParams {
  cortex: string;
  content: string;
  kind: EntryKind;
  topics?: string[];
  /**
   * When true, the push-debouncer schedules the local git commit but skips
   * the remote push for this write cycle. Intended for AGT-293 offline mode
   * and integration tests that run without a remote.
   */
  skipPush?: boolean;
}

/**
 * Response shape for the `sync` RPC.
 *
 * - `status: 'stored'` — entry written to L1 and L2 successfully. NOTE: when
 *   `supersession_scheduled` is also true, this status reflects the initial
 *   write only; the entry may be tombstoned shortly after by the async
 *   duplicate check.
 * - `status: 'queued'` — reserved for AGT-299 (L1 written, L2 pending
 *   compaction replay); not yet returned by this implementation.
 * - `supersession_scheduled` — present and `true` for every `kind=retro` entry.
 *   An async check was scheduled regardless of whether there are candidates.
 *   The entry MAY be tombstoned as a duplicate. There is no completion signal;
 *   tombstone events appear only in the daemon log. Callers should surface this
 *   to the user as an advisory, not as a definitive tombstone warning.
 * - `warnings` — advisory messages (e.g. fields accepted but not yet
 *   queryable via L2). Callers should surface these to the user.
 */
export interface SyncResult {
  entry_id: string;
  status: 'stored' | 'queued';
  /**
   * True for every `kind=retro` entry. An async supersession check was scheduled
   * and will run shortly after this response is returned. The check may tombstone
   * the entry as a duplicate — there is no completion callback or follow-up signal.
   * Tombstone events are recorded only in the daemon log at warn level
   * (`[supersession] retro <id> detected as duplicate; tombstoned`).
   * Verification path for users: tombstoned entries are L2-soft-deleted via
   * `deleted_at` and an L1 tombstone line is appended — they will not appear
   * in default recall results but remain inspectable via daemon log scraping
   * or a future `--include-deleted` recall flag.
   * Suggested caller copy: "duplicate check running; retro may be suppressed
   * if it duplicates an existing one. Check daemon log for tombstone events."
   */
  supersession_scheduled?: boolean;
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates the raw RPC params and returns a typed `SyncParams`.
 * Throws `Error` with a user-readable message that names the offending field.
 */
function validateSyncParams(raw: Record<string, unknown>): SyncParams {
  const { cortex, content, kind, topics, skipPush } = raw;

  if (typeof cortex !== 'string' || cortex.length === 0) {
    throw new Error("invalid field 'cortex': must be a non-empty string");
  }

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

  let parsedTopics: string[] | undefined;
  if (topics !== undefined) {
    if (!Array.isArray(topics) || !topics.every(t => typeof t === 'string')) {
      throw new Error("invalid field 'topics': must be an array of strings when provided");
    }
    if ((topics as string[]).length > MAX_TOPICS) {
      throw new Error(
        `invalid field 'topics': at most ${MAX_TOPICS} topics allowed per entry`,
      );
    }
    for (const t of topics as string[]) {
      if (t.length > MAX_TOPIC_LENGTH) {
        throw new Error(
          `invalid field 'topics': each topic must be at most ${MAX_TOPIC_LENGTH} characters`,
        );
      }
    }
    parsedTopics = topics as string[];
  }

  return {
    cortex,
    content,
    kind: kind as EntryKind,
    topics: parsedTopics,
    skipPush: skipPush === true,
  };
}

// ---------------------------------------------------------------------------
// Cortex existence check
// ---------------------------------------------------------------------------

/**
 * A cortex "exists" when its L2 database file is present on disk.
 * (The DB is created by `think cortex create` / `getCortexDb` on first access.)
 *
 * Calls `sanitizeName` to guard against path-traversal: names with `..`,
 * path separators, or non-`[a-zA-Z0-9_-]` characters cause `sanitizeName`
 * to throw, which is caught here and returned as `false` (not found).
 * This invariant is the authoritative path-safety gate for this module.
 */
function cortexExists(cortexName: string): boolean {
  try {
    const dbPath = getIndexDbPath(sanitizeName(cortexName));
    return fs.existsSync(dbPath);
  } catch {
    // sanitizeName threw — invalid name; treat as not found
    return false;
  }
}

// ---------------------------------------------------------------------------
// L1 page helpers
// ---------------------------------------------------------------------------

/**
 * Returns the absolute path to the active L1 JSONL page for the given cortex
 * within the shared git repo working tree. Rotates to a new page when the
 * current page has reached {@link L1_PAGE_SIZE} lines.
 *
 * File naming mirrors git-adapter: `000001.jsonl`, `000002.jsonl`, …
 *
 * The repo working tree must already exist (created by `think cortex create`
 * or a prior sync). Does NOT commit or push — that is AGT-309's job.
 *
 * NOTE: this read-then-write is not atomic under concurrent `sync` calls.
 * A per-cortex write queue (mutex) should wrap L1 writes in a future
 * ticket before the daemon handles real concurrency.
 *
 * Line counting reads the entire page file. At 1000-entry × ~1 KB average
 * entries this is ~1 MB synchronous I/O per sync call near rotation. A
 * future improvement is an in-memory per-cortex line counter reset on
 * page rotation — acceptable latency at current traffic levels.
 */
function getActivePage(cortexDir: string): string {
  // List existing numbered page files, sorted ascending.
  let files: string[] = [];
  try {
    files = fs.readdirSync(cortexDir)
      .filter(f => /^\d{6}\.jsonl$/.test(f))
      .sort();
  } catch {
    // Directory doesn't exist yet — will be created below.
    files = [];
  }

  if (files.length === 0) {
    return path.join(cortexDir, '000001.jsonl');
  }

  const latestFile = files[files.length - 1];
  const latestPath = path.join(cortexDir, latestFile);

  // Count non-empty lines to decide whether to rotate.
  // Valid JSONL lines never have leading whitespace, so `line.length > 0`
  // is sufficient and avoids per-line string allocation from `.trim()`.
  let lineCount = 0;
  try {
    const raw = fs.readFileSync(latestPath, 'utf-8');
    for (const line of raw.split('\n')) {
      if (line.length > 0) lineCount++;
    }
  } catch {
    lineCount = 0;
  }

  if (lineCount >= L1_PAGE_SIZE) {
    const nextNum = parseInt(latestFile, 10) + 1;
    return path.join(cortexDir, String(nextNum).padStart(6, '0') + '.jsonl');
  }

  return latestPath;
}

/**
 * Append a single JSONL line to the active page for the cortex.
 * Creates the cortex directory and page file if they do not yet exist.
 */
function appendToL1(cortexDir: string, line: string): void {
  fs.mkdirSync(cortexDir, { recursive: true, mode: 0o700 });
  const pagePath = getActivePage(cortexDir);
  fs.appendFileSync(pagePath, line + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Handle one `sync` request from the daemon protocol.
 *
 * Exported as a standalone async function so it can be unit-tested without
 * spinning up a full socket server. The daemon's dispatchRequest wires it
 * in via the `daemonMethods` map in `daemon/index.ts`.
 */
export async function handleSync(params: Record<string, unknown>): Promise<SyncResult> {
  // --- validation ---
  // validateSyncParams throws Error with a user-readable message on failure.
  const { cortex, content, kind, topics, skipPush } = validateSyncParams(params);

  if (!cortexExists(cortex)) {
    throw new Error(`cortex '${cortex}' not found; run: think cortex create ${cortex}`);
  }

  // Re-sanitize for use in filesystem/DB operations. cortexExists() guarantees
  // the name is valid (it would have returned false otherwise), so this call
  // cannot throw — it exists to keep the safe name visible at each use site.
  const safeCortex = sanitizeName(cortex);

  // --- build L1 entry ---
  const id = uuidv7();
  const ts = new Date().toISOString();
  const config = getConfig();
  const author = config.cortex?.author ?? 'unknown';
  const origin_peer_id = getPeerId();

  const entry = {
    id,
    ts,
    author,
    origin_peer_id,
    kind,
    content,
    topics: topics ?? [],
    // Schema placeholders required by the v3 entry model (README § "The entry model").
    // `supersedes` and `compacted_from` are set by AGT-299 compaction; `decisions`
    // and `source_ids` are v2 compat fields; `deleted_at` is the tombstone sentinel.
    // AGT-299's compaction reader will look for these keys — do not strip them.
    supersedes: [],
    compacted_from: null,
    decisions: [],
    source_ids: [],
    deleted_at: null,
  };

  const line = JSON.stringify(entry);

  // --- write to L1 ---
  // Cortex directory inside the shared repo working tree.
  // The repo root is `~/.think/repo/`; cortex data lives on a git branch
  // named after the cortex. For direct filesystem writes (pre-AGT-309),
  // we write to `<repoPath>/<cortex>/` so the push debounce can later
  // commit and push the working-tree changes.
  //
  // `sanitizeName` guarantees the cortex name contains only [a-zA-Z0-9_-],
  // which is always a single safe path component with no traversal risk.
  const cortexDir = path.join(getRepoPath(), safeCortex);
  appendToL1(cortexDir, line);

  // --- embed ---
  // NOTE: if embed() throws here, L1 has the entry but L2 does not.
  // AGT-299 compaction replay is responsible for reconciling L1 → L2.
  const embeddingVec = await embed(content);
  // Use byteOffset + byteLength so we only store the Float32Array's view
  // of the backing buffer — safe even when the HuggingFace pipeline returns
  // a subarray view over a larger pooled ArrayBuffer.
  const embeddingBytes = Buffer.from(
    embeddingVec.buffer,
    embeddingVec.byteOffset,
    embeddingVec.byteLength,
  );

  // --- insert into L2 ---
  // `kind` and `topics` are stored in L1 above; the `memories` table does
  // not yet have those columns. They will be added in the L2 schema
  // extension that follows AGT-286, after which this INSERT can include them.
  const activitySeq = assignNextSeq(safeCortex);
  const db = getCortexDb(safeCortex);

  db.prepare(`
    INSERT OR IGNORE INTO memories
      (id, ts, author, content, source_ids, created_at, deleted_at,
       sync_version, origin_peer_id, embedding, embedding_model, activity_seq)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
  `).run(
    id,
    ts,
    author,
    content,
    JSON.stringify([]),
    ts,
    null,
    origin_peer_id,
    embeddingBytes,
    EMBEDDING_MODEL_NAME,
    activitySeq,
  );

  // Fire-and-forget: enqueue compaction job after L1+L2 write completes.
  // Only `kind=memory` entries are compacted (retro/event are not — per v3 design).
  if (kind === 'memory') {
    compactionQueue.enqueue(id, safeCortex);
  }

  // --- async supersession worker for retros (AGT-304) ---
  // Fire-and-forget: vector search + LLM call happens after the sync response
  // is returned to the caller. Errors are logged but do not fail the sync.
  if (kind === 'retro') {
    setImmediate(() => {
      runSupersessionWorker(id, ts, content, safeCortex).catch((err: unknown) => {
        console.warn(
          `[supersession] worker error for entry ${id}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
  }

  // Schedule a debounced git commit + push for this cortex (AGT-309).
  // `skipPush` suppresses the remote push when the caller is offline or
  // running integration tests that have no configured remote (AGT-293).
  pushDebouncer.notify(safeCortex, skipPush);

  // Build advisory warnings for fields accepted but not yet L2-queryable.
  const warnings: string[] = [];
  if (kind !== 'memory') {
    warnings.push(
      `kind '${kind}' stored to L1 only; L2 schema extension pending — kind-filtered queries not yet supported`,
    );
  }
  if (topics && topics.length > 0) {
    warnings.push(
      'topics stored to L1 only; L2 schema extension pending — topic-scoped queries not yet supported',
    );
  }

  return {
    entry_id: id,
    status: 'stored',
    ...(kind === 'retro' ? { supersession_scheduled: true } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
