import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getRepoPath } from './paths.js';
import { getConfig } from './config.js';
import { validateRepoUrl, repoUrlsEquivalent } from './repo-url.js';

// Sanitized environment for git subprocesses — strips variables that could
// alter git behavior (hook injection, credential interception, path redirection).
// Exported so async git helpers in other modules (e.g., push-debouncer.ts) can
// reuse the canonical env-prep logic without duplicating it.
export function safeGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Prevent attacker-controlled env vars from influencing git operations
  delete env.GIT_SSH_COMMAND;
  delete env.GIT_PROXY_COMMAND;
  delete env.GIT_ASKPASS;
  delete env.GIT_CONFIG_GLOBAL;
  delete env.GIT_CONFIG_SYSTEM;
  delete env.GIT_WORK_TREE;
  delete env.GIT_DIR;
  delete env.GIT_EXEC_PATH;
  // Prevent system-level config and templates from injecting hooks
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_TEMPLATE_DIR = '';
  return env;
}

function runGit(args: string[], cwd?: string): string {
  const repoPath = cwd ?? getRepoPath();
  // Disable hooks and fsmonitor to prevent code execution from cloned repos
  const safeArgs = [
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=',
    ...args,
  ];
  return execFileSync('git', safeArgs, {
    cwd: repoPath,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: safeGitEnv(),
  }).trim();
}

// Reject values that could be misinterpreted as git CLI flags
// (`--upload-pack=<cmd>`, `-o`, etc.). Call on any value that flows into a
// git subprocess as a positional argument — branch names, repo URLs, refs,
// file paths. Combined with `--` separators at the call sites, this is
// defense-in-depth against argument-injection CVE-class bugs.
function assertSafePositional(value: string, fieldName: string): void {
  if (!value) {
    throw new Error(`Invalid ${fieldName}: empty or undefined.`);
  }
  if (value.startsWith('-')) {
    const remediation = fieldName.startsWith('cortex.')
      ? ` Fix with 'think cortex setup' or edit ~/.config/think/config.json.`
      : ``;
    throw new Error(
      `Invalid ${fieldName}: "${value}" starts with '-'. ` +
        `Values passed to git as positional arguments cannot begin with a hyphen.` +
        remediation,
    );
  }
}

// Pull --rebase with explicit conflict handling — aborts the rebase on
// conflict so the working tree doesn't linger in a rebase-in-progress state
// across retry attempts. Append-only files shouldn't produce conflicts in
// practice, but both call sites (initial pull + retry-loop pull) need the
// same behavior.
function pullRebaseOrAbort(branchName: string): void {
  assertSafePositional(branchName, 'branch name');
  try {
    runGit(['pull', '--rebase', 'origin', '--', branchName]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('CONFLICT') || message.includes('could not apply')) {
      try { runGit(['rebase', '--abort']); } catch { /* best effort */ }
      throw new Error(
        `Rebase conflict on ${branchName}. This should not happen with append-only files — ` +
          `if it recurs, open an issue at https://github.com/OpenThinkAi/think-cli/issues with the git output above.`,
      );
    }
    // Acceptable: rebase fails when local branch has no upstream yet (first push).
    // Swallow and return; caller's subsequent push will either succeed or surface a clearer error.
  }
}

export function ensureRepoCloned(): void {
  const config = getConfig();
  if (!config.cortex?.repo) {
    throw new Error('No cortex repo configured. Run: think cortex setup');
  }
  // Read-time validation uses the same regex as `think cortex setup` — a
  // value that smuggled past setup-time validation (because the config file
  // was edited directly) still gets rejected here. Rejects leading '-'
  // (--upload-pack=<cmd>-style argv injection) AND non-allowlisted
  // transport schemes (file://, bare paths, custom protocols), so the
  // "upgrade breaking change" callout in the README is actually enforced.
  validateRepoUrl(config.cortex.repo);

  const repoPath = getRepoPath();

  if (fs.existsSync(path.join(repoPath, '.git'))) {
    const remote = runGit(['remote', 'get-url', 'origin'], repoPath);
    // Compare by normalized (host, path) so ssh://, https://, and the SCP
    // shortcut for the same repo don't trigger a false mismatch — the common
    // case is a user flipping the on-disk remote's transport without touching
    // config (or vice versa). If they actually point elsewhere, still throw.
    if (!repoUrlsEquivalent(remote, config.cortex.repo)) {
      throw new Error(`Repo at ${repoPath} points to ${remote}, expected ${config.cortex.repo}`);
    }
    return;
  }

  fs.mkdirSync(repoPath, { recursive: true });
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=', 'clone', '--no-checkout', '--', config.cortex.repo, repoPath], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: safeGitEnv(),
  });
}

export function branchExists(branchName: string): boolean {
  assertSafePositional(branchName, 'branch name');
  try {
    runGit(['ls-remote', '--exit-code', '--heads', 'origin', '--', branchName]);
    return true;
  } catch {
    return false;
  }
}

export function createOrphanBranch(branchName: string): void {
  assertSafePositional(branchName, 'branch name');
  // Note: `git checkout --orphan` consumes its branch-name argument directly
  // and doesn't support `--` before it (the separator would be parsed as the
  // branch name). assertSafePositional above is the defense for this call
  // site; the leading-hyphen check prevents the --upload-pack-style trick.
  runGit(['checkout', '--orphan', branchName]);
  try {
    runGit(['rm', '-rf', '.']);
  } catch {
    // Empty repo — nothing to remove
  }

  // Canonical layout: every cortex file lives under <repo>/<branchName>/...
  // so the branch tree is self-contained at one subdir, which keeps a future
  // merge-to-main from colliding across cortices. Use forward slashes for git
  // arguments (git accepts POSIX paths on every platform).
  const repoPath = getRepoPath();
  const cortexDir = path.join(repoPath, branchName);
  fs.mkdirSync(cortexDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(cortexDir, '000001.jsonl'), '', 'utf-8');
  runGit(['add', '--', `${branchName}/000001.jsonl`]);
  runGit(['commit', '-m', `init: create cortex ${branchName}`]);
  runGit(['push', '--set-upstream', 'origin', '--', branchName]);
}

export function fetchBranch(branchName: string): void {
  assertSafePositional(branchName, 'branch name');
  runGit(['fetch', 'origin', '--', branchName]);
}

/**
 * Return the currently-checked-out branch in the cortex repo, or `null` if
 * the repo is in a detached-HEAD state (or the rev-parse fails).
 */
export function getCurrentBranch(): string | null {
  try {
    const out = runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
    return out === 'HEAD' ? null : out;
  } catch {
    return null;
  }
}

/**
 * Ensure the working tree is checked out to `branchName`. No-op when already
 * on the branch. Falls back to `git switch -c` from `origin/<branchName>`
 * when the local branch ref is missing — same recovery as `appendAndCommit`.
 *
 * Why callers should always invoke this immediately before an L1 write:
 * every L1 page resolves to `<repoPath>/<branchName>/<file>`, but the
 * working tree at `<repoPath>` only contains the *checked-out* branch's
 * tracked files. If another process (or an operator command like
 * `migrate-layout`) left the tree on a different branch, the write
 * physically lands in that other branch's tree — and the push-debouncer's
 * `git add → commit → push` cycle then ships the data to the wrong branch
 * on the remote. Calling this synchronously before the append keeps the
 * write and the eventual commit on the same branch, since Node's
 * single-threaded execution guarantees no other write can interleave
 * between the switch and the `fs.appendFileSync`.
 *
 * No-ops when there's no `.git` directory under `getRepoPath()`. The L1
 * append-only tests (and the proxy's `appendFn` test seam) write into a
 * tmp THINK_HOME with no underlying git repo; without this guard every
 * test path would have to either spin up a real git repo or stub the helper.
 * The no-op is safe in production because every real cortex write
 * presupposes a cloned repo (`ensureRepoCloned` is the entry point).
 */
export function ensureBranchCheckedOut(branchName: string): void {
  assertSafePositional(branchName, 'branch name');
  if (!fs.existsSync(path.join(getRepoPath(), '.git'))) return;
  if (getCurrentBranch() === branchName) return;
  try {
    runGit(['switch', '--', branchName]);
  } catch {
    runGit(['switch', '-c', branchName, '--', `origin/${branchName}`]);
  }
}

/**
 * Idempotent: if `branchName` already exists on the remote, no-op. Otherwise
 * create it as an empty orphan branch and push it.
 *
 * `cortex create` calls `createOrphanBranch` once at cortex creation, but if
 * the create-time push fails (transient network, missing write perm at that
 * moment), the cortex exists locally with no remote ref — and every future
 * sync's `fetchBranch` fails with `fatal: couldn't find remote ref <name>`.
 * Calling this from the sync paths self-heals that state on the next attempt.
 */
export function ensureRemoteBranch(branchName: string): void {
  assertSafePositional(branchName, 'branch name');
  if (branchExists(branchName)) return;
  createOrphanBranch(branchName);
}

export function readFileFromBranch(branchName: string, filePath: string): string | null {
  assertSafePositional(branchName, 'branch name');
  try {
    // `show` takes a single composed ref:path argument, so `--` doesn't help
    // here. assertSafePositional on branchName handles the leading-hyphen
    // concern; filePath is repo-internal and fully controlled by callers.
    return runGit(['show', `origin/${branchName}:${filePath}`]);
  } catch {
    return null;
  }
}

/**
 * Read a cortex file from `branchName`, preferring the canonical subdir
 * `<branchName>/<fileName>` and falling back to the branch root
 * `<fileName>`. Returns null if the file exists at neither location.
 *
 * The fallback mirrors `listBranchFiles`'s union semantics so unmigrated
 * cortices (flat numbered pages at root, pre-`migrate-layout`) stay readable
 * while still pointing every fresh write at the canonical path. Callers that
 * specifically need the legacy top-level layout (e.g. the pre-v2
 * `memories.jsonl` recovery path) should still call `readFileFromBranch`
 * directly so the intent is explicit at the call site.
 */
export function readCortexFile(branchName: string, fileName: string): string | null {
  const nested = readFileFromBranch(branchName, `${branchName}/${fileName}`);
  if (nested !== null) return nested;
  return readFileFromBranch(branchName, fileName);
}

/**
 * Append `newLines` to the canonical cortex file `<branchName>/<targetFile>`
 * on the branch, then commit and push.
 *
 * `targetFile` is the basename (e.g. `"000005.jsonl"`, `"long-term.jsonl"`,
 * `"alice-retros.jsonl"`); the function prefixes it with `<branchName>/`
 * internally so callers stay layout-agnostic. The cortex subdir is
 * mkdir-recursive'd before the append, so brand-new cortices (and cortices
 * that have not yet been through `think cortex migrate-layout`) just work.
 *
 * `memories.jsonl` is preserved as the default for backward compatibility
 * with the legacy v1 layout, but in the canonical layout it lives at
 * `<branchName>/memories.jsonl`. The v1 → v2 migration in `migrateToBuckets`
 * still operates on the top-level legacy file; `migrate-layout` moves the
 * post-v2 results into the cortex subdir.
 */
export function appendAndCommit(
  branchName: string,
  newLines: string[],
  commitMessage: string,
  maxRetries: number = 3,
  targetFile: string = 'memories.jsonl',
): void {
  assertSafePositional(branchName, 'branch name');
  const repoPath = getRepoPath();
  // POSIX-style slash is what git wants on every platform; path.join uses the
  // OS separator for the on-disk write, but the staged ref must be POSIX.
  const stagedPath = `${branchName}/${targetFile}`;
  const filePath = path.join(repoPath, branchName, targetFile);

  try {
    runGit(['switch', '--', branchName]);
  } catch {
    // `git switch -c <new> <start-point>`: -c consumes the next arg as the
    // new branch name. We can't put `--` between -c and its arg. Validated
    // via assertSafePositional above.
    runGit(['switch', '-c', branchName, '--', `origin/${branchName}`]);
  }

  pullRebaseOrAbort(branchName);

  // Cortex subdir may not exist yet (first write to a cortex that has not
  // been through `migrate-layout`, or a brand-new orphan that this process
  // is the first to write to). Idempotent — safe on every call.
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });

  const content = newLines.join('\n') + '\n';
  fs.appendFileSync(filePath, content, 'utf-8');

  runGit(['add', '--', stagedPath]);
  runGit(['commit', '-m', commitMessage]);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      runGit(['push', 'origin', '--', branchName]);
      return;
    } catch {
      if (attempt === maxRetries) {
        throw new Error(`Push failed after ${maxRetries} attempts. Run 'think curate' again.`);
      }
      pullRebaseOrAbort(branchName);
    }
  }
}

export function getFileLog(branchName: string, filePath: string): string {
  assertSafePositional(branchName, 'branch name');
  return runGit(['log', '--oneline', `origin/${branchName}`, '--', filePath]);
}

export function listRemoteBranches(): string[] {
  const output = runGit(['ls-remote', '--heads', 'origin']);
  return output.trim().split('\n')
    .filter(Boolean)
    .map(line => line.split('\t')[1]?.replace('refs/heads/', ''))
    .filter(Boolean) as string[];
}

/**
 * Enumerate cortex names from the local git refs without a network call.
 *
 * Uses `git for-each-ref refs/heads/` on the local clone, so it reads
 * whatever branches are locally known (fetched or created locally). This
 * is appropriate for the daemon federated-recall path: it is sync but
 * does NOT block on network I/O, unlike `listRemoteBranches()` which runs
 * `git ls-remote --heads origin`. Returns branch names (= cortex names).
 *
 * Note: returns only branches that have been fetched locally. A cortex that
 * exists on the remote but has never been fetched will not appear here.
 * That is acceptable for alpha: locally-cloned cortexes are the intended
 * scope of the "accessible" federation level.
 *
 * Throws if git is unavailable or the repo is not initialised — callers
 * are responsible for handling the failure case.
 */
export function listLocalBranches(): string[] {
  const output = runGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads/']);
  return output.trim().split('\n').filter(Boolean);
}

/**
 * List the cortex files on `branchName`, looking under the canonical
 * `<branchName>/` subdir **and** the branch root, deduped by basename
 * (canonical wins on collision). Returns basenames, e.g.
 * `["000001.jsonl", "long-term.jsonl", "alice-retros.jsonl"]`.
 *
 * Why both locations? An upgrade can land on a cortex that has flat numbered
 * pages at the branch root (post-v2, pre-`migrate-layout`). Reading only the
 * canonical subdir would silently return `[]` and the pull path would treat
 * the cortex as empty — actual data still on the branch, just invisible. The
 * union keeps unmigrated cortices readable; `migrate-layout` collapses the
 * two locations into the canonical one when an operator is ready to commit
 * to the move.
 *
 * When the same basename appears at both locations (a partially-migrated
 * cortex), canonical wins because every new write goes there; the root copy
 * is older and `migrate-layout` will renumber it past the canonical pages.
 * Tree entries (sub-directories at root) are excluded so callers iterating
 * over the result for blobs do not stumble over the canonical subdir itself.
 */
export function listBranchFiles(branchName: string, extension?: string): string[] {
  assertSafePositional(branchName, 'branch name');

  // Canonical subdir contents. `<rev>:<path>` returns basenames (no prefix),
  // so callers' pattern matching on e.g. /^\d{6}\.jsonl$/ stays unchanged.
  let canonical: string[] = [];
  try {
    const output = runGit([
      'ls-tree', '--name-only',
      `origin/${branchName}:${branchName}`,
    ]);
    canonical = output.split('\n').filter(Boolean);
  } catch {
    // Subdir doesn't exist on the branch — common for unmigrated cortices.
  }

  // Root contents. `ls-tree --name-only` returns trees alongside blobs; we
  // filter out trees via the `100644 blob` prefix path to keep this list
  // strictly file-typed. The migration command uses `listBranchRootFiles` to
  // see trees too.
  let rootBlobs: string[] = [];
  try {
    const output = runGit(['ls-tree', `origin/${branchName}`]);
    rootBlobs = output
      .split('\n')
      .filter(line => line.includes(' blob '))
      .map(line => line.split('\t').pop() ?? '')
      .filter(Boolean);
  } catch {
    // Branch missing on origin — nothing to do.
  }

  // Canonical wins on basename collision.
  const seen = new Set(canonical);
  const merged = canonical.concat(rootBlobs.filter(f => !seen.has(f)));

  const filtered = extension
    ? merged.filter(f => f.endsWith(extension))
    : merged;
  return filtered.sort();
}

/**
 * List the immediate children of the branch root (`origin/<branchName>:`).
 *
 * Used by `cortex migrate-layout` to detect leftover flat-layout files
 * (pre-AGT-XXX) — `000001.jsonl`, `long-term.jsonl`, `<peer>-retros.jsonl`,
 * `memories.jsonl` — as well as any non-canonical sibling subdir (e.g.
 * `hivedb/` on the `cortex/hivedb` branch when the cortex was originally
 * created with a slashless name).
 *
 * Returns basenames; tree entries are returned alongside blob entries since
 * `ls-tree --name-only` does not distinguish — callers can probe via
 * `listBranchFiles` if a name turns out to be a tree.
 */
export function listBranchRootFiles(branchName: string, extension?: string): string[] {
  assertSafePositional(branchName, 'branch name');
  try {
    const output = runGit(['ls-tree', '--name-only', `origin/${branchName}`]);
    let files = output.split('\n').filter(Boolean);
    if (extension) {
      files = files.filter(f => f.endsWith(extension));
    }
    return files.sort();
  } catch {
    return [];
  }
}

/**
 * Count the non-empty lines in a cortex file on the branch. `fileName` is the
 * basename (e.g. `"000001.jsonl"`); the function resolves it under the
 * canonical `<branchName>/` subdir. Returns 0 when the file is missing or
 * empty.
 */
export function countBranchFileLines(branchName: string, fileName: string): number {
  const content = readCortexFile(branchName, fileName);
  if (!content) return 0;
  return content.trim().split('\n').filter(Boolean).length;
}

/**
 * v1 → v2 migration: legacy top-level `memories.jsonl` becomes the first
 * bucketed page `000001.jsonl`. In the canonical nested layout the page lands
 * at `<branchName>/000001.jsonl`; the legacy `memories.jsonl` is *removed*
 * from the top level so the branch tree ends with one entry per cortex (the
 * cortex subdir), matching what `migrate-layout` produces for every other
 * cortex.
 *
 * Rollback: if the push fails after the rename+commit, we `reset --hard` to
 * the pre-migration ref, which restores `memories.jsonl` at the top level
 * and removes the new nested file. Any caller that needs to retry can run
 * `cortex migrate-layout` (which is the long-term home for this kind of
 * one-shot rewrite) instead.
 */
export function migrateToBuckets(branchName: string): void {
  assertSafePositional(branchName, 'branch name');
  const repoPath = getRepoPath();

  try { runGit(['switch', '--', branchName]); }
  catch { runGit(['switch', '-c', branchName, '--', `origin/${branchName}`]); }

  // pull --rebase updates local branch pointer + working tree from remote.
  // Caller already called fetchBranch (updates remote refs), so this pull
  // is fast. appendAndCommit also does pull --rebase, but that's a no-op
  // if nothing changed between migration and append.
  pullRebaseOrAbort(branchName);

  const legacyPath = path.join(repoPath, 'memories.jsonl');
  const cortexDir = path.join(repoPath, branchName);
  const bucketPath = path.join(cortexDir, '000001.jsonl');

  if (fs.existsSync(legacyPath) && !fs.existsSync(bucketPath)) {
    // Save pre-migration ref for rollback
    const preMigrationRef = runGit(['rev-parse', 'HEAD']);

    fs.mkdirSync(cortexDir, { recursive: true, mode: 0o700 });
    fs.renameSync(legacyPath, bucketPath);
    // `add -A` picks up the deleted top-level file and the new nested file
    // in one shot, which keeps the commit atomic.
    runGit(['add', '-A']);
    runGit(['commit', '-m', `migrate: memories.jsonl -> ${branchName}/000001.jsonl`]);

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        runGit(['push', 'origin', '--', branchName]);
        return;
      } catch {
        if (attempt === 3) {
          // Rollback to pre-migration commit. That commit has memories.jsonl
          // at the top level (the move into <branch>/000001.jsonl happened
          // after it), so --hard reset restores the top-level file and
          // removes the nested copy.
          try { runGit(['reset', '--hard', preMigrationRef]); } catch { /* best effort */ }
          throw new Error('Migration push failed after 3 attempts — local commit rolled back');
        }
        pullRebaseOrAbort(branchName);
      }
    }
  }
}
