/**
 * Pull loop — AGT-310
 *
 * Per-cortex polling loop that fetches new commits from the remote and
 * ingests any new L1 JSONL entries into L2.
 *
 * Two poll modes:
 *   ACTIVE  — recent CLI activity within the last ACTIVE_THRESHOLD_MS ms
 *             → poll every ACTIVE_INTERVAL_MIN_MS–ACTIVE_INTERVAL_MAX_MS
 *   IDLE    — no recent CLI activity
 *             → poll every IDLE_INTERVAL_MIN_MS–IDLE_INTERVAL_MAX_MS
 *
 * Callers:
 *   - `startPullLoop(cortex, writeLine)` — start the background loop for a
 *     single cortex. Wire into daemon startup. Returns a `stop()` handle.
 *   - `notifyCliCall(cortex)` — call on every daemon RPC to reset the
 *     active-mode timer for that cortex.
 *   - `triggerImmediatePull(cortex)` — called by AGT-311 WS subscriber to
 *     interrupt the backoff and trigger a fetch immediately. The polling
 *     timer is rescheduled from now so the next regular poll follows the
 *     normal interval.
 *
 * Security:
 *   - Cortex names are passed through sanitizeName before use in any git
 *     or filesystem operation.
 *   - Log lines that include the cortex name strip \r\n (AGT-277 pattern).
 *   - Git is invoked via execFile argument-array (no shell interpolation).
 *   - safeGitEnv() strips attacker-controlled env vars.
 *
 * Coexistence with AGT-311:
 *   - triggerImmediatePull() runs a fetch immediately and resets the poll
 *     timer so the WS event and the poll loop do not race or double-fetch.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getRepoPath, sanitizeName } from '../lib/paths.js';
import { safeGitEnv } from '../lib/git.js';
import { getCortexDb } from '../db/engrams.js';
import { getSyncCursor, setSyncCursor } from '../db/memory-queries.js';
import embed, { EMBEDDING_MODEL_NAME } from '../lib/embed.js';
import { assignNextSeq } from '../db/activity-seq.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Lower bound for active-mode poll interval (ms). */
export const ACTIVE_INTERVAL_MIN_MS = 5_000;
/** Upper bound for active-mode poll interval (ms). */
export const ACTIVE_INTERVAL_MAX_MS = 10_000;
/** Lower bound for idle-mode poll interval (ms). */
export const IDLE_INTERVAL_MIN_MS = 60_000;
/** Upper bound for idle-mode poll interval (ms). */
export const IDLE_INTERVAL_MAX_MS = 120_000;
/**
 * If a CLI call arrived within this many ms, the cortex is considered
 * "active" and uses the faster poll interval.
 */
export const ACTIVE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

/** sync_cursors backend name used by the pull loop. */
const CURSOR_BACKEND = 'git';
/** sync_cursors direction value used by the pull loop. */
const CURSOR_DIRECTION = 'pull';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PullLoopHandle {
  /** Stop the poll loop for this cortex. No-op after first call. */
  stop(): void;
}

// ---------------------------------------------------------------------------
// Module-level last-call timestamps (cortex → ms since epoch)
// Used by notifyCliCall() and isActive().
// ---------------------------------------------------------------------------

const lastCliCallMs = new Map<string, number>();

// ---------------------------------------------------------------------------
// Module-level set of active loop cortexes (for triggerImmediatePull)
// Map: cortex → callback that interrupts the current backoff timer.
// ---------------------------------------------------------------------------

const interruptCallbacks = new Map<string, () => void>();

// ---------------------------------------------------------------------------
// Public notification helpers
// ---------------------------------------------------------------------------

/**
 * Record that a CLI call arrived for `cortex`. Resets the active-mode timer.
 * The daemon should call this on every RPC dispatch.
 */
export function notifyCliCall(cortex: string): void {
  try {
    const safe = sanitizeName(cortex);
    lastCliCallMs.set(safe, Date.now());
  } catch {
    // Invalid cortex name — ignore silently; the RPC handler has already
    // validated or will validate separately.
  }
}

/**
 * Interrupt the current poll backoff for `cortex` and run a fetch now.
 * Called by AGT-311 WS subscriber when a server-push notification arrives.
 * No-op if no loop is running for `cortex`.
 */
export function triggerImmediatePull(cortex: string): void {
  try {
    const safe = sanitizeName(cortex);
    const cb = interruptCallbacks.get(safe);
    if (cb) cb();
  } catch {
    // Invalid cortex name — no-op.
  }
}

// ---------------------------------------------------------------------------
// Interval helpers
// ---------------------------------------------------------------------------

function isActive(safeCortex: string): boolean {
  const last = lastCliCallMs.get(safeCortex);
  if (last === undefined) return false;
  return Date.now() - last < ACTIVE_THRESHOLD_MS;
}

function jitteredInterval(minMs: number, maxMs: number): number {
  return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
}

function nextIntervalMs(safeCortex: string): number {
  return isActive(safeCortex)
    ? jitteredInterval(ACTIVE_INTERVAL_MIN_MS, ACTIVE_INTERVAL_MAX_MS)
    : jitteredInterval(IDLE_INTERVAL_MIN_MS, IDLE_INTERVAL_MAX_MS);
}

// ---------------------------------------------------------------------------
// Git helpers (async)
// ---------------------------------------------------------------------------

/** Exported for test injection via PullLoop._gitOverride. */
export type GitRunner = (args: string[], cwd: string) => Promise<string>;

function defaultGitRunner(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const fullArgs = [
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.fsmonitor=',
      ...args,
    ];
    execFile('git', fullArgs, { cwd, encoding: 'utf-8', env: safeGitEnv(), windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const msg = (err instanceof Error ? err.message : String(err)) + (stderr ? `\n${stderr}` : '');
        reject(new Error(msg));
      } else {
        resolve((stdout ?? '').trim());
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Fetch + ingest logic
// ---------------------------------------------------------------------------

/**
 * Resolve the HEAD commit SHA on origin/<branch> after a fetch.
 * Returns null if the branch does not exist on origin yet.
 */
async function getOriginHeadSha(
  safeCortex: string,
  repoPath: string,
  git: GitRunner,
): Promise<string | null> {
  try {
    const out = await git(['rev-parse', `origin/${safeCortex}`], repoPath);
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Maximum commits to ingest in a single poll cycle when there is no prior
 * cursor (i.e., first-ever poll for a cortex). Bounds the embed() work for
 * established cortexes with deep history.
 *
 * IMPORTANT — first-sync policy: when no cursor exists, the pull loop ingests
 * only the {@link FIRST_SYNC_MAX_COMMITS} most-recent ancestors of HEAD and
 * advances the cursor straight to HEAD. **Older history is intentionally
 * skipped.** Users who want full history backfilled into L2 should run
 * `think reindex <cortex>` after the initial sync; that command walks the
 * full L1 JSONL files (the canonical record) rather than `git rev-list`.
 */
const FIRST_SYNC_MAX_COMMITS = 100;

/**
 * Get commit SHAs reachable from `newSha` but NOT from `oldSha`.
 * Returns in chronological order (oldest first).
 *
 * When `oldSha` is null (first-ever sync) we cap the walk at
 * {@link FIRST_SYNC_MAX_COMMITS} and ingest only the newest N commits;
 * older history is intentionally skipped (see the constant's JSDoc).
 */
async function getNewCommits(
  oldSha: string | null,
  newSha: string,
  repoPath: string,
  git: GitRunner,
): Promise<string[]> {
  try {
    let args: string[];
    if (oldSha) {
      args = ['rev-list', '--ancestry-path', '--reverse', `${oldSha}..${newSha}`];
    } else {
      // First sync: cap at FIRST_SYNC_MAX_COMMITS to avoid walking unlimited
      // history in one shot. `--max-count N` returns the N newest commits;
      // `--reverse` then gives oldest-first order. The cursor is only updated
      // after ingest so on subsequent polls we pick up where we left off.
      args = ['rev-list', '--reverse', `--max-count=${FIRST_SYNC_MAX_COMMITS}`, newSha];
    }
    const out = await git(args, repoPath);
    return out.split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * List JSONL files changed/added by a commit.
 * Uses `git diff-tree` to avoid checking out the commit.
 */
async function getJsonlFilesInCommit(
  commitSha: string,
  repoPath: string,
  git: GitRunner,
): Promise<string[]> {
  try {
    const out = await git(
      ['diff-tree', '--no-commit-id', '-r', '--name-only', commitSha],
      repoPath,
    );
    return out
      .split('\n')
      .map(s => s.trim())
      .filter(f => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
}

/**
 * Read the contents of a file at a specific commit via `git show`.
 * Returns null if the file doesn't exist at that commit.
 */
async function readFileAtCommit(
  commitSha: string,
  filePath: string,
  repoPath: string,
  git: GitRunner,
): Promise<string | null> {
  try {
    return await git(['show', `${commitSha}:${filePath}`], repoPath);
  } catch {
    return null;
  }
}

/**
 * Parse a single JSONL line into a loose entry shape.
 * Returns null for blank lines or parse failures.
 */
function parseEntryLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// PullLoop class
// ---------------------------------------------------------------------------

export class PullLoop {
  private readonly safeCortex: string;
  private readonly writeLine: (msg: string) => void;

  /**
   * Optional git-runner override for unit tests. When set, used in place of
   * the real execFile-based runner so tests don't spawn subprocesses.
   * @internal Not part of the public API; tests reach it via a cast since
   * TypeScript's `private` would block them. Production callers must not
   * touch this field.
   */
  // eslint-disable-next-line @typescript-eslint/naming-convention
  private _gitOverride?: GitRunner;

  private stopped = false;
  private currentTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(cortex: string, writeLine: (msg: string) => void) {
    this.safeCortex = sanitizeName(cortex); // throws on invalid name
    this.writeLine = writeLine;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  start(): PullLoopHandle {
    // Register the interrupt callback (for AGT-311 triggerImmediatePull).
    interruptCallbacks.set(this.safeCortex, () => this.interrupt());

    // Kick off the first cycle immediately so the daemon is up-to-date on start.
    void this.cycle();

    return {
      stop: () => this.stop(),
    };
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    interruptCallbacks.delete(this.safeCortex);
    if (this.currentTimer !== null) {
      clearTimeout(this.currentTimer);
      this.currentTimer = null;
    }
    this.log('pull loop stopped');
  }

  /**
   * Called by triggerImmediatePull to interrupt the current backoff and run
   * a fetch now. Resets the timer from the current moment so the next
   * scheduled poll follows the normal interval.
   */
  private interrupt(): void {
    if (this.stopped) return;
    if (this.currentTimer !== null) {
      clearTimeout(this.currentTimer);
      this.currentTimer = null;
    }
    this.log('pull triggered by WS notification (interrupting backoff)');
    void this.cycle();
  }

  /** Execute one fetch + ingest cycle, then schedule the next. */
  private async cycle(): Promise<void> {
    if (this.stopped) return;

    // Catch ANY throw from the ingest path: DB failure, embed bomb,
    // assignNextSeq error, etc. Without this catch the rejection
    // propagates out of `void this.cycle()` as an unhandled rejection,
    // which crashes the daemon under recent Node.js. The next poll
    // retries naturally.
    try {
      await this.fetchAndIngest();
    } catch (err: unknown) {
      const msg = (err instanceof Error ? err.message : String(err))
        .replace(/[\r\n]/g, ' ');
      this.log(`WARN: unexpected error during cycle: ${msg} — retrying on next poll`);
    }

    if (this.stopped) return;

    const delayMs = nextIntervalMs(this.safeCortex);
    this.currentTimer = setTimeout(() => {
      this.currentTimer = null;
      void this.cycle();
    }, delayMs);
  }

  private async fetchAndIngest(): Promise<void> {
    const git = this._gitOverride ?? defaultGitRunner;
    const repoPath = getRepoPath();
    const safeCortex = this.safeCortex;

    // --- fetch from origin ---
    try {
      await git(['fetch', 'origin', '--quiet', '--', safeCortex], repoPath);
    } catch (fetchErr: unknown) {
      const msg = (fetchErr instanceof Error ? fetchErr.message : String(fetchErr))
        .replace(/[\r\n]/g, ' ');
      this.log(`WARN: git fetch failed for cortex '${safeCortex}': ${msg}`);
      // Pull failure: log at WARN, retry on next poll (AC#4).
      return;
    }

    // --- get the current remote HEAD ---
    const newSha = await getOriginHeadSha(safeCortex, repoPath, git);
    if (!newSha) {
      // Remote branch doesn't exist yet — nothing to ingest.
      return;
    }

    // --- compare with the last seen commit ---
    const lastSeenSha = getSyncCursor(safeCortex, CURSOR_BACKEND, CURSOR_DIRECTION);

    if (lastSeenSha === newSha) {
      // No new commits since last poll.
      return;
    }

    // --- find new commits ---
    const newCommits = await getNewCommits(lastSeenSha, newSha, repoPath, git);

    // First-sync truncation notice: when there was no prior cursor and we hit
    // the FIRST_SYNC_MAX_COMMITS cap, older history is intentionally skipped.
    // Tell the user where to look for it.
    if (lastSeenSha === null && newCommits.length === FIRST_SYNC_MAX_COMMITS) {
      this.log(
        `first-sync truncated at ${FIRST_SYNC_MAX_COMMITS} commits for cortex '${safeCortex}' — ` +
        `older history is not ingested by the pull loop. Run \`think reindex ${safeCortex}\` ` +
        `to backfill from the canonical L1 JSONL.`,
      );
    }

    if (newCommits.length === 0) {
      // No new commits to process; still update cursor to avoid re-checking.
      setSyncCursor(safeCortex, CURSOR_BACKEND, CURSOR_DIRECTION, newSha);
      return;
    }

    let totalIngested = 0;

    for (const commitSha of newCommits) {
      if (this.stopped) break;

      const changedFiles = await getJsonlFilesInCommit(commitSha, repoPath, git);

      for (const filePath of changedFiles) {
        if (this.stopped) break;

        const content = await readFileAtCommit(commitSha, filePath, repoPath, git);
        if (content === null) continue;

        const lines = content.split('\n');

        // We only want lines that are *new* in this commit, not lines that
        // existed in a prior version of the file. For an append-only JSONL
        // file the simplest approach is to get the number of lines in the
        // parent commit and skip those. For simplicity we read all lines and
        // use INSERT OR IGNORE to dedup (v2 pattern per AC#2).
        for (const line of lines) {
          const entry = parseEntryLine(line);
          if (entry === null) continue;

          const entryId = typeof entry.id === 'string' ? entry.id : null;
          if (!entryId) continue;

          await this.ingestEntry(entry, entryId);
          totalIngested++;
        }
      }
    }

    // --- update cursor ---
    // Only advance the cursor when ingest completed fully. If the loop was
    // stopped mid-ingest (daemon shutdown), the tail of newCommits was never
    // processed. Skipping the cursor update ensures those commits are
    // revisited on the next daemon start rather than being silently dropped.
    if (!this.stopped) {
      setSyncCursor(safeCortex, CURSOR_BACKEND, CURSOR_DIRECTION, newSha);
    }

    if (totalIngested > 0) {
      this.log(`ingested ${totalIngested} ${totalIngested === 1 ? 'entry' : 'entries'} from ${newCommits.length} commit(s) for cortex '${safeCortex}'`);
    }
  }

  /**
   * Insert a single entry into L2 (memories table) using INSERT OR IGNORE
   * for deduplication (v2 pattern). Unknown or malformed entries are skipped.
   * Uses `this.safeCortex` directly; no need to pass it as a parameter.
   */
  private async ingestEntry(
    entry: Record<string, unknown>,
    entryId: string,
  ): Promise<void> {
    const safeCortex = this.safeCortex;
    const ts = typeof entry.ts === 'string' ? entry.ts : new Date().toISOString();
    const author = typeof entry.author === 'string' ? entry.author : 'unknown';
    const content = typeof entry.content === 'string' ? entry.content : null;
    const originPeerId = typeof entry.origin_peer_id === 'string' ? entry.origin_peer_id : null;
    const kind = typeof entry.kind === 'string' ? entry.kind : 'memory';
    const topicsJson = Array.isArray(entry.topics) ? JSON.stringify(entry.topics) : null;
    const deletedAt = typeof entry.deleted_at === 'string' ? entry.deleted_at : null;

    if (!content) return;

    const db = getCortexDb(safeCortex);

    // Fast-path dedup check before the embed call (avoid embedding content
    // that's already indexed).
    const existing = db.prepare('SELECT id FROM memories WHERE id = ?').get(entryId);
    if (existing) return;

    // Embed the content.
    let embeddingBytes: Buffer | null = null;
    try {
      const embeddingVec = await embed(content);
      embeddingBytes = Buffer.from(
        embeddingVec.buffer,
        embeddingVec.byteOffset,
        embeddingVec.byteLength,
      );
    } catch (embedErr: unknown) {
      const msg = (embedErr instanceof Error ? embedErr.message : String(embedErr))
        .replace(/[\r\n]/g, ' ');
      // entryId is parsed from a JSONL line in the remote git tree —
      // attacker-controlled content. Strip CRLF before logging to prevent
      // log-line injection. (safeCortex is sanitizeName()-clean already.)
      this.log(`WARN: embed failed for entry ${entryId.replace(/[\r\n]/g, '')} in cortex '${safeCortex}': ${msg} — inserting without embedding`);
    }

    const activitySeq = assignNextSeq(safeCortex);

    db.prepare(`
      INSERT OR IGNORE INTO memories
        (id, ts, author, content, source_ids, created_at, deleted_at,
         sync_version, origin_peer_id, embedding, embedding_model, activity_seq,
         kind, topics_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
    `).run(
      entryId,
      ts,
      author,
      content,
      JSON.stringify([]),
      ts,
      deletedAt,
      originPeerId,
      embeddingBytes,
      embeddingBytes ? EMBEDDING_MODEL_NAME : null,
      activitySeq,
      kind,
      topicsJson,
    );
  }

  // ---------------------------------------------------------------------------
  // Logging
  // ---------------------------------------------------------------------------

  private log(msg: string): void {
    // safeCortex is sanitizeName()-clean at construction; no further stripping needed.
    this.writeLine(`[pull-loop:${this.safeCortex}] ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Module-level factory
// ---------------------------------------------------------------------------

/**
 * Start the pull loop for a single cortex. Wire this into daemon startup
 * alongside the push-debouncer and compaction-queue startup calls.
 *
 * @param cortex     Cortex name (will be validated via sanitizeName).
 * @param writeLine  Daemon log writer from daemon/index.ts.
 * @returns          A handle with a `stop()` method for graceful shutdown.
 *
 * @throws If `cortex` is not a valid cortex name (sanitizeName throws).
 */
export function startPullLoop(
  cortex: string,
  writeLine: (msg: string) => void,
): PullLoopHandle {
  const loop = new PullLoop(cortex, writeLine);
  return loop.start();
}
