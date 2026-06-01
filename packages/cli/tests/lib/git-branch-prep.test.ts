/**
 * AGT-437 — hermetic tests for idempotent branch-prep helpers.
 *
 * Covers AC 1–4 and 6 from the ticket:
 *  AC 1: first-shot success when local branch already exists
 *  AC 2: same-session double call succeeds (no "already exists" throw)
 *  AC 3: branch absent locally → created from origin and write lands
 *  AC 4: local branch behind origin → fast-forwarded (no data loss)
 *  AC 6: local branch has commits origin lacks → NOT clobbered; local-only
 *        commit remains reachable after ensureOnBranch
 *
 * Pattern mirrors cortex-writer-push.integration.test.ts:
 *  - `file://` bare repo + clone under a tmp THINK_HOME
 *  - GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL set in env so git commit works
 *  - THINK_HOME restored in afterEach
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import {
  ensureRepoCloned,
  createOrphanBranch,
  localBranchExists,
  ensureOnBranch,
  ensureBranchCheckedOut,
  getCurrentBranch,
} from '../../src/lib/git.js';
import { saveConfig, getConfig } from '../../src/lib/config.js';
import { closeAllCortexDbs } from '../../src/db/engrams.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  thinkHome: string;
  bareRepo: string;
  bareRepoUrl: string;
  cleanup: () => void;
}

function setupHarness(): Harness {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'agt-437-branch-prep-'));
  const thinkHome = join(tmpRoot, 'think-home');
  const bareRepo = join(tmpRoot, 'origin.git');
  mkdirSync(thinkHome, { recursive: true });
  mkdirSync(bareRepo, { recursive: true });

  execFileSync('git', ['init', '--bare', '--initial-branch=main', bareRepo], {
    stdio: 'pipe',
  });

  // Seed the bare repo with a main branch so clone --no-checkout has a HEAD.
  const seed = join(tmpRoot, 'seed');
  mkdirSync(seed);
  execFileSync('git', ['init', '--initial-branch=main', seed], { stdio: 'pipe' });
  execFileSync('git', ['-C', seed, 'config', 'user.email', 'agt-437@test.local'], { stdio: 'pipe' });
  execFileSync('git', ['-C', seed, 'config', 'user.name', 'agt-437'], { stdio: 'pipe' });
  execFileSync('git', ['-C', seed, 'commit', '--allow-empty', '-m', 'init: main'], { stdio: 'pipe' });
  execFileSync('git', ['-C', seed, 'push', `file://${bareRepo}`, 'main'], { stdio: 'pipe' });

  return {
    thinkHome,
    bareRepo,
    bareRepoUrl: `file://${bareRepo}`,
    cleanup: () => {
      closeAllCortexDbs();
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('ensureOnBranch / localBranchExists — idempotent branch prep (AGT-437)', () => {
  let harness: Harness;
  let originalHome: string | undefined;
  let originalAuthorName: string | undefined;
  let originalAuthorEmail: string | undefined;
  let originalCommitterName: string | undefined;
  let originalCommitterEmail: string | undefined;

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    originalAuthorName = process.env.GIT_AUTHOR_NAME;
    originalAuthorEmail = process.env.GIT_AUTHOR_EMAIL;
    originalCommitterName = process.env.GIT_COMMITTER_NAME;
    originalCommitterEmail = process.env.GIT_COMMITTER_EMAIL;

    process.env.THINK_TEST_ALLOW_FILE_URL = '1';
    harness = setupHarness();
    process.env.THINK_HOME = harness.thinkHome;
    process.env.GIT_AUTHOR_NAME = 'agt-437';
    process.env.GIT_AUTHOR_EMAIL = 'agt-437@test.local';
    process.env.GIT_COMMITTER_NAME = 'agt-437';
    process.env.GIT_COMMITTER_EMAIL = 'agt-437@test.local';

    saveConfig({
      ...getConfig(),
      cortex: { repo: harness.bareRepoUrl, author: 'agt-437' },
    });

    ensureRepoCloned();
  });

  afterEach(() => {
    harness.cleanup();
    delete process.env.THINK_TEST_ALLOW_FILE_URL;
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    if (originalAuthorName === undefined) delete process.env.GIT_AUTHOR_NAME;
    else process.env.GIT_AUTHOR_NAME = originalAuthorName;
    if (originalAuthorEmail === undefined) delete process.env.GIT_AUTHOR_EMAIL;
    else process.env.GIT_AUTHOR_EMAIL = originalAuthorEmail;
    if (originalCommitterName === undefined) delete process.env.GIT_COMMITTER_NAME;
    else process.env.GIT_COMMITTER_NAME = originalCommitterName;
    if (originalCommitterEmail === undefined) delete process.env.GIT_COMMITTER_EMAIL;
    else process.env.GIT_COMMITTER_EMAIL = originalCommitterEmail;
  });

  // -------------------------------------------------------------------------
  // AC 1: first-shot success when local branch already exists
  // -------------------------------------------------------------------------
  it('AC 1: ensureOnBranch succeeds on first call when branch already exists locally', () => {
    createOrphanBranch('testcortex');
    // branch now exists both locally and on origin; we are on it.

    // Switch away to simulate the hazard (tree on a different branch).
    const repoPath = join(harness.thinkHome, 'repo');
    execFileSync('git', ['-C', repoPath, 'switch', '--', 'main'], { stdio: 'pipe' });
    expect(getCurrentBranch()).toBe('main');
    expect(localBranchExists('testcortex')).toBe(true);

    // This must NOT throw "a branch named 'testcortex' already exists".
    expect(() => ensureOnBranch('testcortex')).not.toThrow();
    expect(getCurrentBranch()).toBe('testcortex');
  });

  // -------------------------------------------------------------------------
  // AC 2: double call in same session — second call must not fail
  // -------------------------------------------------------------------------
  it('AC 2: calling ensureOnBranch twice in a row succeeds (idempotent)', () => {
    createOrphanBranch('testcortex');

    const repoPath = join(harness.thinkHome, 'repo');
    // Switch away, then call twice.
    execFileSync('git', ['-C', repoPath, 'switch', '--', 'main'], { stdio: 'pipe' });

    expect(() => ensureOnBranch('testcortex')).not.toThrow();
    expect(getCurrentBranch()).toBe('testcortex');

    // Second call — must not throw even though we are already on the branch
    // and `localBranchExists` returns true.
    expect(() => ensureOnBranch('testcortex')).not.toThrow();
    expect(getCurrentBranch()).toBe('testcortex');
  });

  // -------------------------------------------------------------------------
  // AC 2 (variant): ensureBranchCheckedOut delegates to ensureOnBranch — same
  // -------------------------------------------------------------------------
  it('AC 2b: ensureBranchCheckedOut is non-throwing when branch exists', () => {
    createOrphanBranch('testcortex');
    const repoPath = join(harness.thinkHome, 'repo');
    execFileSync('git', ['-C', repoPath, 'switch', '--', 'main'], { stdio: 'pipe' });

    // Reproduce the old bug: assert that the raw `switch -c` on an existing
    // branch DOES throw, which documents the regression target.
    expect(() =>
      execFileSync(
        'git',
        ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=', 'switch', '-c', 'testcortex', '--', 'origin/testcortex'],
        { cwd: repoPath, stdio: 'pipe' },
      ),
    ).toThrow();

    // The helper should NOT throw even though the local branch exists.
    expect(() => ensureBranchCheckedOut('testcortex')).not.toThrow();
    expect(getCurrentBranch()).toBe('testcortex');
  });

  // -------------------------------------------------------------------------
  // AC 3: branch absent locally — must be created from origin
  // -------------------------------------------------------------------------
  it('AC 3: ensureOnBranch creates local branch when absent (only on origin)', () => {
    createOrphanBranch('testcortex');
    const repoPath = join(harness.thinkHome, 'repo');

    // Delete the local ref (branch exists on origin but not locally anymore).
    execFileSync('git', ['-C', repoPath, 'switch', '--', 'main'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repoPath, 'branch', '-D', 'testcortex'], { stdio: 'pipe' });
    expect(localBranchExists('testcortex')).toBe(false);

    // Fetch so the remote ref is visible.
    execFileSync('git', ['-C', repoPath, 'fetch', 'origin', '--', 'testcortex'], { stdio: 'pipe' });

    expect(() => ensureOnBranch('testcortex')).not.toThrow();
    expect(getCurrentBranch()).toBe('testcortex');
    expect(localBranchExists('testcortex')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // AC 4: local branch behind origin — must be fast-forwarded
  // -------------------------------------------------------------------------
  it('AC 4: ensureOnBranch fast-forwards a local branch that is behind origin', () => {
    createOrphanBranch('testcortex');
    const repoPath = join(harness.thinkHome, 'repo');

    // Simulate a second writer advancing origin: make a second clone, commit,
    // push, then fetch back into the primary clone so origin/testcortex is ahead.
    const tmpRoot2 = mkdtempSync(join(tmpdir(), 'agt-437-clone2-'));
    try {
      execFileSync('git', ['clone', `file://${harness.bareRepo}`, tmpRoot2], { stdio: 'pipe' });
      execFileSync('git', ['-C', tmpRoot2, 'config', 'user.email', 'clone2@test.local'], { stdio: 'pipe' });
      execFileSync('git', ['-C', tmpRoot2, 'config', 'user.name', 'clone2'], { stdio: 'pipe' });
      execFileSync('git', ['-C', tmpRoot2, 'checkout', 'testcortex'], { stdio: 'pipe' });
      execFileSync('git', ['-C', tmpRoot2, 'commit', '--allow-empty', '-m', 'advance: origin from clone2'], { stdio: 'pipe' });
      execFileSync('git', ['-C', tmpRoot2, 'push', 'origin', 'testcortex'], { stdio: 'pipe' });
    } finally {
      rmSync(tmpRoot2, { recursive: true, force: true });
    }

    // Now origin/testcortex is 1 commit ahead of local testcortex.
    // Fetch so the local remote-tracking ref is updated.
    execFileSync('git', ['-C', repoPath, 'fetch', 'origin', 'testcortex'], { stdio: 'pipe' });

    // Switch away so ensureOnBranch has to switch back.
    execFileSync('git', ['-C', repoPath, 'switch', '--', 'main'], { stdio: 'pipe' });

    const originTip = execFileSync('git', ['-C', repoPath, 'rev-parse', 'origin/testcortex'], { encoding: 'utf-8' }).trim();
    const localTipBefore = execFileSync('git', ['-C', repoPath, 'rev-parse', 'testcortex'], { encoding: 'utf-8' }).trim();
    expect(localTipBefore).not.toBe(originTip); // sanity: behind

    expect(() => ensureOnBranch('testcortex')).not.toThrow();
    expect(getCurrentBranch()).toBe('testcortex');

    // After ensureOnBranch the local ref should have been fast-forwarded.
    const localTipAfter = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
    expect(localTipAfter).toBe(originTip);
  });

  // -------------------------------------------------------------------------
  // AC 6: local branch has commits origin lacks — ff-only refuses, local
  //        commit remains reachable (no data loss)
  // -------------------------------------------------------------------------
  it('AC 6: ensureOnBranch does not clobber local-only commits on a diverged branch', () => {
    createOrphanBranch('testcortex');
    const repoPath = join(harness.thinkHome, 'repo');

    // Advance origin independently (without pushing from primary).
    const tmpRoot2 = mkdtempSync(join(tmpdir(), 'agt-437-clone2-div-'));
    try {
      execFileSync('git', ['clone', `file://${harness.bareRepo}`, tmpRoot2], { stdio: 'pipe' });
      execFileSync('git', ['-C', tmpRoot2, 'config', 'user.email', 'clone2@test.local'], { stdio: 'pipe' });
      execFileSync('git', ['-C', tmpRoot2, 'config', 'user.name', 'clone2'], { stdio: 'pipe' });
      execFileSync('git', ['-C', tmpRoot2, 'checkout', 'testcortex'], { stdio: 'pipe' });
      execFileSync('git', ['-C', tmpRoot2, 'commit', '--allow-empty', '-m', 'origin: advance independently'], { stdio: 'pipe' });
      execFileSync('git', ['-C', tmpRoot2, 'push', 'origin', 'testcortex'], { stdio: 'pipe' });
    } finally {
      rmSync(tmpRoot2, { recursive: true, force: true });
    }

    // Create a local-only commit on primary (divergence).
    execFileSync('git', ['-C', repoPath, 'checkout', 'testcortex'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repoPath, 'commit', '--allow-empty', '-m', 'local: only commit'], { stdio: 'pipe' });
    const localOnlySha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();

    // Fetch to make origin/testcortex visible and ahead.
    execFileSync('git', ['-C', repoPath, 'fetch', 'origin', 'testcortex'], { stdio: 'pipe' });

    // Switch away before calling ensureOnBranch.
    execFileSync('git', ['-C', repoPath, 'switch', '--', 'main'], { stdio: 'pipe' });

    // ensureOnBranch must NOT throw and must NOT discard the local commit.
    expect(() => ensureOnBranch('testcortex')).not.toThrow();
    expect(getCurrentBranch()).toBe('testcortex');

    // The local-only SHA must still be reachable — not clobbered by ff-only.
    const allReachable = execFileSync(
      'git',
      ['-C', repoPath, 'rev-list', 'HEAD'],
      { encoding: 'utf-8' },
    ).trim().split('\n');
    expect(allReachable).toContain(localOnlySha);
  });

  // -------------------------------------------------------------------------
  // #69: a dirty tracked engram left on cortex-B must NOT wedge a switch to
  //      cortex-A. ensureOnBranch self-heals by salvaging the dirt onto B
  //      (no data loss) so the switch starts from a clean tree.
  // -------------------------------------------------------------------------
  it('#69: ensureOnBranch self-heals a dirty worktree instead of wedging the switch', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const repoPath = join(harness.thinkHome, 'repo');

    createOrphanBranch('cortexa');
    createOrphanBranch('cortexb');
    // We are now on cortexb (last created). Dirty a TRACKED engram on it — this
    // is the exact state a crashed cycle leaves: an uncommitted append.
    expect(getCurrentBranch()).toBe('cortexb');
    const pagePath = join(repoPath, 'cortexb', '000001.jsonl');
    fs.appendFileSync(pagePath, '{"id":"uncommitted-leftover"}\n', 'utf-8');

    // Sanity: a raw `git switch` to cortexa would refuse on this dirty tree.
    expect(() =>
      execFileSync(
        'git',
        ['-c', 'core.hooksPath=/dev/null', 'switch', '--', 'cortexa'],
        { cwd: repoPath, stdio: 'pipe' },
      ),
    ).toThrow();

    // ensureOnBranch must self-heal and switch cleanly — no wedge.
    expect(() => ensureOnBranch('cortexa')).not.toThrow();
    expect(getCurrentBranch()).toBe('cortexa');

    // The leftover line must be preserved on cortexb (committed, not discarded).
    execFileSync('git', ['-C', repoPath, 'switch', '--', 'cortexb'], { stdio: 'pipe' });
    const contents = fs.readFileSync(pagePath, 'utf-8');
    expect(contents).toContain('uncommitted-leftover');
    // ...and the tree is clean (the salvage committed it).
    const status = execFileSync('git', ['-C', repoPath, 'status', '--porcelain'], {
      encoding: 'utf-8',
    }).trim();
    expect(status).toBe('');
  });

  // -------------------------------------------------------------------------
  // localBranchExists: basic contract
  // -------------------------------------------------------------------------
  it('localBranchExists returns false for an absent branch and true after creation', () => {
    expect(localBranchExists('nonexistent-cortex-agt437')).toBe(false);
    createOrphanBranch('testcortex2');
    expect(localBranchExists('testcortex2')).toBe(true);
  });
});
