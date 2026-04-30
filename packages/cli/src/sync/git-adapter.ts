import { execFileSync } from 'node:child_process';
import {
  ensureRepoCloned,
  fetchBranch,
  readFileFromBranch,
  appendAndCommit,
  createOrphanBranch,
  branchExists,
  listRemoteBranches,
  listBranchFiles,
  countBranchFileLines,
  migrateToBuckets,
} from '../lib/git.js';
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
import { getConfig } from '../lib/config.js';
import { deterministicId, deterministicEventId } from '../lib/deterministic-id.js';
import { validateEngramContent } from '../lib/sanitize.js';
import type { SyncAdapter, SyncResult } from './types.js';

const LONG_TERM_FILE = 'long-term.jsonl';

export class GitSyncAdapter implements SyncAdapter {
  readonly name = 'git';

  isAvailable(): boolean {
    const config = getConfig();
    return !!config.cortex?.repo;
  }

  private ensureMigrated(cortex: string, branchFiles: string[]): void {
    const hasNumbered = branchFiles.some(f => /^\d{6}\.jsonl$/.test(f));
    if (!hasNumbered) {
      const hasLegacy = readFileFromBranch(cortex, 'memories.jsonl') !== null;
      if (hasLegacy) {
        migrateToBuckets(cortex);
      }
    }
  }

  private determineBucketFile(cortex: string, branchFiles: string[]): string {
    const config = getConfig();
    const bucketSize = config.cortex?.bucketSize ?? 500;

    const numbered = branchFiles.filter(f => /^\d{6}\.jsonl$/.test(f));
    if (numbered.length === 0) return '000001.jsonl';

    const latestFile = numbered[numbered.length - 1];
    const lineCount = countBranchFileLines(cortex, latestFile);

    if (lineCount >= bucketSize) {
      const nextNum = parseInt(latestFile.replace('.jsonl', ''), 10) + 1;
      return String(nextNum).padStart(6, '0') + '.jsonl';
    }
    return latestFile;
  }

  async push(cortex: string): Promise<SyncResult> {
    const result: SyncResult = { pushed: 0, pulled: 0, errors: [] };

    try {
      ensureRepoCloned();
      fetchBranch(cortex);
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
      return result;
    }

    // Memory push and long-term event push are independent. Keep them as
    // separate steps so one having nothing to send doesn't starve the other.
    this.pushMemories(cortex, result);
    this.pushLongTermEvents(cortex, result);

    return result;
  }

  private pushMemories(cortex: string, result: SyncResult): void {
    // Get last push cursor (sync_version)
    const cursorStr = getSyncCursor(cortex, 'git', 'push');
    const lastVersion = cursorStr ? parseInt(cursorStr, 10) : 0;

    // Single fetch, read file list once, pass to both migration check and bucket determination
    const branchFiles = listBranchFiles(cortex, '.jsonl');
    try {
      this.ensureMigrated(cortex, branchFiles);
    } catch (err) {
      result.errors.push(`Migration failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // Re-read after potential migration (migration changes the file list)
    const currentFiles = branchFiles.some(f => /^\d{6}\.jsonl$/.test(f))
      ? branchFiles
      : listBranchFiles(cortex, '.jsonl');

    // Get memories created since last push
    const newMemories = getMemoriesBySyncVersion(cortex, lastVersion);
    if (newMemories.length === 0) return;

    // Determine which bucket file to write to
    const targetFile = this.determineBucketFile(cortex, currentFiles);

    // Format as JSONL lines (include episode_key and decisions when present).
    // Memories are immutable via sync — local tombstones are intentionally not
    // emitted here. See SyncAdapter docs for the invariant.
    const newLines = newMemories
      .filter(m => !m.deleted_at)
      .map(m => {
        let decisions: string[] = [];
        if (m.decisions) {
          try { decisions = JSON.parse(m.decisions) as string[]; } catch { /* skip malformed */ }
        }
        return JSON.stringify({
          ts: m.ts,
          author: m.author,
          content: m.content,
          source_ids: JSON.parse(m.source_ids),
          ...(m.episode_key ? { episode_key: m.episode_key } : {}),
          ...(decisions.length > 0 ? { decisions } : {}),
        });
      });

    const config = getConfig();
    const maxVersion = Math.max(...newMemories.map(m => m.sync_version));

    // If every row in this batch was a tombstone, nothing to commit, but the
    // cursor must still advance — otherwise the same batch comes back next
    // push and we re-evaluate them forever.
    if (newLines.length === 0) {
      setSyncCursor(cortex, 'git', 'push', String(maxVersion));
      return;
    }

    const commitMsg = `curate: ${config.cortex?.author ?? 'unknown'}, ${newLines.length} memories`;

    // Advance cursor only after the commit succeeds. If we advanced before
    // and the process crashed between setSyncCursor and appendAndCommit,
    // the cursor would be permanently past memories that never shipped.
    // Pull-side INSERT OR IGNORE with deterministic ids makes resending
    // safe, so advancing late is correct.
    try {
      appendAndCommit(cortex, newLines, commitMsg, 3, targetFile);
      setSyncCursor(cortex, 'git', 'push', String(maxVersion));
      result.pushed += newLines.length;
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  private pushLongTermEvents(cortex: string, result: SyncResult): void {
    const cursorStr = getSyncCursor(cortex, 'git', 'push_lt');
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

    const config = getConfig();
    const commitMsg = `long-term: ${config.cortex?.author ?? 'unknown'}, ${newEvents.length} event${newEvents.length === 1 ? '' : 's'}`;
    const maxVersion = Math.max(...newEvents.map(e => e.sync_version));

    // Advance cursor only after commit succeeds (see memory push rationale).
    try {
      appendAndCommit(cortex, newLines, commitMsg, 3, LONG_TERM_FILE);
      setSyncCursor(cortex, 'git', 'push_lt', String(maxVersion));
      result.pushed += newEvents.length;
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  private processMemories(cortex: string, memoriesRaw: string, result: SyncResult): void {
    const memories = parseMemoriesJsonl(memoriesRaw);

    for (const m of memories) {
      // Memories are immutable via sync — any `deleted_at` field on a pulled
      // line is from a pre-BLOOM-122 emitter and must be ignored. Engram
      // deletes are local-only and do not propagate.
      if (m.deleted_at) continue;

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
      });
      if (wasInserted) result.pulled++;
    }
  }

  async pull(cortex: string): Promise<SyncResult> {
    const result: SyncResult = { pushed: 0, pulled: 0, errors: [] };

    try {
      ensureRepoCloned();
      fetchBranch(cortex);
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
      return result;
    }

    // Memory pull and long-term event pull are independent. Running both
    // unconditionally ensures an empty memory side doesn't strand events.
    this.pullMemories(cortex, result);
    this.pullLongTermEvents(cortex, result);

    return result;
  }

  private pullMemories(cortex: string, result: SyncResult): void {
    const config = getConfig();
    const onboardingDepth = config.cortex?.onboardingDepth ?? 1500;
    const bucketSize = config.cortex?.bucketSize ?? 500;

    // List numbered bucket files
    const files = listBranchFiles(cortex, '.jsonl')
      .filter(f => /^\d{6}\.jsonl$/.test(f))
      .sort();

    if (files.length === 0) {
      // Legacy fallback: try memories.jsonl
      const memoriesRaw = readFileFromBranch(cortex, 'memories.jsonl') ?? '';
      if (memoriesRaw) {
        this.processMemories(cortex, memoriesRaw, result);
      }
      return;
    }

    // Determine which files to read
    const pullCursor = getSyncCursor(cortex, 'git', 'pull_file');
    let filesToRead: string[];

    if (!pullCursor) {
      // Onboarding: read last N files based on configured depth
      const numFiles = Math.ceil(onboardingDepth / bucketSize);
      filesToRead = files.slice(-numFiles);
    } else {
      // Incremental: read from cursor file onward (re-read cursor file to catch appends)
      const cursorIndex = files.indexOf(pullCursor);
      if (cursorIndex === -1) {
        // Cursor file not found — fall back to onboarding
        const numFiles = Math.ceil(onboardingDepth / bucketSize);
        filesToRead = files.slice(-numFiles);
      } else {
        filesToRead = files.slice(cursorIndex);
      }
    }

    // Process files in ascending order (critical for tombstone correctness).
    // Stop at the first read failure — don't advance cursor past a gap.
    let lastReadFile: string | null = null;
    for (const file of filesToRead) {
      const raw = readFileFromBranch(cortex, file);
      if (raw === null) {
        // Read failure — stop here. Cursor stays at lastReadFile so this
        // file and all subsequent files get retried on next pull.
        break;
      }
      lastReadFile = file;
      if (raw.trim()) {
        this.processMemories(cortex, raw, result);
      }
    }

    // Advance cursor to the last file we successfully read (empty or not)
    if (lastReadFile) {
      setSyncCursor(cortex, 'git', 'pull_file', lastReadFile);
    }
  }

  private pullLongTermEvents(cortex: string, result: SyncResult): void {
    const raw = readFileFromBranch(cortex, LONG_TERM_FILE);
    if (raw === null || !raw.trim()) return; // file doesn't exist or is empty

    for (const line of raw.trim().split('\n')) {
      if (!line.trim()) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // skip malformed
      }

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
        id,
        ts,
        author,
        kind,
        title,
        content: sanitizedContent,
        topics,
        supersedes,
        source_memory_ids: sourceMemoryIds,
      });
      if (inserted) result.pulled++;
    }
  }

  async sync(cortex: string): Promise<SyncResult> {
    // Pull first to get latest, then push local changes
    const pullResult = await this.pull(cortex);
    const pushResult = await this.push(cortex);

    return {
      pushed: pushResult.pushed,
      pulled: pullResult.pulled,
      errors: [...pullResult.errors, ...pushResult.errors],
    };
  }

  async listRemoteCortexes(): Promise<string[]> {
    ensureRepoCloned();
    return listRemoteBranches();
  }

  async createCortex(cortex: string): Promise<void> {
    ensureRepoCloned();
    createOrphanBranch(cortex);
  }

  // Probe by running `git ls-remote --exit-code <repo> HEAD` against the
  // configured remote with a 5s timeout. Network failures (DNS, TCP, VPN)
  // exit non-zero quickly and we report unreachable. Auth failures (bad SSH
  // key, expired token, host key mismatch) ALSO exit non-zero, but the
  // SyncAdapter contract requires us to report those as reachable so the
  // caller's subsequent sync surfaces the real auth error loudly. We
  // distinguish by inspecting stderr for known auth-failure patterns —
  // imperfect (locale-dependent), but catches every failure mode git
  // produces in English.
  async isReachable(): Promise<boolean> {
    const config = getConfig();
    const repo = config.cortex?.repo;
    if (!repo) return false;
    try {
      execFileSync(
        'git',
        ['-c', 'core.hooksPath=/dev/null', 'ls-remote', '--exit-code', '--', repo, 'HEAD'],
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      );
      return true;
    } catch (err) {
      // execFileSync surfaces stderr on the thrown error. If stderr looks
      // like an auth/credential failure, treat the host as reachable so the
      // caller runs the full sync and the real error surfaces — see the
      // SyncAdapter.isReachable contract.
      const stderr = (err as NodeJS.ErrnoException & { stderr?: Buffer | string })?.stderr;
      const stderrText = stderr ? (Buffer.isBuffer(stderr) ? stderr.toString('utf8') : stderr) : '';
      if (looksLikeAuthFailure(stderrText)) return true;
      return false;
    }
  }
}

// English-only matchers covering every auth-flavored failure git surfaces:
// SSH publickey rejection, HTTPS Basic auth, host key verification failure,
// suppressed-prompt empty-credential paths, and protocol-error variants
// servers send when an authenticated request is malformed.
function looksLikeAuthFailure(stderr: string): boolean {
  if (!stderr) return false;
  const patterns = [
    /Permission denied/i,
    /publickey/i,
    /Authentication failed/i,
    /could not read (Username|Password)/i,
    /Host key verification failed/i,
    /access denied/i,
    /403\s+Forbidden/,
    /401\s+Unauthorized/,
    /access rights/i,
  ];
  return patterns.some((re) => re.test(stderr));
}
