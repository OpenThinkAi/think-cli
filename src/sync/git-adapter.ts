import {
  ensureRepoCloned,
  fetchBranch,
  readFileFromBranch,
  appendAndCommit,
  createOrphanBranch,
  branchExists,
  listRemoteBranches,
} from '../lib/git.js';
import { parseMemoriesJsonl } from '../lib/curator.js';
import {
  getMemoriesBySyncVersion,
  insertMemoryIfNotExists,
  getSyncCursor,
  setSyncCursor,
} from '../db/memory-queries.js';
import { getConfig } from '../lib/config.js';
import { deterministicId } from '../lib/deterministic-id.js';
import type { SyncAdapter, SyncResult } from './types.js';

export class GitSyncAdapter implements SyncAdapter {
  readonly name = 'git';

  isAvailable(): boolean {
    const config = getConfig();
    return !!config.cortex?.repo;
  }

  async push(cortex: string): Promise<SyncResult> {
    const result: SyncResult = { pushed: 0, pulled: 0, errors: [] };

    ensureRepoCloned();

    // Get last push cursor (sync_version)
    const cursorStr = getSyncCursor(cortex, 'git', 'push');
    const lastVersion = cursorStr ? parseInt(cursorStr, 10) : 0;

    // Get memories created since last push
    const newMemories = getMemoriesBySyncVersion(cortex, lastVersion);
    if (newMemories.length === 0) return result;

    // Format as JSONL lines
    const newLines = newMemories.map(m => JSON.stringify({
      ts: m.ts,
      author: m.author,
      content: m.content,
      source_ids: JSON.parse(m.source_ids),
    }));

    const config = getConfig();
    const commitMsg = `curate: ${config.cortex?.author ?? 'unknown'}, ${newMemories.length} memories`;
    const maxVersion = Math.max(...newMemories.map(m => m.sync_version));

    // Update cursor optimistically — if push fails, restore the old cursor.
    // If the process dies between push and cursor restore, the next push
    // re-sends the same memories, but pull uses INSERT OR IGNORE with
    // deterministic IDs so duplicates in JSONL are harmless.
    setSyncCursor(cortex, 'git', 'push', String(maxVersion));

    try {
      appendAndCommit(cortex, newLines, commitMsg);
      result.pushed = newMemories.length;
    } catch (err) {
      // Restore cursor on failure so we retry next time
      setSyncCursor(cortex, 'git', 'push', String(lastVersion));
      result.errors.push(err instanceof Error ? err.message : String(err));
    }

    return result;
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

    // Read full memories.jsonl from git
    const memoriesRaw = readFileFromBranch(cortex, 'memories.jsonl') ?? '';
    const memories = parseMemoriesJsonl(memoriesRaw);

    // Diff against local — insert any that don't exist
    for (const m of memories) {
      const id = deterministicId(m.ts, m.author, m.content);
      const wasInserted = insertMemoryIfNotExists(cortex, {
        id,
        ts: m.ts,
        author: m.author,
        content: m.content,
        source_ids: m.source_ids,
      });
      if (wasInserted) result.pulled++;
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
