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
  tombstoneMemory,
  getSyncCursor,
  setSyncCursor,
} from '../db/memory-queries.js';
import { getConfig } from '../lib/config.js';
import { deterministicId } from '../lib/deterministic-id.js';
import { validateEngramContent } from '../lib/sanitize.js';
import type { SyncAdapter, SyncResult } from './types.js';

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

    ensureRepoCloned();
    fetchBranch(cortex);

    // Get last push cursor (sync_version)
    const cursorStr = getSyncCursor(cortex, 'git', 'push');
    const lastVersion = cursorStr ? parseInt(cursorStr, 10) : 0;

    // Single fetch, read file list once, pass to both migration check and bucket determination
    const branchFiles = listBranchFiles(cortex, '.jsonl');
    try {
      this.ensureMigrated(cortex, branchFiles);
    } catch (err) {
      result.errors.push(`Migration failed: ${err instanceof Error ? err.message : String(err)}`);
      return result;
    }

    // Re-read after potential migration (migration changes the file list)
    const currentFiles = branchFiles.some(f => /^\d{6}\.jsonl$/.test(f))
      ? branchFiles
      : listBranchFiles(cortex, '.jsonl');

    // Get memories created since last push
    const newMemories = getMemoriesBySyncVersion(cortex, lastVersion);
    if (newMemories.length === 0) return result;

    // Determine which bucket file to write to
    const targetFile = this.determineBucketFile(cortex, currentFiles);

    // Format as JSONL lines (include episode_key, deleted_at, and decisions when present)
    const newLines = newMemories.map(m => {
      const decisions = m.decisions ? JSON.parse(m.decisions) as string[] : [];
      return JSON.stringify({
        ts: m.ts,
        author: m.author,
        content: m.content,
        source_ids: JSON.parse(m.source_ids),
        ...(m.episode_key ? { episode_key: m.episode_key } : {}),
        ...(m.deleted_at ? { deleted_at: m.deleted_at } : {}),
        ...(decisions.length > 0 ? { decisions } : {}),
      });
    });

    const config = getConfig();
    const commitMsg = `curate: ${config.cortex?.author ?? 'unknown'}, ${newMemories.length} memories`;
    const maxVersion = Math.max(...newMemories.map(m => m.sync_version));

    // Update cursor optimistically — if push fails, restore the old cursor.
    // If the process dies between push and cursor restore, the next push
    // re-sends the same memories, but pull uses INSERT OR IGNORE with
    // deterministic IDs so duplicates in JSONL are harmless.
    setSyncCursor(cortex, 'git', 'push', String(maxVersion));

    try {
      appendAndCommit(cortex, newLines, commitMsg, 3, targetFile);
      result.pushed = newMemories.length;
    } catch (err) {
      // Restore cursor on failure so we retry next time
      setSyncCursor(cortex, 'git', 'push', String(lastVersion));
      result.errors.push(err instanceof Error ? err.message : String(err));
    }

    return result;
  }

  private processMemories(cortex: string, memoriesRaw: string, result: SyncResult): void {
    const memories = parseMemoriesJsonl(memoriesRaw);

    for (const m of memories) {
      const id = deterministicId(m.ts, m.author, m.content);

      if (m.deleted_at) {
        // Tombstone — preserves original ts/author/content so deterministicId matches
        tombstoneMemory(cortex, id);
        continue;
      }

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
      return result;
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

    return result;
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
}
