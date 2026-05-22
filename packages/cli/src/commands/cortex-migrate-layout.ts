/**
 * `think cortex migrate-layout` — one-shot migration that moves every cortex
 * file under the canonical `<branchName>/` subdir on its branch.
 *
 * Why this exists
 * ----------------
 * Two write paths historically disagreed on where a cortex's files live in
 * the git working tree:
 *
 *   1. The legacy `git-adapter` flow (`appendAndCommit` / `createOrphanBranch`)
 *      wrote flat at the branch root: `<repo>/000001.jsonl`,
 *      `<repo>/long-term.jsonl`, `<repo>/<peer>-retros.jsonl`.
 *
 *   2. The newer daemon + proxy flow (`sync-handler`, `compaction/apply`,
 *      `supersession/apply`, `serve/cortex-writer`) wrote nested under a
 *      per-cortex subdir: `<repo>/<branchName>/<file>`.
 *
 * Branches written by both paths ended up with a mixed layout — the
 * `cortex/engineering` branch we used as the motivating example had four
 * flat pages at root *and* a `cortex/engineering/000001.jsonl` inside the
 * canonical subdir. Pull and reindex paths that used a non-recursive
 * `ls-tree` silently missed the nested files; `reindex --force` could drop
 * indexed entries that had no recoverable JSONL source.
 *
 * Canonical layout going forward
 * ------------------------------
 *   <repo>/<branchName>/000001.jsonl
 *   <repo>/<branchName>/000002.jsonl
 *   ...
 *   <repo>/<branchName>/long-term.jsonl
 *   <repo>/<branchName>/<peer>-retros.jsonl
 *
 * Migration rules
 * ---------------
 *  - Flat numbered pages at the branch root keep their numbers, in original
 *    order. They are the older history.
 *  - Existing nested numbered pages (in the canonical subdir *or* in any
 *    non-canonical sibling subdir like `hivedb/` on the `cortex/hivedb`
 *    branch) are renumbered to start at `max(flat) + 1`, preserving their
 *    relative order. They are the newer history.
 *  - Non-numbered cortex files (`long-term.jsonl`, `<peer>-retros.jsonl`,
 *    legacy `memories.jsonl`) are moved into the canonical subdir under
 *    their original basename; a collision with an existing nested file
 *    aborts the migration for that branch.
 *  - Idempotent: a branch that already has everything under the canonical
 *    subdir produces no commit.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  ensureRepoCloned,
  fetchBranch,
  listLocalBranches,
  listBranchRootFiles,
  safeGitEnv,
} from '../lib/git.js';
import { getRepoPath } from '../lib/paths.js';

interface MigratePlan {
  /** Existing flat numbered pages at the branch root, sorted. */
  flatPages: string[];
  /** `long-term.jsonl` at root, if present. */
  flatLongTerm: string | null;
  /** Top-level legacy `memories.jsonl`, if present (pre-v2). */
  flatMemories: string | null;
  /** `<peer>-retros.jsonl` at root, sorted. */
  flatRetros: string[];
  /**
   * Nested files to relocate. Source is git-relative POSIX path; target is
   * the new basename under the canonical `<branch>/` subdir.
   */
  moves: { source: string; targetBasename: string }[];
  /**
   * Renumbered nested pages already living under `<branch>/`: source is the
   * existing nested path, targetBasename is the new `<NNNNNN>.jsonl` basename
   * after renumbering past the flat pages.
   */
  canonicalRenumbers: { source: string; targetBasename: string }[];
}

/**
 * Walk a directory recursively and collect every `.jsonl` file path
 * relative to `repoRoot`, using forward slashes (POSIX paths for git).
 */
function collectJsonlPaths(repoRoot: string, dir: string, out: string[]): void {
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let stat: fs.Stats;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      if (entry === '.git') continue;
      collectJsonlPaths(repoRoot, full, out);
    } else if (entry.endsWith('.jsonl')) {
      const rel = path.relative(repoRoot, full).split(path.sep).join('/');
      out.push(rel);
    }
  }
}

/**
 * Run a single git command in the repo working tree, returning stdout. Uses
 * the same hooks-disabled / sanitized-env setup as `lib/git.ts`.
 */
function git(args: string[], cwd: string): string {
  const safeArgs = [
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=',
    ...args,
  ];
  return execFileSync('git', safeArgs, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: safeGitEnv(),
  }).trim();
}

/**
 * Construct the migration plan for a branch. Pure (filesystem reads only;
 * no mutations). Returns null when nothing needs to move.
 */
function planBranchMigration(branch: string, repoPath: string): MigratePlan | null {
  const rootEntries = listBranchRootFiles(branch);

  const flatPages = rootEntries
    .filter(f => /^\d{6}\.jsonl$/.test(f))
    .sort();
  const flatLongTerm = rootEntries.find(f => f === 'long-term.jsonl') ?? null;
  const flatMemories = rootEntries.find(f => f === 'memories.jsonl') ?? null;
  const flatRetros = rootEntries
    .filter(f => f.endsWith('-retros.jsonl'))
    .sort();

  // Collect every nested .jsonl on the working tree. Path is git-relative
  // using POSIX separators. Skip files already at their canonical location
  // (they don't need to move) but still consider canonical numbered pages
  // for renumbering past the flat history.
  const canonicalPrefix = branch + '/';
  const allNested: string[] = [];
  collectJsonlPaths(repoPath, repoPath, allNested);
  const nested = allNested.filter(p => p.includes('/')); // exclude root-level

  const canonicalNested = nested
    .filter(p => p.startsWith(canonicalPrefix))
    .sort();
  const offCanonicalNested = nested
    .filter(p => !p.startsWith(canonicalPrefix))
    .sort();

  // Canonical numbered pages get renumbered to come after the flat pages.
  // Determine the starting number: highest flat number + 1, or 1 if no flat
  // numbered pages exist.
  const flatMaxNum = flatPages.length > 0
    ? parseInt(flatPages[flatPages.length - 1].replace('.jsonl', ''), 10)
    : 0;
  let nextNum = flatMaxNum + 1;

  const canonicalRenumbers: MigratePlan['canonicalRenumbers'] = [];
  const moves: MigratePlan['moves'] = [];

  // First, handle canonical-nested numbered pages: renumber them.
  // Non-numbered canonical files (long-term, retros, memories) are already in
  // their final location and don't need to move.
  const canonicalNumberedPages = canonicalNested
    .filter(p => /^\d{6}\.jsonl$/.test(path.basename(p)))
    .sort();
  for (const src of canonicalNumberedPages) {
    const target = String(nextNum).padStart(6, '0') + '.jsonl';
    if (path.basename(src) !== target) {
      canonicalRenumbers.push({ source: src, targetBasename: target });
    }
    nextNum++;
  }

  // Non-canonical nested .jsonl files (e.g. `hivedb/000001.jsonl` on the
  // `cortex/hivedb` branch). Numbered pages get renumbered to continue the
  // sequence; non-numbered files keep their basename and move into canonical.
  // Sort numbered first to keep them in chronological order, then everything
  // else, so the renumbering is deterministic.
  const offCanonicalNumbered = offCanonicalNested
    .filter(p => /^\d{6}\.jsonl$/.test(path.basename(p)))
    .sort();
  const offCanonicalOther = offCanonicalNested
    .filter(p => !/^\d{6}\.jsonl$/.test(path.basename(p)))
    .sort();
  for (const src of offCanonicalNumbered) {
    moves.push({ source: src, targetBasename: String(nextNum).padStart(6, '0') + '.jsonl' });
    nextNum++;
  }
  for (const src of offCanonicalOther) {
    moves.push({ source: src, targetBasename: path.basename(src) });
  }

  // Flat numbered pages move into canonical, preserving their numbers.
  for (const f of flatPages) {
    moves.push({ source: f, targetBasename: f });
  }
  if (flatLongTerm) {
    moves.push({ source: flatLongTerm, targetBasename: 'long-term.jsonl' });
  }
  if (flatMemories) {
    // `memories.jsonl` only ever existed pre-v2 as a single top-level file.
    // It can be safely numbered `000001.jsonl` *only* when no other source
    // has already claimed that slot — flat pages, canonical pages, AND
    // off-canonical pages all consume numbers from the same sequence. Miss
    // any one of those and `applyPlan`'s `addTarget` pre-flight aborts with
    // a confusing "duplicate migration target" error.
    const noNumberedSources =
      flatPages.length === 0 &&
      canonicalNumberedPages.length === 0 &&
      offCanonicalNumbered.length === 0;
    const memTarget = noNumberedSources
      ? '000001.jsonl'
      : String(nextNum).padStart(6, '0') + '.jsonl';
    moves.push({ source: flatMemories, targetBasename: memTarget });
    nextNum++;
  }
  for (const f of flatRetros) {
    moves.push({ source: f, targetBasename: f });
  }

  if (moves.length === 0 && canonicalRenumbers.length === 0) {
    return null;
  }

  return { flatPages, flatLongTerm, flatMemories, flatRetros, moves, canonicalRenumbers };
}

/**
 * Execute a planned migration on the currently-checked-out branch. Renames
 * via `git mv` go through git's index so the resulting commit shows them as
 * renames. The canonical subdir is mkdir'd up front; existing collisions
 * abort the migration.
 */
function applyPlan(plan: MigratePlan, branch: string, repoPath: string): void {
  const canonicalDir = path.join(repoPath, branch);
  fs.mkdirSync(canonicalDir, { recursive: true, mode: 0o700 });

  // Pre-flight: refuse to overwrite any existing file at a target location.
  const targets = new Set<string>();
  const addTarget = (rel: string): void => {
    if (targets.has(rel)) {
      throw new Error(`Internal: duplicate migration target ${rel}`);
    }
    targets.add(rel);
  };
  for (const r of plan.canonicalRenumbers) {
    addTarget(`${branch}/${r.targetBasename}`);
  }
  for (const m of plan.moves) {
    addTarget(`${branch}/${m.targetBasename}`);
  }

  // Renumber canonical pages first (highest → lowest) to avoid intermediate
  // name collisions. Build the rename order by sorting by source basename
  // descending.
  const canonicalSorted = [...plan.canonicalRenumbers].sort((a, b) =>
    b.source.localeCompare(a.source),
  );
  for (const { source, targetBasename } of canonicalSorted) {
    const target = `${branch}/${targetBasename}`;
    // Two-step rename through a staging name avoids the edge case where the
    // target equals another source in this same batch — e.g. renaming 000001
    // → 000005 and 000005 → 000009 in one pass. The staging name uses a
    // tilde suffix so it never collides with a real cortex file.
    const stage = `${source}.migrating.tmp`;
    git(['mv', '--', source, stage], repoPath);
    git(['mv', '--', stage, target], repoPath);
  }

  for (const { source, targetBasename } of plan.moves) {
    const target = `${branch}/${targetBasename}`;
    if (fs.existsSync(path.join(repoPath, target))) {
      throw new Error(`Cannot move ${source} → ${target}: target already exists.`);
    }
    git(['mv', '--', source, target], repoPath);
  }

  // Remove any now-empty non-canonical subdirs left behind by the moves.
  // `git mv` doesn't delete the source dir; this keeps the post-migration
  // tree clean without forcing an extra commit.
  const rootEntries = fs.readdirSync(repoPath);
  for (const entry of rootEntries) {
    if (entry === '.git') continue;
    const full = path.join(repoPath, entry);
    if (!fs.statSync(full).isDirectory()) continue;
    // Don't remove anything inside the canonical path.
    if (entry === branch.split('/')[0]) continue;
    // Recurse to check if the subtree is empty; if so, rm.
    try {
      fs.rmdirSync(full, { recursive: false });
    } catch {
      // Non-empty (or some other error) — leave it alone.
    }
  }
}

/**
 * Migrate one branch. Switches to the branch, plans, applies, commits, and
 * optionally pushes. Returns a short status string for the per-branch report.
 */
async function migrateOneBranch(
  branch: string,
  opts: { dryRun: boolean; push: boolean },
): Promise<string> {
  const repoPath = getRepoPath();

  // Switch/fetch like `appendAndCommit` does — the migration must operate on
  // the latest remote state, otherwise a peer who pushed between fetch and
  // migrate would lose their writes during the rebase.
  fetchBranch(branch);
  try { git(['switch', '--', branch], repoPath); }
  catch { git(['switch', '-c', branch, '--', `origin/${branch}`], repoPath); }
  // `git pull` does not accept the `--` argument separator the way `git
  // push` does — recent git versions reject `pull --rebase origin -- main`.
  // The branch name has been validated via the prior `git switch` path
  // (assertSafePositional doesn't apply to this local helper) and via the
  // listLocalBranches enumeration, so a literal positional is safe here.
  try { git(['pull', '--rebase', 'origin', branch], repoPath); }
  catch { /* first push / unborn upstream — proceed without rebase */ }

  const plan = planBranchMigration(branch, repoPath);
  if (!plan) return chalk.dim('already nested');

  const fileCount = plan.moves.length + plan.canonicalRenumbers.length;

  if (opts.dryRun) {
    // Print the plan inline (the outer loop already wrote the branch name as
    // a left-justified label) and return a status that the outer loop
    // appends with a checkmark. Indent each detail line under the label so
    // the report reads as a tree, not as two competing branch headers.
    process.stdout.write(`\n`);
    for (const r of plan.canonicalRenumbers) {
      process.stdout.write(`      rename  ${r.source} → ${branch}/${r.targetBasename}\n`);
    }
    for (const m of plan.moves) {
      process.stdout.write(`      move    ${m.source} → ${branch}/${m.targetBasename}\n`);
    }
    process.stdout.write(`    `);
    return `${fileCount} file(s) ${chalk.dim('(dry run)')}`;
  }

  applyPlan(plan, branch, repoPath);

  // `git mv` already staged each rename; one commit captures the whole tree.
  const commitMsg = `migrate: nest cortex files under ${branch}/`;
  try {
    git(['commit', '-m', commitMsg], repoPath);
  } catch (err) {
    // Possible no-op (e.g. plan was non-empty but mv produced no net change);
    // surface anything else.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/nothing to commit/i.test(msg)) {
      throw new Error(`commit failed on ${branch}: ${msg}`);
    }
    return chalk.dim('nothing to commit');
  }

  if (opts.push) {
    git(['push', 'origin', '--', branch], repoPath);
    return `${fileCount} file(s) committed, pushed`;
  }
  return `${fileCount} file(s) committed (push skipped)`;
}

export const cortexMigrateLayoutCommand = new Command('migrate-layout')
  .description('One-time: nest cortex files under the <branch>/ subdir for every branch (or one named branch)')
  .argument('[cortex]', 'Specific branch/cortex to migrate (defaults to every local branch)')
  .option('--dry-run', 'Print the plan without committing or pushing', false)
  .option('--no-push', 'Commit locally but skip git push')
  .action(async (cortexArg: string | undefined, opts: { dryRun: boolean; push: boolean }) => {
    try {
      ensureRepoCloned();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`No repo configured: ${msg}`));
      process.exit(1);
    }

    let branches: string[];
    if (cortexArg) {
      branches = [cortexArg];
    } else {
      try {
        branches = listLocalBranches();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Could not enumerate local branches: ${msg}`));
        process.exit(1);
      }
      if (branches.length === 0) {
        console.error(chalk.yellow('No local branches found. Pass a cortex name explicitly:'));
        console.error(chalk.dim('  think cortex migrate-layout <cortex-name>'));
        process.exit(1);
      }
    }

    console.log(chalk.cyan(`Migrating ${branches.length} branch(es) into nested layout...`));
    if (opts.dryRun) {
      console.log(chalk.dim('  (dry run — no commits or pushes)'));
    }

    // Capture the originally-checked-out branch so we can restore it at the
    // end. Migrating leaves the working tree on whichever branch we processed
    // last, and the daemon writes to the *currently-checked-out* working tree
    // (no internal `git switch` per cortex). If the migration handed control
    // back on the wrong branch, subsequent daemon writes would land on that
    // branch's tree instead of the cortex's — surfaces as "ghost commits on
    // main" after running this command.
    const repoPath = getRepoPath();
    let originalBranch: string | null = null;
    try {
      originalBranch = execFileSync('git', [
        '-c', 'core.hooksPath=/dev/null',
        '-c', 'core.fsmonitor=',
        'rev-parse', '--abbrev-ref', 'HEAD',
      ], {
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: safeGitEnv(),
      }).trim();
      if (originalBranch === 'HEAD') originalBranch = null; // detached
    } catch {
      originalBranch = null;
    }

    let failed = 0;
    for (const branch of branches) {
      process.stdout.write(`  ${chalk.cyan(branch.padEnd(28))} `);
      try {
        const status = await migrateOneBranch(branch, opts);
        process.stdout.write(`${chalk.green('✓')} ${status}\n`);
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        process.stdout.write(`${chalk.red('✗')} ${msg}\n`);
      }
    }

    // Restore the original branch so the daemon (which writes to whatever
    // working tree is currently checked out) continues to write into the
    // correct cortex on its next sync.
    if (originalBranch && !opts.dryRun) {
      try {
        execFileSync('git', [
          '-c', 'core.hooksPath=/dev/null',
          '-c', 'core.fsmonitor=',
          'switch', '--', originalBranch,
        ], {
          cwd: repoPath,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          env: safeGitEnv(),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.yellow(`\nCould not restore original branch "${originalBranch}": ${msg}`));
        console.error(chalk.yellow(`  Run 'git switch ${originalBranch}' inside ${repoPath} before the daemon writes.`));
      }
    }

    if (failed > 0) {
      console.error(chalk.red(`\n${failed} branch(es) failed.`));
      process.exit(1);
    }
    console.log(chalk.green('\nDone.'));
  });
