/**
 * AGT-1310 / think-cli#95 — `think doctor` must find, and safely undo, an
 * unpushed salvage commit that deleted whole L1 pages.
 *
 * AC3 is the point of this file: the broken state is built with REAL git in a
 * temp repo against a BARE origin, and the load-bearing assertion in every
 * repair test is the same one — **no entry id reachable before the fix is
 * absent from (origin ∪ l1_outbox) after it**. The reset discards local
 * commits, so that invariant is the only thing standing between this repair
 * and silent data loss.
 *
 * Harness mirrors tests/lib/git-salvage-stale-index.test.ts: `file://` bare
 * origin + clone under a tmp THINK_HOME, restored in afterEach. Temp dirs only
 * — nothing here opens a real cortex repo or a real think home.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import {
  createOrphanBranch,
  ensureRepoCloned,
  getCurrentBranch,
  salvageCommitSubject,
} from '../../src/lib/git.js';
import {
  findSalvagedCortexBranches,
  repairSalvagedCortexBranches,
} from '../../src/lib/salvage-repair.js';
import { checkSalvageCommits, SALVAGE_COMMIT_CHECK_ID } from '../../src/lib/doctor/salvage-commit.js';
import { saveConfig, getConfig } from '../../src/lib/config.js';
import { closeAllCortexDbs, getCortexDb, closeCortexDb } from '../../src/db/engrams.js';

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
  const tmpRoot = mkdtempSync(join(tmpdir(), 'agt-1310-salvage-repair-'));
  const thinkHome = join(tmpRoot, 'think-home');
  const bareRepo = join(tmpRoot, 'origin.git');
  mkdirSync(thinkHome, { recursive: true });
  mkdirSync(bareRepo, { recursive: true });

  execFileSync('git', ['init', '--bare', '--initial-branch=main', bareRepo], { stdio: 'pipe' });

  // Seed the bare repo with a main branch so `clone --no-checkout` has a HEAD.
  const seed = join(tmpRoot, 'seed');
  mkdirSync(seed);
  execFileSync('git', ['init', '--initial-branch=main', seed], { stdio: 'pipe' });
  execFileSync('git', ['-C', seed, 'config', 'user.email', 'agt-1310@test.local'], { stdio: 'pipe' });
  execFileSync('git', ['-C', seed, 'config', 'user.name', 'agt-1310'], { stdio: 'pipe' });
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

function git(repoPath: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf-8' }).trim();
}

/** One L1 line in the shape `lib/l1-entry.ts` writes. */
function entryLine(id: string, content: string): string {
  return JSON.stringify({
    id,
    ts: `2026-09-1${id.length % 9}T00:00:00.000Z`,
    author: 'agt-1310',
    origin_peer_id: 'peer-1310',
    kind: 'memory',
    content,
    topics: [],
    supersedes: [],
    compacted_from: null,
    decisions: [],
    source_ids: [],
    deleted_at: null,
  });
}

function writePage(repoPath: string, page: string, ids: string[]): void {
  writeFileSync(join(repoPath, page), ids.map((id) => entryLine(id, `content ${id}`)).join('\n') + '\n');
}

function appendEntry(repoPath: string, page: string, id: string): void {
  appendFileSync(join(repoPath, page), entryLine(id, `content ${id}`) + '\n');
}

/** Every entry id in every L1 page of `rev`'s tree. */
function idsAtRev(repoPath: string, rev: string): Set<string> {
  const ids = new Set<string>();
  const files = git(repoPath, 'ls-tree', '-r', '--name-only', rev).split('\n').filter(Boolean);
  for (const file of files) {
    if (!/\d{6}\.jsonl$/.test(file)) continue;
    const blob = execFileSync('git', ['-C', repoPath, 'show', `${rev}:${file}`], { encoding: 'utf-8' });
    for (const line of blob.split('\n')) {
      if (line !== '') ids.add(JSON.parse(line).id as string);
    }
  }
  return ids;
}

/** Entry ids currently queued in a cortex's `l1_outbox`. */
function outboxIds(cortex: string): string[] {
  const db = getCortexDb(cortex);
  try {
    return (db.prepare('SELECT entry_id FROM l1_outbox ORDER BY id ASC').all() as Array<{
      entry_id: string;
    }>).map((row) => row.entry_id);
  } finally {
    closeCortexDb(cortex);
  }
}

/**
 * The think-cli#95 state, built by hand because the code that produced it no
 * longer exists: AGT-1299's guard means `salvageDirtyWorktree` cannot make this
 * commit any more. What is left on affected machines is exactly this shape —
 * a commit carrying the #69 subject whose diff deletes a whole page.
 *
 *   origin/<cortex>:  page1 = [o1, o2], page2 = [o3]
 *   local, unpushed:  salvage commit (deletes page2, appends s1 to page1)
 *                     good commit    (appends g1 to page1)
 */
function buildBrokenState(repoPath: string): void {
  writePage(repoPath, PAGE1, ['o1', 'o2']);
  writePage(repoPath, PAGE2, ['o3']);
  git(repoPath, 'add', '--', PAGE1, PAGE2);
  git(repoPath, 'commit', '-m', 'sync: batch that reached origin');
  git(repoPath, 'push', 'origin', CORTEX);

  appendEntry(repoPath, PAGE1, 's1');
  git(repoPath, 'rm', '--quiet', '--', PAGE2);
  git(repoPath, 'add', '--', PAGE1);
  git(repoPath, 'commit', '-m', salvageCommitSubject(CORTEX));

  appendEntry(repoPath, PAGE1, 'g1');
  git(repoPath, 'add', '--', PAGE1);
  git(repoPath, 'commit', '-m', 'sync: batch written after the wedge');
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('salvage-commit detection and repair (AGT-1310)', () => {
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
    process.env.GIT_AUTHOR_NAME = 'agt-1310';
    process.env.GIT_AUTHOR_EMAIL = 'agt-1310@test.local';
    process.env.GIT_COMMITTER_NAME = 'agt-1310';
    process.env.GIT_COMMITTER_EMAIL = 'agt-1310@test.local';

    saveConfig({ ...getConfig(), cortex: { repo: harness.bareRepoUrl, author: 'agt-1310' } });
    ensureRepoCloned();
    createOrphanBranch(CORTEX);
    expect(getCurrentBranch()).toBe(CORTEX);
    // Materialise the cortex index DB so the sweep's default enumeration
    // (`listKnownCortexes()`) sees this cortex, exactly as it would in the wild.
    closeCortexDb(CORTEX);
    getCortexDb(CORTEX);
    closeCortexDb(CORTEX);
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
  // AC1 — detection
  // -------------------------------------------------------------------------

  it('AC1: the check fails, fixable, on an unpushed page-deleting salvage commit', () => {
    buildBrokenState(harness.repoPath);

    const findings = findSalvagedCortexBranches();
    expect(findings).toHaveLength(1);
    expect(findings[0].branch).toBe(CORTEX);
    expect(findings[0].hasUpstream).toBe(true);
    expect(findings[0].deletedPages).toEqual([PAGE2]);

    const result = checkSalvageCommits({ repoPath: harness.repoPath });
    expect(result.id).toBe(SALVAGE_COMMIT_CHECK_ID);
    expect(result.status).toBe('fail');
    expect(result.fixable).toBe(true);
    expect(result.detail).toContain(CORTEX);
    expect(result.detail).toContain('1 L1 page');
  });

  it('AC1: a salvage commit that deletes no page is left alone', () => {
    // AGT-1299's AC3 outcome: a salvage commit carrying a genuine in-flight
    // append is a legitimate commit. Subject matching alone must not condemn it.
    writePage(harness.repoPath, PAGE1, ['o1']);
    git(harness.repoPath, 'add', '--', PAGE1);
    git(harness.repoPath, 'commit', '-m', 'sync: batch that reached origin');
    git(harness.repoPath, 'push', 'origin', CORTEX);

    appendEntry(harness.repoPath, PAGE1, 'inflight');
    git(harness.repoPath, 'add', '--', PAGE1);
    git(harness.repoPath, 'commit', '-m', salvageCommitSubject(CORTEX));

    expect(findSalvagedCortexBranches()).toEqual([]);
    expect(checkSalvageCommits({ repoPath: harness.repoPath }).status).toBe('pass');
  });

  it('AC1: an ordinary unpushed commit that deletes a page is left alone', () => {
    writePage(harness.repoPath, PAGE1, ['o1']);
    writePage(harness.repoPath, PAGE2, ['o2']);
    git(harness.repoPath, 'add', '--', PAGE1, PAGE2);
    git(harness.repoPath, 'commit', '-m', 'sync: batch that reached origin');
    git(harness.repoPath, 'push', 'origin', CORTEX);

    git(harness.repoPath, 'rm', '--quiet', '--', PAGE2);
    git(harness.repoPath, 'commit', '-m', 'chore(cortex): compaction dropped a page');

    expect(findSalvagedCortexBranches()).toEqual([]);
  });

  it('passes on a clone whose branches are all pushed', () => {
    writePage(harness.repoPath, PAGE1, ['o1']);
    git(harness.repoPath, 'add', '--', PAGE1);
    git(harness.repoPath, 'commit', '-m', 'sync: batch that reached origin');
    git(harness.repoPath, 'push', 'origin', CORTEX);

    const result = checkSalvageCommits({ repoPath: harness.repoPath });
    expect(result.status).toBe('pass');
    expect(result.fixable).toBe(false);
  });

  // -------------------------------------------------------------------------
  // AC2 + AC3 — repair, and the no-loss invariant
  // -------------------------------------------------------------------------

  it('AC2+AC3: re-queues exactly the missing ids, resets to origin, and loses nothing', () => {
    const { repoPath } = harness;
    buildBrokenState(repoPath);

    // Everything reachable before the repair: local history plus origin.
    const before = new Set([
      ...idsAtRev(repoPath, CORTEX),
      ...idsAtRev(repoPath, `${CORTEX}^`),
      ...idsAtRev(repoPath, `origin/${CORTEX}`),
      ...outboxIds(CORTEX),
    ]);
    expect(before).toEqual(new Set(['o1', 'o2', 'o3', 's1', 'g1']));

    const repairs = repairSalvagedCortexBranches();
    expect(repairs).toHaveLength(1);
    expect(repairs[0].ok).toBe(true);
    // Exactly the entries origin did not have — and only those.
    expect(repairs[0].requeued).toEqual(['s1', 'g1']);
    // o1 and o2: the local-only commits carry them and origin has them. o3 is
    // not counted — the salvage commit deleted its page, so no local-only tree
    // holds it. That is exactly why "is it on origin?" has to be the question.
    expect(repairs[0].presentOnOrigin).toBe(2);

    // The branch now sits on the origin tip, worktree and index included.
    expect(git(repoPath, 'rev-parse', CORTEX)).toBe(git(repoPath, 'rev-parse', `origin/${CORTEX}`));
    expect(git(repoPath, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(repoPath, PAGE2))).toBe(true);
    expect(readFileSync(join(repoPath, PAGE1), 'utf-8')).not.toContain('"s1"');

    // THE INVARIANT: nothing reachable before the fix is unreachable after it.
    const after = new Set([...idsAtRev(repoPath, `origin/${CORTEX}`), ...outboxIds(CORTEX)]);
    for (const id of before) expect(after.has(id)).toBe(true);

    // And the re-queued rows carry the original bytes, not a re-serialisation.
    const db = getCortexDb(CORTEX);
    const rows = db.prepare('SELECT entry_id, line, created_at FROM l1_outbox ORDER BY id ASC').all() as
      Array<{ entry_id: string; line: string; created_at: string }>;
    closeCortexDb(CORTEX);
    expect(rows.map((row) => row.line)).toEqual([entryLine('s1', 'content s1'), entryLine('g1', 'content g1')]);
    expect(rows.map((row) => row.created_at)).toEqual([
      JSON.parse(entryLine('s1', '')).ts,
      JSON.parse(entryLine('g1', '')).ts,
    ]);

    // AC1 again, against the repaired machine: the check now passes.
    expect(checkSalvageCommits({ repoPath }).status).toBe('pass');
  });

  it('AC2: every local id already on origin → a plain reset, nothing re-queued', () => {
    const { repoPath } = harness;
    writePage(repoPath, PAGE1, ['o1', 'o2']);
    writePage(repoPath, PAGE2, ['o3']);
    git(repoPath, 'add', '--', PAGE1, PAGE2);
    git(repoPath, 'commit', '-m', 'sync: batch that reached origin');
    git(repoPath, 'push', 'origin', CORTEX);

    // A pure inversion: the salvage commit only deletes, it adds nothing.
    git(repoPath, 'rm', '--quiet', '--', PAGE2);
    git(repoPath, 'commit', '-m', salvageCommitSubject(CORTEX));

    const repairs = repairSalvagedCortexBranches();
    expect(repairs[0].ok).toBe(true);
    expect(repairs[0].requeued).toEqual([]);
    expect(repairs[0].presentOnOrigin).toBe(2);
    expect(outboxIds(CORTEX)).toEqual([]);
    // o3's page was deleted locally; the reset brings it back from origin.
    expect(idsAtRev(repoPath, CORTEX)).toEqual(new Set(['o1', 'o2', 'o3']));
    expect(git(repoPath, 'rev-parse', CORTEX)).toBe(git(repoPath, 'rev-parse', `origin/${CORTEX}`));
  });

  it('AC2: an entry already queued in the outbox is not queued twice', () => {
    const { repoPath } = harness;
    buildBrokenState(repoPath);

    const db = getCortexDb(CORTEX);
    db.prepare('INSERT INTO l1_outbox (entry_id, line, created_at) VALUES (?, ?, ?)').run(
      's1',
      entryLine('s1', 'content s1'),
      '2026-09-17T00:00:00.000Z',
    );
    closeCortexDb(CORTEX);

    const repairs = repairSalvagedCortexBranches();
    expect(repairs[0].ok).toBe(true);
    expect(repairs[0].requeued).toEqual(['g1']);
    expect(outboxIds(CORTEX)).toEqual(['s1', 'g1']);
  });

  it('AC2: an in-flight worktree append on the checked-out branch is re-queued too', () => {
    const { repoPath } = harness;
    buildBrokenState(repoPath);
    // Uncommitted, in no tree anywhere — the reset would be its only reader.
    appendEntry(repoPath, PAGE1, 'w1');

    const repairs = repairSalvagedCortexBranches();
    expect(repairs[0].ok).toBe(true);
    expect(repairs[0].requeued).toEqual(['s1', 'g1', 'w1']);
    expect(git(repoPath, 'status', '--porcelain')).toBe('');
    expect(outboxIds(CORTEX)).toContain('w1');
  });

  // -------------------------------------------------------------------------
  // Refusals — every one of them must leave the branch exactly as found
  // -------------------------------------------------------------------------

  it('refuses, without resetting, when origin is unreachable', () => {
    const { repoPath } = harness;
    buildBrokenState(repoPath);
    const tipBefore = git(repoPath, 'rev-parse', CORTEX);

    const repairs = repairSalvagedCortexBranches({
      fetch: () => {
        throw new Error('fatal: unable to access origin: Could not resolve host');
      },
    });

    expect(repairs[0].ok).toBe(false);
    expect(repairs[0].reason).toContain('could not reach origin');
    expect(repairs[0].requeued).toEqual([]);
    expect(git(repoPath, 'rev-parse', CORTEX)).toBe(tipBefore);
    expect(outboxIds(CORTEX)).toEqual([]);
  });

  it('warns but never repairs a branch with no origin ref', () => {
    const { repoPath } = harness;
    const orphan = 'unpushedcortex';
    getCortexDb(orphan);
    closeCortexDb(orphan);
    // A local-only branch: one root commit with a page, then a salvage commit
    // deleting it. Nothing on it has ever been seen by origin.
    git(repoPath, 'checkout', '--orphan', orphan);
    git(repoPath, 'rm', '-rf', '--quiet', '.');
    mkdirSync(join(repoPath, orphan), { recursive: true });
    writePage(repoPath, `${orphan}/000001.jsonl`, ['u1']);
    writePage(repoPath, `${orphan}/000002.jsonl`, ['u2']);
    git(repoPath, 'add', '--', `${orphan}/000001.jsonl`, `${orphan}/000002.jsonl`);
    git(repoPath, 'commit', '-m', `init: create cortex ${orphan}`);
    git(repoPath, 'rm', '--quiet', '--', `${orphan}/000002.jsonl`);
    git(repoPath, 'commit', '-m', salvageCommitSubject(orphan));
    const tipBefore = git(repoPath, 'rev-parse', orphan);

    const findings = findSalvagedCortexBranches();
    expect(findings.map((f) => f.branch)).toEqual([orphan]);
    expect(findings[0].hasUpstream).toBe(false);

    const result = checkSalvageCommits({ repoPath });
    expect(result.status).toBe('warn');
    expect(result.fixable).toBe(false);
    expect(result.detail).toContain('no origin ref');

    const repairs = repairSalvagedCortexBranches();
    expect(repairs[0].ok).toBe(false);
    expect(repairs[0].reason).toContain(`no origin/${orphan}`);
    expect(git(repoPath, 'rev-parse', orphan)).toBe(tipBefore);
    expect(outboxIds(orphan)).toEqual([]);
  });

  it('refuses when the checked-out worktree differs from HEAD outside its L1 pages', () => {
    const { repoPath } = harness;
    buildBrokenState(repoPath);
    const tipBefore = git(repoPath, 'rev-parse', CORTEX);
    // `git reset --hard` would discard this, and nothing in the entry proof can
    // vouch for it.
    writeFileSync(join(repoPath, '.gitattributes'), '*.jsonl merge=union\n# hand edit\n');

    const repairs = repairSalvagedCortexBranches();
    expect(repairs[0].ok).toBe(false);
    expect(repairs[0].reason).toContain('outside its L1 pages');
    expect(git(repoPath, 'rev-parse', CORTEX)).toBe(tipBefore);
    expect(readFileSync(join(repoPath, '.gitattributes'), 'utf-8')).toContain('# hand edit');
  });

  it('refuses when a local-only page holds a line it cannot name', () => {
    const { repoPath } = harness;
    buildBrokenState(repoPath);
    // An entry we cannot identify is an entry we cannot prove origin has.
    appendFileSync(join(repoPath, PAGE1), 'not json at all\n');
    git(repoPath, 'add', '--', PAGE1);
    git(repoPath, 'commit', '-m', 'sync: a page we cannot parse');
    const tipBefore = git(repoPath, 'rev-parse', CORTEX);

    const repairs = repairSalvagedCortexBranches();
    expect(repairs[0].ok).toBe(false);
    expect(repairs[0].reason).toContain('could not read the L1 pages');
    expect(git(repoPath, 'rev-parse', CORTEX)).toBe(tipBefore);
    expect(outboxIds(CORTEX)).toEqual([]);
  });

  it('does nothing at all on a home with no cortex clone', () => {
    rmSync(harness.repoPath, { recursive: true, force: true });
    const result = checkSalvageCommits({ repoPath: harness.repoPath });
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('No cortex repo');
    expect(findSalvagedCortexBranches({ repoPath: harness.repoPath })).toEqual([]);
  });
});
