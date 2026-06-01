/**
 * AGT-399 — end-to-end push verification for the proxy cortex-writer.
 *
 * Pins the operator wiring path: a `think cortex setup <bare-repo-url>` +
 * `think cortex create engineering` setup is enough for `writeMemoriesForEvent`
 * to land memories on the *remote* — no extra config-field plumbing or boot
 * step is required.
 *
 * The test wires up the same primitives a real `think serve` does on boot
 * (config, repo clone, orphan branch) against a `file://` bare repo standing
 * in for HiveDB, then calls `writeMemoriesForEvent` and waits for the
 * (per-test, short-window) push-debouncer to push.
 *
 * Why the inline `PushDebouncer`: the module-level singleton uses a 500ms
 * window and runs git via `execFile`, which is fine in production but
 * sluggish + noisy under tests. We construct a private debouncer with a
 * 50ms window and hand it to `writeMemoriesForEvent` via the `notifyPush`
 * seam; everything else (the JSONL append, the cortex-name → branch
 * mapping, the `git add/commit/push` shape) is the production path.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { writeMemoriesForEvent } from '../../src/serve/cortex-writer.js';
import { PushDebouncer } from '../../src/daemon/push-debouncer.js';
import {
  ensureRepoCloned,
  createOrphanBranch,
} from '../../src/lib/git.js';
import { saveConfig, getConfig } from '../../src/lib/config.js';
import { closeAllCortexDbs } from '../../src/db/engrams.js';
import { appendLinesViaPlumbing } from '../../src/lib/git-plumbing.js';
import { L1_PAGE_SIZE } from '../../src/lib/l1-page.js';

const TEST_DEBOUNCE_MS = 50;
const CORTEX = 'engineering-test';
const PROXY_PEER_ID = 'proxy-agt-399-test';

interface Harness {
  thinkHome: string;
  bareRepo: string;
  bareRepoUrl: string;
  cleanup: () => void;
}

function setupHarness(): Harness {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'agt-399-push-'));
  const thinkHome = join(tmpRoot, 'think-home');
  const bareRepo = join(tmpRoot, 'hivedb.git');
  mkdirSync(thinkHome, { recursive: true });
  mkdirSync(bareRepo, { recursive: true });

  execFileSync('git', ['init', '--bare', '--initial-branch=main', bareRepo], { stdio: 'pipe' });

  // Seed the bare repo with a main branch so clone --no-checkout has a HEAD.
  // `ensureRepoCloned` (called below) does `git clone --no-checkout` and needs
  // something on the other side; an empty bare repo would leave the local
  // clone in a broken "no commits yet" state that the push-debouncer's
  // `git add` then can't recover from cleanly.
  const seed = join(tmpRoot, 'seed');
  mkdirSync(seed);
  execFileSync('git', ['init', '--initial-branch=main', seed], { stdio: 'pipe' });
  execFileSync('git', ['-C', seed, 'config', 'user.email', 'agt-399@example.com'], { stdio: 'pipe' });
  execFileSync('git', ['-C', seed, 'config', 'user.name', 'agt-399'], { stdio: 'pipe' });
  execFileSync('git', ['-C', seed, 'commit', '--allow-empty', '-m', 'init'], { stdio: 'pipe' });
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

describe('writeMemoriesForEvent — end-to-end push to a bare remote (AGT-399)', () => {
  let harness: Harness;
  let originalHome: string | undefined;
  let originalAuthorName: string | undefined;
  let originalAuthorEmail: string | undefined;
  let originalCommitterName: string | undefined;
  let originalCommitterEmail: string | undefined;

  beforeAll(() => {
    process.env.THINK_TEST_ALLOW_FILE_URL = '1';
  });

  afterAll(() => {
    delete process.env.THINK_TEST_ALLOW_FILE_URL;
  });

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    originalAuthorName = process.env.GIT_AUTHOR_NAME;
    originalAuthorEmail = process.env.GIT_AUTHOR_EMAIL;
    originalCommitterName = process.env.GIT_COMMITTER_NAME;
    originalCommitterEmail = process.env.GIT_COMMITTER_EMAIL;

    harness = setupHarness();
    process.env.THINK_HOME = harness.thinkHome;
    // The push-debouncer commits via `git commit -m ...` and needs an
    // author/committer identity in the environment because we strip
    // GIT_CONFIG_GLOBAL/SYSTEM in safeGitEnv (no ~/.gitconfig fallback).
    process.env.GIT_AUTHOR_NAME = 'agt-399';
    process.env.GIT_AUTHOR_EMAIL = 'agt-399@example.com';
    process.env.GIT_COMMITTER_NAME = 'agt-399';
    process.env.GIT_COMMITTER_EMAIL = 'agt-399@example.com';

    // Mirror `think cortex setup <repo-url>` — write the git backend config.
    saveConfig({
      ...getConfig(),
      cortex: { repo: harness.bareRepoUrl, author: 'agt-399' },
    });
  });

  afterEach(() => {
    harness.cleanup();
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

  it('lands a proxy-written memory on the bare remote after cortex create + writeMemoriesForEvent', async () => {
    // --- Step 1: mirror `think cortex setup` + `think cortex create <name>` ---
    // setupHarness already saved the config. ensureRepoCloned + createOrphanBranch
    // is exactly what `think cortex setup` (clone) and `think cortex create`
    // (create + push) do on the host today.
    ensureRepoCloned();
    createOrphanBranch(CORTEX);

    expect(existsSync(join(harness.thinkHome, 'repo', '.git'))).toBe(true);

    // --- Step 2: stand up a private push-debouncer with a short window ---
    // Production uses the 500ms module-level singleton; here we want a fast
    // debounce so the test completes quickly. The push semantics (the
    // git add/commit/push triple) are identical.
    const dbn = new PushDebouncer(TEST_DEBOUNCE_MS);

    // --- Step 3: fire writeMemoriesForEvent as the proxy curator would ---
    writeMemoriesForEvent({
      event: { id: 'test-event-1', episodeKey: 'test:smoke#1' },
      memories: [
        { content: 'smoke test memory — AGT-399', topics: ['smoke', 'agt-399'] },
      ],
      cortexName: CORTEX,
      peerId: PROXY_PEER_ID,
      notifyPush: (cortex) => dbn.notify(cortex),
    });

    // --- Step 4: wait for the debouncer to fire + push to complete ---
    // The debouncer kicks off git work via setImmediate after the
    // 50ms timer. Poll the bare repo for the auto: commit landing.
    await waitForAutoCommit(harness.bareRepo, CORTEX, 5000);

    // --- Step 5: assert the bare repo has the commit and the JSONL line ---
    const log = execFileSync('git', ['-C', harness.bareRepo, 'log', '--oneline', CORTEX], {
      encoding: 'utf-8',
    });
    // Expect at least two commits: the orphan "init: create cortex" and the
    // "auto: 1 entry via daemon" from the push-debouncer.
    const lines = log.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.some(l => /auto:\s+1 entry via daemon/.test(l))).toBe(true);

    // The JSONL line lives at `<cortex>/000001.jsonl` (subdirectory layout
    // matching the daemon sync-handler — see sync-handler.ts:337 and
    // l1-page.ts).
    const jsonl = execFileSync(
      'git',
      ['-C', harness.bareRepo, 'show', `${CORTEX}:${CORTEX}/000001.jsonl`],
      { encoding: 'utf-8' },
    );
    const memoryLines = jsonl.trim().split('\n').filter(Boolean);
    expect(memoryLines).toHaveLength(1);
    const memory = JSON.parse(memoryLines[0]);
    expect(memory.content).toBe('smoke test memory — AGT-399');
    expect(memory.episode_key).toBe('test:smoke#1');
    expect(memory.source_ids).toEqual(['test-event-1']);
    expect(memory.author).toBe('proxy');
    expect(memory.origin_peer_id).toBe(PROXY_PEER_ID);
    expect(memory.topics).toEqual(['smoke', 'agt-399']);
  });

  it('AGT-458/#70: writes cortexB while parked on cortexA — lands on cortexB with NO branch switch', async () => {
    // The headline #70 Option B guarantee at the proxy layer: a write to
    // cortexB while the shared worktree is parked on cortexA lands on cortexB
    // via git plumbing (hash-object/commit-tree/update-ref) WITHOUT ever
    // running `git switch`. The worktree stays on cortexA throughout.
    ensureRepoCloned();

    const cortexA = 'team-alpha';
    const cortexB = 'team-beta';
    createOrphanBranch(cortexA);
    createOrphanBranch(cortexB);

    const repoPath = join(harness.thinkHome, 'repo');
    // Park the worktree on cortexA (createOrphanBranch left it on cortexB).
    execFileSync('git', ['-C', repoPath, 'switch', '--', cortexA], { stdio: 'pipe' });
    const headBefore = execFileSync(
      'git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8' },
    ).trim();
    expect(headBefore).toBe(cortexA);

    const dbn = new PushDebouncer(TEST_DEBOUNCE_MS);

    // Write for cortexB while the tree is on cortexA — real outbox + plumbing
    // drain (no appendFn test seam).
    writeMemoriesForEvent({
      event: { id: 'cross-branch-1', episodeKey: 'test:cross#1' },
      memories: [{ content: 'cross-branch write — must land on team-beta', topics: ['x'] }],
      cortexName: cortexB,
      peerId: PROXY_PEER_ID,
      notifyPush: (cortex) => dbn.notify(cortex),
    });

    await waitForAutoCommit(harness.bareRepo, cortexB, 5000);

    // The memory must be on cortexB's branch on the remote...
    const jsonlB = execFileSync(
      'git',
      ['-C', harness.bareRepo, 'show', `${cortexB}:${cortexB}/000001.jsonl`],
      { encoding: 'utf-8' },
    );
    expect(jsonlB).toContain('cross-branch write — must land on team-beta');

    // ...the worktree was NEVER switched (still on cortexA)...
    const headAfter = execFileSync(
      'git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8' },
    ).trim();
    expect(headAfter).toBe(cortexA);

    // ...and cortexA must NOT have grown a team-beta subdir (the legacy bug
    // would have committed `team-beta/000001.jsonl` onto cortexA's tree).
    let aTree = '';
    try {
      aTree = execFileSync('git', ['-C', harness.bareRepo, 'ls-tree', '-r', '--name-only', cortexA], {
        encoding: 'utf-8',
      });
    } catch { /* cortexA may have no remote commits beyond init — fine */ }
    expect(aTree).not.toContain(`${cortexB}/`);
  });

  it('#69/#70: a dirty worktree on another cortex never wedges a plumbing write (no switch occurs)', async () => {
    // #69 was a class of bug rooted in the shared-worktree `git switch`: a
    // prior cycle left the tree dirty on cortexB, so a subsequent write to
    // cortexA had to `git switch` B→A, which a raw switch refuses ("local
    // changes would be overwritten by checkout"), wedging EVERY cortex's push.
    // #70 Option B (AGT-458) removes the switch entirely — the plumbing write
    // path appends to cortexA's branch ref without touching the worktree, so a
    // dirty worktree parked on cortexB is structurally incapable of wedging
    // cortexA's write. This test pins that invariant: cortexA lands even with
    // cortexB's tree dirty, and the leftover is left exactly where it was
    // (plumbing has no reason to salvage it).
    const fs = require('node:fs') as typeof import('node:fs');
    ensureRepoCloned();

    const cortexA = 'wedge-alpha';
    const cortexB = 'wedge-beta';
    createOrphanBranch(cortexA);
    createOrphanBranch(cortexB);
    // Tree is now on cortexB. Dirty its tracked engram — the exact state a
    // crashed/aborted cycle leaves behind.
    const repoPath = join(harness.thinkHome, 'repo');
    const headBefore = execFileSync(
      'git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8' },
    ).trim();
    expect(headBefore).toBe(cortexB);
    const leftover = '{"id":"wedge-leftover","content":"uncommitted from a crashed cycle"}';
    fs.appendFileSync(join(repoPath, cortexB, '000001.jsonl'), leftover + '\n', 'utf-8');

    const dbn = new PushDebouncer(TEST_DEBOUNCE_MS);

    // Write for cortexA while the tree sits dirty on cortexB.
    writeMemoriesForEvent({
      event: { id: 'wedge-1', episodeKey: 'test:wedge#1' },
      memories: [{ content: 'must land despite the dirty cortexB tree', topics: ['x'] }],
      cortexName: cortexA,
      peerId: PROXY_PEER_ID,
      notifyPush: (cortex) => dbn.notify(cortex),
    });

    // The plumbing write lands on cortexA without any switch.
    await waitForAutoCommit(harness.bareRepo, cortexA, 5000);

    const jsonlA = execFileSync(
      'git',
      ['-C', harness.bareRepo, 'show', `${cortexA}:${cortexA}/000001.jsonl`],
      { encoding: 'utf-8' },
    );
    expect(jsonlA).toContain('must land despite the dirty cortexB tree');

    // The worktree was never switched — HEAD is still on cortexB — and the
    // leftover is still uncommitted on disk (plumbing didn't touch the tree).
    const headAfter = execFileSync(
      'git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8' },
    ).trim();
    expect(headAfter).toBe(cortexB);
    const localB = fs.readFileSync(join(repoPath, cortexB, '000001.jsonl'), 'utf-8');
    expect(localB).toContain('wedge-leftover');
  });
});

/**
 * Poll the bare repo until an `auto:` commit appears on `<cortex>`. Times
 * out with a descriptive error if the push never lands — far easier to
 * debug than a bare timeout in `waitFor`.
 */
async function waitForAutoCommit(bareRepo: string, cortex: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const log = execFileSync('git', ['-C', bareRepo, 'log', '--oneline', cortex], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (/auto:\s+\d+\s+(?:entry|entries)/.test(log)) return;
    } catch {
      // Branch may not exist yet; keep polling.
    }
    await new Promise(r => setTimeout(r, 25));
  }
  // One last fetch for the error message
  let lastLog = '(no log available)';
  try {
    lastLog = execFileSync('git', ['-C', bareRepo, 'log', '--all', '--oneline'], { encoding: 'utf-8' });
  } catch { /* best effort */ }
  throw new Error(
    `Timed out waiting ${timeoutMs}ms for auto-commit on '${cortex}' in ${bareRepo}.\n` +
      `Last log across all branches:\n${lastLog}`,
  );
}

// ---------------------------------------------------------------------------
// Lib-level plumbing unit tests (AGT-458). Co-located in this real-git file
// (rather than a separate heavy test file) so the fork pool doesn't have to
// spin up an additional worker for a second real-git suite — that extra
// worker-startup pressure flaked the merge gate under load.
// ---------------------------------------------------------------------------

/** Real async git runner mirroring the push-debouncer's runGitAsync shape. */
async function plumbRealGit(
  args: string[],
  cwd: string,
  opts?: { stdin?: string; env?: NodeJS.ProcessEnv },
): Promise<string> {
  const { execFile } = require('node:child_process') as typeof import('node:child_process');
  return new Promise((resolve, reject) => {
    const env = opts?.env ? { ...process.env, ...opts.env } : process.env;
    const child = execFile('git', args, { cwd, encoding: 'utf-8', env }, (err, stdout, stderr) => {
      if (err) reject(new Error((err.message ?? '') + (stderr ? `\n${stderr}` : '')));
      else resolve((stdout ?? '').trim());
    });
    if (opts?.stdin !== undefined) child.stdin?.end(opts.stdin);
  });
}

describe('appendLinesViaPlumbing — lib-level (AGT-458 / #70 Option B)', () => {
  let plumbRoot: string;
  let plumbRepo: string;
  let savedGitEnv: Record<string, string | undefined> = {};

  const pgit = (args: string[]): string =>
    execFileSync('git', args, { cwd: plumbRepo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

  /** Orphan cortex branch with `.gitattributes` + an empty page 1. */
  const createCortex = (branch: string): void => {
    const fs = require('node:fs') as typeof import('node:fs');
    pgit(['checkout', '--orphan', branch]);
    try { pgit(['rm', '-rf', '.']); } catch { /* empty */ }
    mkdirSync(join(plumbRepo, branch), { recursive: true });
    fs.writeFileSync(join(plumbRepo, branch, '000001.jsonl'), '', 'utf-8');
    fs.writeFileSync(join(plumbRepo, '.gitattributes'), '*.jsonl merge=union\n', 'utf-8');
    pgit(['add', '--', `${branch}/000001.jsonl`, '.gitattributes']);
    pgit(['commit', '-m', `init: create cortex ${branch}`]);
  };

  beforeEach(() => {
    const fs = require('node:fs') as typeof import('node:fs');
    for (const k of ['GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME']) {
      savedGitEnv[k] = process.env[k];
      process.env[k] = 'agt-458';
    }
    for (const k of ['GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL']) {
      savedGitEnv[k] = process.env[k];
      process.env[k] = 'agt-458@example.com';
    }
    plumbRoot = mkdtempSync(join(tmpdir(), 'agt-458-plumbing-'));
    plumbRepo = join(plumbRoot, 'repo');
    mkdirSync(plumbRepo, { recursive: true });
    execFileSync('git', ['init', '--initial-branch=main', plumbRepo], { stdio: 'pipe' });
    fs.writeFileSync(join(plumbRepo, 'README'), 'seed\n', 'utf-8');
    pgit(['add', '-A']);
    pgit(['commit', '-m', 'seed']);
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedGitEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    savedGitEnv = {};
    rmSync(plumbRoot, { recursive: true, force: true });
  });

  it('appends to cortexB while the worktree is parked on cortexA — no switch', async () => {
    createCortex('cortex-a');
    createCortex('cortex-b');
    pgit(['switch', '--', 'cortex-a']);
    expect(pgit(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('cortex-a');

    const line = JSON.stringify({ id: 'x1', content: 'lands on cortex-b' });
    const { commit, stagedPath, parent } = await appendLinesViaPlumbing(
      plumbRealGit, plumbRepo, 'cortex-b', [line], 'auto: 1 entry via daemon', { fetchFirst: false },
    );

    expect(stagedPath).toBe('cortex-b/000001.jsonl');
    expect(parent).not.toBeNull();
    expect(pgit(['rev-parse', 'refs/heads/cortex-b'])).toBe(commit);
    expect(pgit(['cat-file', '-p', 'cortex-b:cortex-b/000001.jsonl'])).toContain('lands on cortex-b');
    const tree = pgit(['ls-tree', '--name-only', 'cortex-b']);
    expect(tree).toContain('.gitattributes');
    expect(tree).toContain('cortex-b');
    // The worktree was NEVER switched — still on cortex-a, still clean.
    expect(pgit(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('cortex-a');
    expect(pgit(['status', '--porcelain'])).toBe('');
  });

  it('appends to an unborn cortex branch (no local ref yet) — opens page 1 parentless', async () => {
    const line = JSON.stringify({ id: 'first', content: 'unborn branch write' });
    const { parent, stagedPath } = await appendLinesViaPlumbing(
      plumbRealGit, plumbRepo, 'fresh-cortex', [line], 'init', { fetchFirst: false },
    );
    expect(parent).toBeNull();
    expect(stagedPath).toBe('fresh-cortex/000001.jsonl');
    expect(pgit(['cat-file', '-p', 'fresh-cortex:fresh-cortex/000001.jsonl'])).toContain('unborn branch write');
  });

  it('rotates to a new page when the active page is full', async () => {
    createCortex('cortex-roll');
    pgit(['switch', '--', 'cortex-roll']);

    const fullPage = Array.from({ length: L1_PAGE_SIZE }, (_, i) =>
      JSON.stringify({ id: `f${i}`, content: `line ${i}` }),
    );
    await appendLinesViaPlumbing(plumbRealGit, plumbRepo, 'cortex-roll', fullPage, 'fill', { fetchFirst: false });

    const { stagedPath } = await appendLinesViaPlumbing(
      plumbRealGit, plumbRepo, 'cortex-roll', [JSON.stringify({ id: 'overflow', content: 'next page' })],
      'roll', { fetchFirst: false },
    );
    expect(stagedPath).toBe('cortex-roll/000002.jsonl');
    expect(pgit(['cat-file', '-p', 'cortex-roll:cortex-roll/000002.jsonl'])).toContain('next page');
    expect(
      pgit(['cat-file', '-p', 'cortex-roll:cortex-roll/000001.jsonl']).split('\n').filter((l) => l.length > 0),
    ).toHaveLength(L1_PAGE_SIZE);
  });

  it('two consecutive appends to the same page concatenate in order', async () => {
    createCortex('cortex-seq');
    pgit(['switch', '--', 'cortex-seq']);
    await appendLinesViaPlumbing(
      plumbRealGit, plumbRepo, 'cortex-seq', [JSON.stringify({ id: 'a', n: 1 })], 'first', { fetchFirst: false },
    );
    await appendLinesViaPlumbing(
      plumbRealGit, plumbRepo, 'cortex-seq', [JSON.stringify({ id: 'b', n: 2 })], 'second', { fetchFirst: false },
    );
    const lines = pgit(['cat-file', '-p', 'cortex-seq:cortex-seq/000001.jsonl'])
      .split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as { id: string });
    expect(lines.map((l) => l.id)).toEqual(['a', 'b']);
  });
});
