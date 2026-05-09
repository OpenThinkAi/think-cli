import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, afterEach, describe, it, expect } from 'vitest';
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

// Memory tombstones are not propagated by sync (BLOOM-122). The contract
// suite enforces this for every adapter. Origin peer-id round-trip is
// asserted only on adapters whose wire format carries the field — git
// does, HTTP does not yet (server-side follow-up).
runSyncAdapterContractTests(factory, { enforceImmutableMemories: true, enforceOriginPeerId: true });

// Retro push/pull rides a parallel codepath (per-peer JSONL on the orphan
// branch, separate cursors). Tests mirror the local-fs retro block.
describe('git retro sync', () => {
  let pair: ReturnType<typeof import('../fixtures/peer-pair.js').createPeerPair> | null = null;
  let remote: GitRemote | null = null;

  afterEach(() => {
    if (remote) factory.teardownRemote!(remote);
    pair?.cleanup();
    pair = null;
    remote = null;
  });

  it('pushes retros to the orphan branch and pulls on the other peer', async () => {
    const { createPeerPair } = await import('../fixtures/peer-pair.js');
    const { insertRetro } = await import('../../src/db/retro-queries.js');

    pair = createPeerPair();
    remote = factory.setupRemote(pair.cortexName) as GitRemote;
    pair.peerA.activate();
    await factory.configurePeer(pair.peerA, pair.cortexName, remote);
    pair.peerB.activate();
    await factory.configurePeer(pair.peerB, pair.cortexName, remote);
    const adapter = factory.createAdapter();

    pair.peerA.activate();
    const r = insertRetro(pair.cortexName, { content: 'git-backed retro test', kind: 'invariant' });

    await adapter.sync(pair.cortexName);

    pair.peerB.activate();
    await adapter.sync(pair.cortexName);

    const { getCortexDb } = await import('../../src/db/engrams.js');
    const dbB = getCortexDb(pair.cortexName);
    const row = dbB.prepare('SELECT id, content, kind FROM retros WHERE id = ?').get(r.id) as {
      id: string; content: string; kind: string;
    } | undefined;
    expect(row).toBeDefined();
    expect(row!.content).toBe('git-backed retro test');
    expect(row!.kind).toBe('invariant');
  });

  it('idempotent — re-syncing does not duplicate rows', async () => {
    const { createPeerPair } = await import('../fixtures/peer-pair.js');
    const { insertRetro } = await import('../../src/db/retro-queries.js');

    pair = createPeerPair();
    remote = factory.setupRemote(pair.cortexName) as GitRemote;
    pair.peerA.activate();
    await factory.configurePeer(pair.peerA, pair.cortexName, remote);
    pair.peerB.activate();
    await factory.configurePeer(pair.peerB, pair.cortexName, remote);
    const adapter = factory.createAdapter();

    pair.peerA.activate();
    insertRetro(pair.cortexName, { content: 'idempotent git retro' });
    await adapter.sync(pair.cortexName);

    pair.peerB.activate();
    await adapter.sync(pair.cortexName);
    await adapter.sync(pair.cortexName); // second pull — cursor must prevent duplicate

    const { getCortexDb } = await import('../../src/db/engrams.js');
    const dbB = getCortexDb(pair.cortexName);
    const count = (dbB.prepare('SELECT COUNT(*) as c FROM retros').get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('propagates tombstones across peers', async () => {
    const { createPeerPair } = await import('../fixtures/peer-pair.js');
    const { insertRetro, mergeRetro } = await import('../../src/db/retro-queries.js');

    pair = createPeerPair();
    remote = factory.setupRemote(pair.cortexName) as GitRemote;
    pair.peerA.activate();
    await factory.configurePeer(pair.peerA, pair.cortexName, remote);
    pair.peerB.activate();
    await factory.configurePeer(pair.peerB, pair.cortexName, remote);
    const adapter = factory.createAdapter();

    pair.peerA.activate();
    const r1 = insertRetro(pair.cortexName, { content: 'canonical git retro' });
    const r2 = insertRetro(pair.cortexName, { content: 'duplicate git retro' });

    pair.peerA.activate();
    await adapter.sync(pair.cortexName);
    pair.peerB.activate();
    await adapter.sync(pair.cortexName);

    pair.peerA.activate();
    mergeRetro(pair.cortexName, r1.id, r2.id);
    await adapter.sync(pair.cortexName);

    pair.peerB.activate();
    await adapter.sync(pair.cortexName);

    const { getCortexDb } = await import('../../src/db/engrams.js');
    const dbB = getCortexDb(pair.cortexName);
    const row = dbB.prepare('SELECT tombstoned_at, tombstone_reason FROM retros WHERE id = ?').get(r2.id) as {
      tombstoned_at: string | null;
      tombstone_reason: string | null;
    } | undefined;
    expect(row).toBeDefined();
    expect(row!.tombstoned_at).toBeTruthy();
    expect(row!.tombstone_reason).toBe(`merged_into:${r1.id}`);
  });

  it('two peers converge when both write retros', async () => {
    const { createPeerPair } = await import('../fixtures/peer-pair.js');
    const { insertRetro } = await import('../../src/db/retro-queries.js');

    pair = createPeerPair();
    remote = factory.setupRemote(pair.cortexName) as GitRemote;
    pair.peerA.activate();
    await factory.configurePeer(pair.peerA, pair.cortexName, remote);
    pair.peerB.activate();
    await factory.configurePeer(pair.peerB, pair.cortexName, remote);
    const adapter = factory.createAdapter();

    pair.peerA.activate();
    const rA = insertRetro(pair.cortexName, { content: 'peer A git retro' });
    pair.peerB.activate();
    const rB = insertRetro(pair.cortexName, { content: 'peer B git retro' });

    pair.peerA.activate();
    await adapter.sync(pair.cortexName);
    pair.peerB.activate();
    await adapter.sync(pair.cortexName);
    pair.peerA.activate();
    await adapter.sync(pair.cortexName); // peer A pulls peer B's retro

    const { getCortexDb } = await import('../../src/db/engrams.js');
    const dbA = getCortexDb(pair.cortexName);
    const idsOnA = (dbA.prepare('SELECT id FROM retros').all() as { id: string }[]).map(r => r.id);
    expect(idsOnA).toContain(rA.id);
    expect(idsOnA).toContain(rB.id);
  });

  // AGT-209 / GH#47: when `cortex create` succeeded locally but the orphan-
  // branch push silently failed (transient remote write-perm, network blip),
  // every subsequent sync's `fetchBranch` raised `fatal: couldn't find remote
  // ref <name>` permanently. The push/pull paths now lazily create the
  // missing orphan branch via ensureRemoteBranch so the cortex self-heals.
  it('sync self-heals a missing orphan branch (AGT-209 AC #4)', async () => {
    const { createPeerPair } = await import('../fixtures/peer-pair.js');
    const { insertRetro } = await import('../../src/db/retro-queries.js');

    pair = createPeerPair();
    remote = factory.setupRemote(pair.cortexName) as GitRemote;

    // Configure peer A but skip configurePeer's createCortex step so the
    // remote ref intentionally does NOT exist — simulates the "local cortex
    // exists, remote orphan never landed" failure mode AGT-209 reported.
    pair.peerA.activate();
    saveConfig({
      ...getConfig(),
      cortex: {
        repo: remote.url,
        author: 'test-peer-A',
      },
    });
    const adapter = factory.createAdapter();

    insertRetro(pair.cortexName, { content: 'first retro on a never-pushed cortex' });

    // Pre-condition: the remote ref does not exist yet.
    const branchesBefore = await adapter.listRemoteCortexes();
    expect(branchesBefore).not.toContain(pair.cortexName);

    // Sync used to fail with `fatal: couldn't find remote ref`. With the
    // ensureRemoteBranch self-heal, push lazily creates the orphan and the
    // retro lands on the remote.
    const result = await adapter.sync(pair.cortexName);
    expect(result.errors).toEqual([]);
    expect(result.pushed).toBeGreaterThanOrEqual(1);

    const branchesAfter = await adapter.listRemoteCortexes();
    expect(branchesAfter).toContain(pair.cortexName);
  });
});
