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
    // AGT-1323 — ROOT CAUSE OF THE ~14% CONVERGENCE FLAKE. Read before
    // touching this block.
    //
    // This used to call `createCortex` on BOTH peers and swallow the second
    // one's push rejection. `createCortex` -> `createOrphanBranch` builds a
    // *parentless* commit, so peer B minted a second root for a branch peer A
    // had already created. Whether that second root was harmless came down to
    // a coin flip on the clock:
    //
    //   - Git commit ids hash the tree, the message, the identity AND the
    //     commit timestamp, which has one-second resolution. Both orphan
    //     commits carry the same empty `<cortex>/000001.jsonl`, the same
    //     `.gitattributes`, the same `init: create cortex <name>` message and
    //     the same suite-wide git identity. Land them inside one wall-clock
    //     second and they hash *identically* — peer B's "new" root IS peer A's
    //     commit, its push is a no-op, the histories are related and every
    //     test passes.
    //   - Straddle a second boundary and peer B's branch is an unrelated root.
    //     Its create-time push is rejected (swallowed here), and from then on
    //     every `appendAndCommit` -> `ensureOnBranch` -> `git merge --ff-only
    //     origin/<cortex>` dies with `fatal: refusing to merge unrelated
    //     histories`. `tryFfOnly` only forgives "couldn't find remote ref" and
    //     "Not possible to fast-forward", so that error propagated out of
    //     `appendAndCommit` into `SyncResult.errors` — which these convergence
    //     tests do not assert on. Peer B's write never reached the remote and
    //     peer A's final sync saw nothing: `expected 1 to be 2` and
    //     `expected [ Array(1) ] to include '<rB.id>'`.
    //
    // The failure rate was therefore just the fraction of a second between the
    // two `createOrphanBranch` calls — ~14% idle, far worse under load, which
    // is exactly the reported shape. Measured on this fixture: 10/25 and 7/15
    // failures, with a 1:1 correlation to "the two roots hashed differently".
    //
    // Production never reaches that state: `ensureRemoteBranch` only creates
    // an orphan when `branchExists()` says the remote has none, and a second
    // machine joins an existing cortex by cloning it. The fixture was modelling
    // something the adapter does not do. So it now models the real thing —
    // first peer creates, every later peer just clones and joins — and the
    // create is no longer allowed to fail: a rejection here is a genuine bug,
    // not noise to swallow.
    const adapter = new GitSyncAdapter();
    // `listRemoteCortexes()` clones the repo for this peer as a side effect
    // (`ensureRepoCloned`), which is precisely how a joining peer gets its
    // working copy — no orphan branch required.
    const remoteCortexes = await adapter.listRemoteCortexes();
    if (!remoteCortexes.includes(cortexName)) {
      await adapter.createCortex(cortexName);
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

    // AGT-1323: assert on `errors` at every hop. The flake this test used to
    // carry was a push that failed and reported itself here, where nothing
    // looked — the convergence assertion below then failed two syncs later
    // with no hint of why. An empty-errors check turns any future swallowed
    // git failure into a named failure at the hop that caused it.
    pair.peerA.activate();
    expect((await adapter.sync(pair.cortexName)).errors).toEqual([]);
    pair.peerB.activate();
    expect((await adapter.sync(pair.cortexName)).errors).toEqual([]);
    pair.peerA.activate();
    expect((await adapter.sync(pair.cortexName)).errors).toEqual([]); // peer A pulls peer B's retro

    const { getCortexDb } = await import('../../src/db/engrams.js');
    const dbA = getCortexDb(pair.cortexName);
    const idsOnA = (dbA.prepare('SELECT id FROM retros').all() as { id: string }[]).map(r => r.id);
    expect(idsOnA).toContain(rA.id);
    expect(idsOnA).toContain(rB.id);
  });

  // AGT-1323 regression pin. The convergence flake above was never a timing
  // race inside the adapter — it was a *second root commit* on the cortex
  // branch, minted by a fixture that called `createCortex` on both peers and
  // only survived when the two orphan commits happened to hash alike (see the
  // long note on `configurePeer`). That made the failure rate a function of
  // where the second boundary fell: ~14% idle, worse under load.
  //
  // This test removes the coin flip. It pins the commit dates so the rival
  // root CANNOT collide with peer A's, reproduces the state 100% of the time,
  // and asserts the two properties that matter:
  //
  //   1. the write is lost — which is why a peer must never mint a rival root,
  //      and why `configurePeer` now joins by cloning instead;
  //   2. the loss is LOUD. It arrives in `SyncResult.errors`, not as a silent
  //      success. Every convergence test above now asserts that channel is
  //      empty, so this mechanism can never again masquerade as a flake.
  //
  // If someone reintroduces a second `createCortex` call, the convergence
  // tests fail on `errors` with `refusing to merge unrelated histories` in the
  // message rather than on an inscrutable count.
  it('a rival root commit on the cortex branch wedges push and says so (AGT-1323)', async () => {
    const { createPeerPair } = await import('../fixtures/peer-pair.js');
    const { insertRetro } = await import('../../src/db/retro-queries.js');

    pair = createPeerPair();
    remote = factory.setupRemote(pair.cortexName) as GitRemote;
    pair.peerA.activate();
    await factory.configurePeer(pair.peerA, pair.cortexName, remote);
    pair.peerB.activate();
    await factory.configurePeer(pair.peerB, pair.cortexName, remote);
    const adapter = factory.createAdapter();

    // Peer A seeds the cortex so the remote history is non-trivial.
    pair.peerA.activate();
    insertRetro(pair.cortexName, { content: 'peer A retro' });
    expect((await adapter.sync(pair.cortexName)).errors).toEqual([]);

    // Force the historic bad state on peer B: a parentless commit for a branch
    // that already has a root. Pinning the dates guarantees a different commit
    // id than peer A's root, so this is deterministic rather than 1-in-7.
    pair.peerB.activate();
    const pinnedDate = '2000-01-01T00:00:00Z';
    const savedAuthorDate = process.env.GIT_AUTHOR_DATE;
    const savedCommitterDate = process.env.GIT_COMMITTER_DATE;
    process.env.GIT_AUTHOR_DATE = pinnedDate;
    process.env.GIT_COMMITTER_DATE = pinnedDate;
    try {
      await adapter.createCortex(pair.cortexName);
      // The create-time push is rejected (non-fast-forward) — that rejection
      // is the only warning production would get, and `configurePeer` used to
      // throw it away.
      expect.unreachable('pushing a rival root must be rejected by the remote');
    } catch (err) {
      expect(String(err)).toMatch(/non-fast-forward|rejected|fetch first/i);
    } finally {
      if (savedAuthorDate === undefined) delete process.env.GIT_AUTHOR_DATE;
      else process.env.GIT_AUTHOR_DATE = savedAuthorDate;
      if (savedCommitterDate === undefined) delete process.env.GIT_COMMITTER_DATE;
      else process.env.GIT_COMMITTER_DATE = savedCommitterDate;
    }

    // Peer B is now on an unrelated root. Its retro cannot reach the remote.
    const rB = insertRetro(pair.cortexName, { content: 'peer B retro on a rival root' });
    const wedged = await adapter.sync(pair.cortexName);
    expect(wedged.pushed).toBe(0);
    expect(wedged.errors.join('\n')).toMatch(/unrelated histories/);

    // And peer A never sees it — the exact data loss the flake was reporting.
    pair.peerA.activate();
    expect((await adapter.sync(pair.cortexName)).errors).toEqual([]);
    const { getCortexDb } = await import('../../src/db/engrams.js');
    const idsOnA = (getCortexDb(pair.cortexName).prepare('SELECT id FROM retros').all() as { id: string }[])
      .map(r => r.id);
    expect(idsOnA).not.toContain(rB.id);
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
