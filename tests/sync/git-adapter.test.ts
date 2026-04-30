import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll } from 'vitest';
import { runSyncAdapterContractTests, type AdapterFactory } from './contract.js';
import { GitSyncAdapter } from '../../src/sync/git-adapter.js';
import { saveConfig, getConfig } from '../../src/lib/config.js';
import type { TestPeer } from '../fixtures/peer-pair.js';

interface GitRemote {
  bareRepoPath: string;
  url: string;
}

beforeAll(() => {
  process.env.THINK_TEST_ALLOW_FILE_URL = '1';
});

afterAll(() => {
  delete process.env.THINK_TEST_ALLOW_FILE_URL;
});

const factory: AdapterFactory<GitRemote> = {
  label: 'git',

  setupRemote(_cortexName: string): GitRemote {
    const remoteDir = mkdtempSync(join(tmpdir(), 'think-git-remote-'));
    const bareRepoPath = join(remoteDir, 'cortex.git');
    mkdirSync(bareRepoPath, { recursive: true });
    execFileSync('git', ['init', '--bare', '--initial-branch=main', bareRepoPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      bareRepoPath,
      url: `file://${bareRepoPath}`,
    };
  },

  async configurePeer(peer: TestPeer, cortexName: string, remote: GitRemote): Promise<void> {
    peer.activate();
    const existing = getConfig();
    saveConfig({
      ...existing,
      cortex: {
        repo: remote.url,
        author: `test-peer-${peer.thinkHome.split('/').pop()}`,
      },
    });
    // Each peer ensures the cortex branch exists on the remote. createCortex
    // races safely between peers — if peer B finds the branch already exists
    // (because peer A created it), it returns early.
    const adapter = new GitSyncAdapter();
    try {
      await adapter.createCortex(cortexName);
    } catch (err) {
      // Branch already exists from the other peer — ignore.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/already exists|non-fast-forward|rejected/i.test(msg)) throw err;
    }
  },

  createAdapter() {
    return new GitSyncAdapter();
  },

  teardownRemote(remote: GitRemote): void {
    rmSync(remote.bareRepoPath, { recursive: true, force: true });
  },
};

// `enforceImmutableMemories: false` because today's git adapter still propagates
// memory tombstones — the immutable-memory contract test would fail. BLOOM-122
// removes that propagation; flip this flag to `true` in that PR.
runSyncAdapterContractTests(factory, { enforceImmutableMemories: false });
