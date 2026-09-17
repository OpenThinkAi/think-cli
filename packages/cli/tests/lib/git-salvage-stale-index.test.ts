/**
 * AGT-1299 / think-cli#95 — `salvageDirtyWorktree` must not commit an index
 * that is only BEHIND a plumbing-advanced HEAD.
 *
 * The daemon's L1 writer (`lib/git-plumbing.ts`) advances `refs/heads/<cortex>`
 * with `commit-tree` + `update-ref` and never touches the index or worktree.
 * When that branch is the checked-out one, `git status` reports the daemon's
 * own appends inverted — modified pages look like staged deletions, and pages
 * the writer created look like staged file deletions. The legacy salvage
 * (`git add -u` + commit) committed that stale index as the new tree, reverting
 * real writes (~6,000 deleted lines in think-cli#95).
 *
 * Covers the ticket's ACs with REAL git in a temp repo, driving the REAL
 * plumbing writer (`appendLinesViaPlumbing`) rather than a hand-rolled
 * imitation of it:
 *   AC 1 + AC 2: stale-only state → no commit, HEAD's tree untouched, index and
 *                worktree brought to HEAD (`git status -s` empty afterwards).
 *   AC 3:        genuine uncommitted append → the salvage commit still happens
 *                and contains only that append.
 *   Mixed:       stale index AND a genuine append → the append survives, the
 *                stale entries are NOT committed as deletions.
 *
 * Harness mirrors git-branch-prep.test.ts: `file://` bare origin + clone under a
 * tmp THINK_HOME, restored in afterEach. Temp dirs only — nothing touches a real
 * cortex home.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { createOrphanBranch, ensureOnBranch, ensureRepoCloned, getCurrentBranch } from '../../src/lib/git.js';
import { appendLinesViaPlumbing, type GitRunner } from '../../src/lib/git-plumbing.js';
import { L1_PAGE_SIZE } from '../../src/lib/l1-page.js';
import { saveConfig, getConfig } from '../../src/lib/config.js';
import { closeAllCortexDbs } from '../../src/db/engrams.js';

const CORTEX = 'testcortex';
const PAGE1 = `${CORTEX}/000001.jsonl`;
const PAGE2 = `${CORTEX}/000002.jsonl`;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  thinkHome: string;
  repoPath: string;
  bareRepoUrl: string;
  cleanup: () => void;
}

function setupHarness(): Harness {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'agt-1299-salvage-'));
  const thinkHome = join(tmpRoot, 'think-home');
  const bareRepo = join(tmpRoot, 'origin.git');
  mkdirSync(thinkHome, { recursive: true });
  mkdirSync(bareRepo, { recursive: true });

  execFileSync('git', ['init', '--bare', '--initial-branch=main', bareRepo], { stdio: 'pipe' });

  // Seed the bare repo with a main branch so clone --no-checkout has a HEAD.
  const seed = join(tmpRoot, 'seed');
  mkdirSync(seed);
  execFileSync('git', ['init', '--initial-branch=main', seed], { stdio: 'pipe' });
  execFileSync('git', ['-C', seed, 'config', 'user.email', 'agt-1299@test.local'], { stdio: 'pipe' });
  execFileSync('git', ['-C', seed, 'config', 'user.name', 'agt-1299'], { stdio: 'pipe' });
  execFileSync('git', ['-C', seed, 'commit', '--allow-empty', '-m', 'init: main'], { stdio: 'pipe' });
  execFileSync('git', ['-C', seed, 'push', `file://${bareRepo}`, 'main'], { stdio: 'pipe' });

  return {
    thinkHome,
    repoPath: join(thinkHome, 'repo'),
    bareRepoUrl: `file://${bareRepo}`,
    cleanup: () => {
      closeAllCortexDbs();
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

/** Real async git runner for the plumbing writer (same hardening flags as lib/git.ts). */
const gitRunner: GitRunner = async (args, cwd, opts) =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=', ...args], {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    input: opts?.stdin,
    env: { ...process.env, ...(opts?.env ?? {}) },
  });

function git(repoPath: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf-8' }).trim();
}

function status(repoPath: string): string {
  return git(repoPath, 'status', '--porcelain');
}

function blob(repoPath: string, rev: string): string {
  return execFileSync('git', ['-C', repoPath, 'cat-file', 'blob', rev], { encoding: 'utf-8' });
}

function lines(count: number, tag: string): string[] {
  return Array.from({ length: count }, (_, i) => JSON.stringify({ id: `${tag}-${i}` }));
}

/**
 * Put the repo in the exact think-cli#95 state: the checked-out cortex branch
 * advanced twice by the real plumbing writer (one page modified, one page
 * created by rotation) with the index and worktree left at the pre-advance tree.
 */
async function advanceHeadViaPlumbing(repoPath: string): Promise<string> {
  // Fill page 1 so the next write rotates — that gives us BOTH shapes of the
  // bug: a modified page (staged as a partial deletion) and a brand-new page
  // (staged as a whole-file deletion).
  await appendLinesViaPlumbing(gitRunner, repoPath, CORTEX, lines(L1_PAGE_SIZE, 'daemon'), 'sync: daemon batch', { fetchFirst: false });
  await appendLinesViaPlumbing(gitRunner, repoPath, CORTEX, ['{"id":"daemon-rotated"}'], 'sync: daemon rotated', { fetchFirst: false });
  return git(repoPath, 'rev-parse', 'HEAD');
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('salvageDirtyWorktree — plumbing-stale index guard (AGT-1299)', () => {
  let harness: Harness;
  const saved: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'THINK_HOME',
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
  ];

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];

    process.env.THINK_TEST_ALLOW_FILE_URL = '1';
    harness = setupHarness();
    process.env.THINK_HOME = harness.thinkHome;
    process.env.GIT_AUTHOR_NAME = 'agt-1299';
    process.env.GIT_AUTHOR_EMAIL = 'agt-1299@test.local';
    process.env.GIT_COMMITTER_NAME = 'agt-1299';
    process.env.GIT_COMMITTER_EMAIL = 'agt-1299@test.local';

    saveConfig({ ...getConfig(), cortex: { repo: harness.bareRepoUrl, author: 'agt-1299' } });
    ensureRepoCloned();
    createOrphanBranch(CORTEX);
    expect(getCurrentBranch()).toBe(CORTEX);
  });

  afterEach(() => {
    harness.cleanup();
    delete process.env.THINK_TEST_ALLOW_FILE_URL;
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key] as string;
    }
  });

  // -------------------------------------------------------------------------
  // AC 1 + AC 2
  // -------------------------------------------------------------------------
  it('AC 1+2: a plumbing-advanced HEAD with a stale index creates no commit and leaves status clean', async () => {
    const { repoPath } = harness;
    const tip = await advanceHeadViaPlumbing(repoPath);
    const treeBefore = git(repoPath, 'rev-parse', 'HEAD^{tree}');

    // Regression target: this is the think-cli#95 state — the daemon's appends
    // showing up as staged deletions against a stale index.
    const staged = git(repoPath, 'diff', '--cached', '--name-status', 'HEAD');
    expect(staged).toContain(`M\t${PAGE1}`);
    expect(staged).toContain(`D\t${PAGE2}`);

    ensureOnBranch(CORTEX);

    // AC 1: no commit, HEAD's tree unchanged.
    expect(git(repoPath, 'rev-parse', 'HEAD')).toBe(tip);
    expect(git(repoPath, 'rev-parse', 'HEAD^{tree}')).toBe(treeBefore);

    // AC 2: index and worktree brought to HEAD.
    expect(status(repoPath)).toBe('');
    expect(readFileSync(join(repoPath, PAGE1), 'utf-8')).toBe(blob(repoPath, `HEAD:${PAGE1}`));
    expect(readFileSync(join(repoPath, PAGE2), 'utf-8')).toBe(blob(repoPath, `HEAD:${PAGE2}`));
    expect(readFileSync(join(repoPath, PAGE2), 'utf-8')).toContain('daemon-rotated');
  });

  // -------------------------------------------------------------------------
  // AC 3
  // -------------------------------------------------------------------------
  it('AC 3: a genuine uncommitted append is still salvaged, and the commit contains only that append', () => {
    const { repoPath } = harness;
    const tip = git(repoPath, 'rev-parse', 'HEAD');
    appendFileSync(join(repoPath, PAGE1), '{"id":"in-flight"}\n', 'utf-8');

    ensureOnBranch(CORTEX);

    const head = git(repoPath, 'rev-parse', 'HEAD');
    expect(head).not.toBe(tip);
    expect(git(repoPath, 'rev-parse', 'HEAD^')).toBe(tip); // exactly one commit
    expect(git(repoPath, 'log', '-1', '--format=%s')).toContain('salvage');

    // Only the append — one file, one insertion, zero deletions.
    expect(git(repoPath, 'diff', '--name-status', `${tip}..HEAD`)).toBe(`M\t${PAGE1}`);
    expect(git(repoPath, 'diff', '--numstat', `${tip}..HEAD`)).toBe(`1\t0\t${PAGE1}`);
    expect(blob(repoPath, `HEAD:${PAGE1}`)).toBe('{"id":"in-flight"}\n');
    expect(status(repoPath)).toBe('');
  });

  // -------------------------------------------------------------------------
  // Mixed: stale index AND a genuine append
  // -------------------------------------------------------------------------
  it('mixed: a genuine append on top of a stale index is committed WITHOUT the stale deletions', async () => {
    const { repoPath } = harness;
    const tip = await advanceHeadViaPlumbing(repoPath);

    // A direct (non-outbox) writer appends to the worktree page while the index
    // is still parked on the pre-advance tree.
    appendFileSync(join(repoPath, PAGE1), '{"id":"in-flight"}\n', 'utf-8');

    ensureOnBranch(CORTEX);

    const head = git(repoPath, 'rev-parse', 'HEAD');
    expect(head).not.toBe(tip);
    expect(git(repoPath, 'rev-parse', 'HEAD^')).toBe(tip); // exactly one commit, on the plumbing tip

    // The salvage commit is the append and nothing else: no deletions, and the
    // page the plumbing writer created is untouched.
    expect(git(repoPath, 'diff', '--name-status', `${tip}..HEAD`)).toBe(`M\t${PAGE1}`);
    expect(git(repoPath, 'diff', '--numstat', `${tip}..HEAD`)).toBe(`1\t0\t${PAGE1}`);

    // The daemon's writes AND the in-flight append both survive, in that order.
    const page1 = blob(repoPath, `HEAD:${PAGE1}`);
    expect(page1).toBe(blob(repoPath, `${tip}:${PAGE1}`) + '{"id":"in-flight"}\n');
    expect(page1.split('\n').filter(Boolean)).toHaveLength(L1_PAGE_SIZE + 1);
    expect(blob(repoPath, `HEAD:${PAGE2}`)).toContain('daemon-rotated');
    expect(status(repoPath)).toBe('');
  });

  // -------------------------------------------------------------------------
  // Fallback: a worktree change that is provably NOT an append cannot be merged
  // onto HEAD, so the legacy salvage path runs unchanged (commit, never
  // discard). Documented limitation — the daemon's writes stay reachable via
  // the parent commit and the union merge driver reconciles on push.
  // -------------------------------------------------------------------------
  it('falls back to the legacy salvage (never a discard) when the worktree change is not an append', async () => {
    const { repoPath } = harness;
    // Committed baseline so the index blob is non-empty (an empty blob is a
    // prefix of everything, which would make any change look like an append).
    appendFileSync(join(repoPath, PAGE1), '{"id":"baseline"}\n', 'utf-8');
    git(repoPath, 'add', '--', PAGE1);
    git(repoPath, 'commit', '-m', 'seed: baseline');

    await appendLinesViaPlumbing(gitRunner, repoPath, CORTEX, ['{"id":"daemon"}'], 'sync: daemon', { fetchFirst: false });
    const tip = git(repoPath, 'rev-parse', 'HEAD');

    // In-place rewrite, not an append.
    writeFileSync(join(repoPath, PAGE1), '{"id":"rewritten"}\n', 'utf-8');

    expect(() => ensureOnBranch(CORTEX)).not.toThrow();

    // Legacy behaviour: a commit was made and nothing was discarded — the
    // daemon's line remains reachable from the salvage commit's parent.
    expect(git(repoPath, 'rev-parse', 'HEAD')).not.toBe(tip);
    expect(blob(repoPath, `${tip}:${PAGE1}`)).toContain('daemon');
    expect(status(repoPath)).toBe('');
  });
});
