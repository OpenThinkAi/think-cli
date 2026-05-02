import fs from 'node:fs';
import path from 'node:path';
import { parseMemoriesJsonl } from '../lib/curator.js';
import {
  getMemoriesBySyncVersion,
  insertMemoryIfNotExists,
  getSyncCursor,
  setSyncCursor,
} from '../db/memory-queries.js';
import {
  getLongTermEventsBySyncVersion,
  insertLongTermEventIfNotExists,
  tombstoneLongTermEvent,
} from '../db/long-term-queries.js';
import { getConfig, getPeerId } from '../lib/config.js';
import { deterministicId, deterministicEventId } from '../lib/deterministic-id.js';
import { validateEngramContent } from '../lib/sanitize.js';
import { sanitizeName } from '../lib/paths.js';
import type { SyncAdapter, SyncResult } from './types.js';

const BUCKET_PAD = 4;
const LONG_TERM_SUFFIX = '-long-term.jsonl';
const BUCKET_RE = new RegExp(`^(.+)-(\\d{${BUCKET_PAD}})\\.jsonl$`);

interface PullCursorMap {
  [filename: string]: number;
}

/**
 * Local-fs adapter — the canonical v2 sync backend. Writes memories as
 * peer-scoped JSONL buckets into a configured folder; reads by globbing
 * the folder. Whatever happens to the folder externally (iCloud, Drive,
 * Syncthing, USB stick, nothing) is opaque to think.
 *
 * Filenames: `<root>/<cortex>/<peer_id>-<bucket>.jsonl` for memories,
 * `<root>/<cortex>/<peer_id>-long-term.jsonl` for long-term events. Two
 * peers writing concurrently never touch the same path, which sidesteps
 * the multi-writer races that external sync tools resolve poorly.
 *
 * Single-writer-per-peer-per-cortex is required: two `think log` runs by
 * the same peer can interleave bytes on the same active bucket. The
 * design doc punts on `flock` — add only if real-world collisions show
 * up. See `~/Ideas/think-cli-v2/01-local-fs-adapter.md`.
 */
export class LocalFsSyncAdapter implements SyncAdapter {
  readonly name = 'local-fs';

  isAvailable(): boolean {
    const config = getConfig();
    return !!config.cortex?.fs?.path;
  }

  // Honest probe — fs paths can disappear (unmounted iCloud Drive, ejected
  // USB, missing parent dir). The contract requires we treat genuinely
  // unreachable as unreachable so `--if-online` can skip cleanly.
  async isReachable(): Promise<boolean> {
    const root = this.getRoot();
    if (!root) return false;
    try {
      return fs.statSync(root).isDirectory();
    } catch {
      return false;
    }
  }

  async listRemoteCortexes(): Promise<string[]> {
    const root = this.requireRoot();
    if (!fs.existsSync(root)) return [];
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort();
  }

  async createCortex(cortex: string): Promise<void> {
    const dir = this.cortexDir(cortex);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  async push(cortex: string): Promise<SyncResult> {
    const result: SyncResult = { pushed: 0, pulled: 0, errors: [] };

    try {
      this.cortexDir(cortex); // throws if root missing or cortex name invalid
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
      return result;
    }

    // Memory and long-term event push are independent — one having nothing
    // to send must not starve the other (mirrors GitSyncAdapter).
    this.pushMemories(cortex, result);
    this.pushLongTermEvents(cortex, result);
    return result;
  }

  async pull(cortex: string): Promise<SyncResult> {
    const result: SyncResult = { pushed: 0, pulled: 0, errors: [] };

    let dir: string;
    try {
      dir = this.cortexDir(cortex);
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
      return result;
    }
    if (!fs.existsSync(dir)) return result;

    this.pullMemories(cortex, dir, result);
    this.pullLongTermEvents(cortex, dir, result);
    return result;
  }

  async sync(cortex: string): Promise<SyncResult> {
    // Pull first to surface external writes before we decide which bucket
    // to append to (matches GitSyncAdapter ordering).
    const pullResult = await this.pull(cortex);
    const pushResult = await this.push(cortex);
    return {
      pushed: pushResult.pushed,
      pulled: pullResult.pulled,
      errors: [...pullResult.errors, ...pushResult.errors],
    };
  }

  // ---------------------------------------------------------------------------
  // Memory push
  // ---------------------------------------------------------------------------

  private pushMemories(cortex: string, result: SyncResult): void {
    const cursorStr = getSyncCursor(cortex, this.name, 'push');
    const lastVersion = cursorStr ? parseInt(cursorStr, 10) : 0;

    const newMemories = getMemoriesBySyncVersion(cortex, lastVersion);
    if (newMemories.length === 0) return;

    // Memories are immutable via sync — local tombstones are intentionally
    // not emitted. The contract test `enforceImmutableMemories` locks this in.
    const newLines: string[] = [];
    for (const m of newMemories) {
      if (m.deleted_at) continue;
      let decisions: string[] = [];
      if (m.decisions) {
        try { decisions = JSON.parse(m.decisions) as string[]; } catch { /* skip malformed */ }
      }
      newLines.push(JSON.stringify({
        ts: m.ts,
        author: m.author,
        content: m.content,
        source_ids: JSON.parse(m.source_ids),
        ...(m.episode_key ? { episode_key: m.episode_key } : {}),
        ...(decisions.length > 0 ? { decisions } : {}),
        ...(m.origin_peer_id ? { origin_peer_id: m.origin_peer_id } : {}),
      }));
    }

    const maxVersion = Math.max(...newMemories.map(m => m.sync_version));

    // All-tombstone batch: still advance cursor so we don't reconsider
    // the same rows on every subsequent push (matches GitSyncAdapter).
    if (newLines.length === 0) {
      setSyncCursor(cortex, this.name, 'push', String(maxVersion));
      return;
    }

    const dir = this.cortexDir(cortex);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    try {
      this.appendMemoryLines(dir, newLines);
      // Cursor advances only after the writes succeed — replay on crash is
      // correct because deterministic ids + INSERT OR IGNORE make it safe.
      setSyncCursor(cortex, this.name, 'push', String(maxVersion));
      result.pushed += newLines.length;
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  // Walk lines into the active bucket, rotating mid-batch when the bucket
  // crosses the configured cap. We re-read the line count after each append
  // group so a fresh import or a cleared workspace doesn't accidentally
  // overshoot the cap.
  private appendMemoryLines(dir: string, lines: string[]): void {
    const config = getConfig();
    const bucketSize = config.cortex?.bucketSize ?? 500;
    const peer = getPeerId();

    let { bucket, lineCount } = this.activeBucketFor(dir, peer);

    let pending: string[] = [];
    const flush = () => {
      if (pending.length === 0) return;
      const file = path.join(dir, formatBucketFilename(peer, bucket));
      fs.appendFileSync(file, pending.join('\n') + '\n');
      lineCount += pending.length;
      pending = [];
    };

    for (const line of lines) {
      if (lineCount + pending.length >= bucketSize) {
        flush();
        bucket += 1;
        lineCount = 0;
      }
      pending.push(line);
    }
    flush();
  }

  // Find the highest-numbered bucket file written by this peer, or seed
  // bucket=1 when the cortex is empty for this peer.
  private activeBucketFor(dir: string, peer: string): { bucket: number; lineCount: number } {
    const buckets = listPeerBuckets(dir, peer);
    if (buckets.length === 0) return { bucket: 1, lineCount: 0 };

    const latest = buckets[buckets.length - 1];
    const file = path.join(dir, formatBucketFilename(peer, latest));
    return { bucket: latest, lineCount: countNonBlankLines(file) };
  }

  // ---------------------------------------------------------------------------
  // Long-term event push
  // ---------------------------------------------------------------------------

  private pushLongTermEvents(cortex: string, result: SyncResult): void {
    const cursorStr = getSyncCursor(cortex, this.name, 'push_lt');
    const lastVersion = cursorStr ? parseInt(cursorStr, 10) : 0;

    const newEvents = getLongTermEventsBySyncVersion(cortex, lastVersion);
    if (newEvents.length === 0) return;

    const newLines = newEvents.map(ev => {
      let topics: string[] = [];
      let sourceMemoryIds: string[] = [];
      try { topics = JSON.parse(ev.topics) as string[]; } catch { /* skip malformed */ }
      try { sourceMemoryIds = JSON.parse(ev.source_memory_ids) as string[]; } catch { /* skip malformed */ }
      return JSON.stringify({
        ts: ev.ts,
        author: ev.author,
        kind: ev.kind,
        title: ev.title,
        content: ev.content,
        topics,
        ...(ev.supersedes ? { supersedes: ev.supersedes } : {}),
        source_memory_ids: sourceMemoryIds,
        ...(ev.deleted_at ? { deleted_at: ev.deleted_at } : {}),
      });
    });

    const maxVersion = Math.max(...newEvents.map(e => e.sync_version));
    const dir = this.cortexDir(cortex);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, getPeerId() + LONG_TERM_SUFFIX);

    try {
      fs.appendFileSync(file, newLines.join('\n') + '\n');
      setSyncCursor(cortex, this.name, 'push_lt', String(maxVersion));
      result.pushed += newEvents.length;
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  // ---------------------------------------------------------------------------
  // Memory pull
  // ---------------------------------------------------------------------------

  private pullMemories(cortex: string, dir: string, result: SyncResult): void {
    const entries = listJsonlFiles(dir);
    // Memory bucket files only — long-term files are handled separately and
    // a tail-renamed conflict file (e.g. `peer-0001 (conflict).jsonl`) doesn't
    // match BUCKET_RE but is still a memory file. We treat anything ending in
    // `.jsonl` and not in `-long-term.jsonl` as a memory bucket; deterministic
    // ids dedupe whatever lands inside.
    const memoryFiles = entries.filter(name => !name.endsWith(LONG_TERM_SUFFIX));
    if (memoryFiles.length === 0) return;

    const cursors = readPullCursors(cortex, this.name, 'pull_files');
    const updated: PullCursorMap = { ...cursors };
    let touched = false;

    for (const file of memoryFiles) {
      const filePath = path.join(dir, file);
      let raw: string;
      try {
        raw = fs.readFileSync(filePath, 'utf-8');
      } catch (err) {
        // Soft-error: an unreadable file (iCloud-evicted, permissions) gets
        // logged but doesn't abort the rest of the pull. Cursor for this file
        // is left untouched so a later pull can retry.
        result.errors.push(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      const lines = raw.split('\n');
      // The trailing element after a final newline is empty; a partial
      // crash-truncated line is JSON-broken and `parseMemoriesJsonl` skips
      // it. Either way we count *non-empty* lines as the cursor — that's
      // the unit `parseMemoriesJsonl` actually consumes.
      const consumed = cursors[file] ?? 0;
      const nonEmpty = lines.filter(l => l.length > 0);
      if (nonEmpty.length <= consumed) continue;

      const tail = nonEmpty.slice(consumed).join('\n');
      const writerPeer = inferPeerFromFilename(file);

      const memories = parseMemoriesJsonl(tail);
      for (const m of memories) {
        if (m.deleted_at) continue; // memories immutable via sync
        const id = deterministicId(m.ts, m.author, m.content);
        const { content: sanitizedContent, warnings } = validateEngramContent(m.content);
        if (warnings.length > 0) {
          result.errors.push(`Pulled memory from ${m.author} flagged: ${warnings.join(', ')}`);
        }
        const wasInserted = insertMemoryIfNotExists(cortex, {
          id,
          ts: m.ts,
          author: m.author,
          content: sanitizedContent,
          source_ids: m.source_ids,
          episode_key: m.episode_key,
          decisions: m.decisions,
          // Preserve attribution from the line; if absent (e.g. external
          // writer that didn't stamp), fall back to the writer-peer baked
          // into the bucket filename. Conflict-renamed files lack the
          // standard suffix and land as null — honest unknown.
          origin_peer_id: m.origin_peer_id ?? writerPeer ?? null,
        });
        if (wasInserted) result.pulled++;
      }

      updated[file] = nonEmpty.length;
      touched = true;
    }

    if (touched) {
      writePullCursors(cortex, this.name, 'pull_files', updated);
    }
  }

  // ---------------------------------------------------------------------------
  // Long-term event pull
  // ---------------------------------------------------------------------------

  private pullLongTermEvents(cortex: string, dir: string, result: SyncResult): void {
    const entries = listJsonlFiles(dir);
    const ltFiles = entries.filter(name => name.endsWith(LONG_TERM_SUFFIX));
    if (ltFiles.length === 0) return;

    const cursors = readPullCursors(cortex, this.name, 'pull_lt_files');
    const updated: PullCursorMap = { ...cursors };
    let touched = false;

    for (const file of ltFiles) {
      const filePath = path.join(dir, file);
      let raw: string;
      try {
        raw = fs.readFileSync(filePath, 'utf-8');
      } catch (err) {
        result.errors.push(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const lines = raw.split('\n').filter(l => l.length > 0);
      const consumed = cursors[file] ?? 0;
      if (lines.length <= consumed) continue;

      for (const line of lines.slice(consumed)) {
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(line) as Record<string, unknown>; } catch { continue; }

        const ts = typeof parsed.ts === 'string' ? parsed.ts : null;
        const author = typeof parsed.author === 'string' ? parsed.author : null;
        const title = typeof parsed.title === 'string' ? parsed.title : null;
        const content = typeof parsed.content === 'string' ? parsed.content : null;
        const kind = typeof parsed.kind === 'string' ? parsed.kind : null;
        if (!ts || !author || !title || !content || !kind) continue;

        const id = deterministicEventId(ts, author, title, content);
        const deletedAt = typeof parsed.deleted_at === 'string' ? parsed.deleted_at : null;
        if (deletedAt) {
          tombstoneLongTermEvent(cortex, id);
          continue;
        }

        const topics = Array.isArray(parsed.topics)
          ? (parsed.topics as unknown[]).filter((t): t is string => typeof t === 'string')
          : [];
        const sourceMemoryIds = Array.isArray(parsed.source_memory_ids)
          ? (parsed.source_memory_ids as unknown[]).filter((s): s is string => typeof s === 'string')
          : [];
        const supersedes = typeof parsed.supersedes === 'string' ? parsed.supersedes : null;

        const { content: sanitizedContent, warnings } = validateEngramContent(content);
        if (warnings.length > 0) {
          result.errors.push(`Pulled long-term event from ${author} flagged: ${warnings.join(', ')}`);
        }
        const inserted = insertLongTermEventIfNotExists(cortex, {
          id, ts, author, kind, title,
          content: sanitizedContent,
          topics, supersedes,
          source_memory_ids: sourceMemoryIds,
        });
        if (inserted) result.pulled++;
      }

      updated[file] = lines.length;
      touched = true;
    }

    if (touched) {
      writePullCursors(cortex, this.name, 'pull_lt_files', updated);
    }
  }

  // ---------------------------------------------------------------------------
  // Path helpers
  // ---------------------------------------------------------------------------

  private getRoot(): string | null {
    const config = getConfig();
    return config.cortex?.fs?.path ?? null;
  }

  private requireRoot(): string {
    const root = this.getRoot();
    if (!root) {
      throw new Error('local-fs sync backend not configured (run: think cortex setup --fs <path>)');
    }
    return root;
  }

  private cortexDir(cortex: string): string {
    return path.join(this.requireRoot(), sanitizeName(cortex));
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

function formatBucketFilename(peer: string, bucket: number): string {
  return `${peer}-${String(bucket).padStart(BUCKET_PAD, '0')}.jsonl`;
}

function listJsonlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(name => name.endsWith('.jsonl'))
    .sort();
}

// Returns the bucket numbers this peer has written, sorted ascending.
function listPeerBuckets(dir: string, peer: string): number[] {
  return listJsonlFiles(dir)
    .map(name => {
      const m = BUCKET_RE.exec(name);
      if (!m || m[1] !== peer) return null;
      return parseInt(m[2], 10);
    })
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);
}

// Captures the writer peer-id from a strict bucket filename. Conflict-
// renamed files (e.g. iCloud's "peer-0001 (conflict).jsonl") don't match
// and return null, in which case attribution falls back to the line's
// own `origin_peer_id` or honest-unknown.
function inferPeerFromFilename(name: string): string | null {
  const m = BUCKET_RE.exec(name);
  return m ? m[1] : null;
}

function countNonBlankLines(file: string): number {
  if (!fs.existsSync(file)) return 0;
  const raw = fs.readFileSync(file, 'utf-8');
  let count = 0;
  for (const line of raw.split('\n')) {
    if (line.length > 0) count++;
  }
  return count;
}

// Per-file pull cursors live in a single sync_cursors row keyed
// (cortex, "local-fs", "pull_files") — one JSON blob mapping filename to
// number of lines consumed. Single row keeps updates atomic and avoids
// unbounded row growth as bucket files accumulate.
function readPullCursors(cortex: string, backend: string, direction: string): PullCursorMap {
  const raw = getSyncCursor(cortex, backend, direction);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: PullCursorMap = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
      }
      return out;
    }
  } catch { /* corrupt cursor — treat as fresh */ }
  return {};
}

function writePullCursors(cortex: string, backend: string, direction: string, map: PullCursorMap): void {
  setSyncCursor(cortex, backend, direction, JSON.stringify(map));
}
