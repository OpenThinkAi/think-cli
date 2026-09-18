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
    // On Windows, spawning git without this flashes a console window per call.
    // The daemon makes many git calls (pull/push/show); during a backfill that's
    // a storm of focus-stealing windows. Harmless no-op on macOS/Linux.
    windowsHide: true,
  }).trim();
}

/**
 * Raw-bytes sibling of `runGit`. `runGit` decodes as UTF-8 and trims, which
 * destroys both trailing newlines and NUL record separators — fatal when the
 * output is blob content or `-z` plumbing output. Same hardening flags and
 * sanitized env; only the decoding differs.
 *
 * `maxBuffer` is raised above Node's 1 MiB default because the payload here is
 * an L1 page (up to `L1_PAGE_SIZE` JSONL rows). 64 MiB is far above any
 * realistic page and still bounds memory on a pathological blob.
 */
function runGitBuffer(args: string[]): Buffer {
  const safeArgs = [
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=',
    ...args,
  ];
  return execFileSync('git', safeArgs, {
    cwd: getRepoPath(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: safeGitEnv(),
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
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

/**
 * The single line every cortex branch's `.gitattributes` must carry. Maps
 * the JSONL pages to git's built-in `union` merge driver so concurrent
 * appends from divergent nodes reconcile losslessly instead of conflicting.
 */
export const UNION_MERGE_ATTRIBUTE = '*.jsonl merge=union';

/**
 * Error-message substrings emitted by `git merge --ff-only` when the fast-
 * forward cannot proceed. Used as catch-block sentinels so error-handling
 * code can distinguish an ff-only refusal from an unrelated git failure.
 * Centralised here so every caller (sync helper + async inline sites)
 * imports the same constant and stays in sync with any future git wording
 * changes.
 */
export const GIT_FF_ONLY_NO_REMOTE_REF =
  "couldn't find remote ref";

export const GIT_FF_ONLY_NOT_MERGEABLE =
  'Not possible to fast-forward';

/**
 * Pure helper: given current `.gitattributes` content, return the content
 * with the union-merge line appended, or `null` if the line is already
 * present (so the caller skips the write + commit). No I/O — shared by the
 * sync write path (`ensureUnionMergeAttribute`) and the async push-debouncer
 * so both emit byte-identical `.gitattributes`.
 */
export function withUnionMergeAttribute(current: string): string | null {
  if (current.split('\n').some((line) => line.trim() === UNION_MERGE_ATTRIBUTE)) {
    return null;
  }
  if (current.length === 0 || current.endsWith('\n')) {
    return current + UNION_MERGE_ATTRIBUTE + '\n';
  }
  return current + '\n' + UNION_MERGE_ATTRIBUTE + '\n';
}

/**
 * Ensure the checked-out cortex branch carries a `.gitattributes` mapping
 * `*.jsonl` to git's built-in `union` merge driver.
 *
 * Why this matters: page numbers (`000006.jsonl`) are assigned from the
 * *local* highest-page-on-disk, but the namespace is *global* (the shared
 * branch). Any node whose local view has drifted — a laptop back from a
 * long offline stretch, a crashed daemon, a proxy that was on the wrong
 * branch — will mint a page number that already exists on the remote with
 * different content. Without a union driver the resulting `pull --rebase`
 * conflicts, and naive resolution silently drops one side's lines. `union`
 * concatenates both sides instead, so nothing is lost (consumers dedup by
 * `id` and sort by `ts` on read).
 *
 * Idempotent: writes + commits only when the line is missing. No-op outside
 * a git repo (test fixtures / local-fs backend). The caller is expected to
 * have the target branch checked out; the resulting commit rides along on
 * the next push. Must run BEFORE the cycle's `pull --rebase` so the driver
 * is already in the working tree when the rebase replays a conflicting page.
 */
export function ensureUnionMergeAttribute(branchName: string): void {
  assertSafePositional(branchName, 'branch name');
  const repoPath = getRepoPath();
  if (!fs.existsSync(path.join(repoPath, '.git'))) return;
  // Always-effective local copy first — see ensureLocalUnionMergeAttribute
  // for why the committed .gitattributes alone cannot bootstrap the union
  // driver during the very rebase that introduces it.
  ensureLocalUnionMergeAttribute();
  const attrPath = path.join(repoPath, '.gitattributes');
  let current = '';
  try {
    current = fs.readFileSync(attrPath, 'utf-8');
  } catch {
    /* absent — treated as empty */
  }
  const next = withUnionMergeAttribute(current);
  if (next === null) return;
  fs.writeFileSync(attrPath, next, 'utf-8');
  runGit(['add', '--', '.gitattributes']);
  runGit(['commit', '-m', `chore(cortex): union merge driver for *.jsonl on ${branchName}`]);
}

/**
 * Write `*.jsonl merge=union` into `.git/info/attributes` — git's per-repo,
 * NON-committed attributes file, consulted for EVERY merge/rebase regardless
 * of which commit is checked out.
 *
 * This is the load-bearing half of the union-merge fix. A *committed*
 * `.gitattributes` is read from the checked-out tree, but during
 * `git pull --rebase` the checked-out tree is the `onto` (origin) commit —
 * so a freshly-introduced `.gitattributes` can't bootstrap itself (origin
 * doesn't carry it yet, so the conflicting rebase that's trying to push it
 * runs WITHOUT the driver and throws). `.git/info/attributes` sidesteps the
 * bootstrap entirely: it's active immediately, no commit required.
 *
 * Local-only — it does not travel to other clones, so each clone sets its
 * own. It pairs with the committed `.gitattributes` (ensureUnionMergeAttribute):
 * the local file lets THIS node's first push succeed; the committed file then
 * rides along on that push and propagates the mapping to every other node.
 *
 * Idempotent. No-op outside a normal (non-worktree) git repo.
 */
export function ensureLocalUnionMergeAttribute(): void {
  const gitDir = path.join(getRepoPath(), '.git');
  // Only handle a real .git directory (normal clone). A worktree's `.git` is
  // a file pointing elsewhere; the proxy/daemon always use a normal clone, and
  // the committed .gitattributes still covers the worktree case once on origin.
  let isDir = false;
  try {
    isDir = fs.statSync(gitDir).isDirectory();
  } catch {
    return; // no .git at all (test fixtures, local-fs backend)
  }
  if (!isDir) return;
  const infoDir = path.join(gitDir, 'info');
  const attrPath = path.join(infoDir, 'attributes');
  let current = '';
  try {
    current = fs.readFileSync(attrPath, 'utf-8');
  } catch {
    /* absent — treated as empty */
  }
  const next = withUnionMergeAttribute(current);
  if (next === null) return;
  fs.mkdirSync(infoDir, { recursive: true });
  fs.writeFileSync(attrPath, next, 'utf-8');
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
    // Existing clone: ensure the always-effective local union driver is set
    // (self-heals clones created before this landed, including ones that have
    // never re-cloned).
    ensureLocalUnionMergeAttribute();
    return;
  }

  fs.mkdirSync(repoPath, { recursive: true });
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=', 'clone', '--no-checkout', '--', config.cortex.repo, repoPath], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: safeGitEnv(),
    windowsHide: true, // suppress the per-call console window on Windows
  });
  // Fresh clone: stamp the always-effective local union driver so the very
  // first write's pull-rebase can reconcile a divergent page.
  ensureLocalUnionMergeAttribute();
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

/**
 * Return true if `refs/heads/<branchName>` exists in the LOCAL repository
 * (i.e. the branch has been created or checked out in this clone).
 *
 * Distinct from `branchExists()`, which queries the *remote* via `ls-remote`.
 * The distinction matters for the branch-prep idiom: we need to know whether
 * the local ref is present before deciding to `switch` vs `switch -c`, because
 * `switch -c` on an already-present local branch throws
 * "fatal: a branch named '<name>' already exists".
 */
export function localBranchExists(branchName: string): boolean {
  assertSafePositional(branchName, 'branch name');
  try {
    runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Attempt `git merge --ff-only origin/<branchName>`. Swallows the two
 * expected non-fatal cases:
 *  - "couldn't find remote ref" — brand-new cortex, no upstream yet.
 *  - "Not possible to fast-forward" — histories diverged; the subsequent
 *    `pullRebaseOrAbort` reconciles losslessly via the union driver.
 * Any other error propagates so we never silently swallow a real git failure.
 */
function tryFfOnly(branchName: string): void {
  try {
    runGit(['merge', '--ff-only', `origin/${branchName}`]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      !msg.includes(GIT_FF_ONLY_NO_REMOTE_REF) &&
      !msg.includes(GIT_FF_ONLY_NOT_MERGEABLE)
    ) {
      throw err;
    }
  }
}

/** Object names as git prints them (SHA-1 today, SHA-256 on a `--object-format` repo). */
const GIT_OID = /^[0-9a-f]{40,64}$/;

/** One record of `git diff-index`/`git diff-files` raw (`-z`) output. */
interface RawDiffEntry {
  /** Blob id on the "source" side — HEAD for `diff-index --cached`, the index for `diff-files`. */
  srcSha: string;
  /** Blob id on the "destination" side — the index, or all-zeros for an unhashed worktree file. */
  dstSha: string;
  status: string;
  path: string;
}

/**
 * Parse raw (`-z`) diff output: repeated `:<srcmode> <dstmode> <srcsha>
 * <dstsha> <status>\0<path>\0` records. Returns `null` on anything that does
 * not match that shape — including rename/copy records, whose second path field
 * is read as the next record's meta, fails the `:` prefix check and bails.
 * Callers treat `null` as
 * "cannot reason about this state" and fall back to the legacy salvage path,
 * so a parse failure is never silently acted upon.
 */
function parseRawDiffZ(out: Buffer): RawDiffEntry[] | null {
  const fields = out.toString('utf-8').split('\0');
  const entries: RawDiffEntry[] = [];
  let i = 0;
  while (i < fields.length) {
    const meta = fields[i];
    if (meta === undefined || meta === '') break; // trailing separator
    if (!meta.startsWith(':')) return null;
    const parts = meta.slice(1).split(' ');
    if (parts.length !== 5) return null;
    const [, , srcSha, dstSha, status] = parts;
    const filePath = fields[i + 1];
    if (!filePath) return null;
    entries.push({ srcSha, dstSha, status, path: filePath });
    i += 2;
  }
  return entries;
}

/**
 * Resolve a repo-relative path from git's `-z` output to an absolute path,
 * refusing anything that escapes the repo. Git only emits repo-relative paths
 * here, so this is belt-and-braces against a crafted path (`../..`, absolute)
 * ever reaching `fs.writeFileSync`.
 */
function resolveInsideRepo(relPath: string): string | null {
  if (!relPath || relPath.startsWith('-') || path.isAbsolute(relPath)) return null;
  const repoPath = path.resolve(getRepoPath());
  const abs = path.resolve(repoPath, relPath);
  if (!abs.startsWith(repoPath + path.sep)) return null;
  return abs;
}

/** Read a blob's exact bytes. `sha` must already have passed `GIT_OID`. */
function catBlob(sha: string): Buffer {
  return runGitBuffer(['cat-file', 'blob', sha]);
}

/**
 * `a` is a byte-prefix of `b` (equal counts).
 *
 * An EMPTY `a` is a prefix of everything, and that is load-bearing rather than
 * an oversight: `createOrphanBranch` opens each cortex with a zero-byte page, so
 * "index holds the empty blob, HEAD holds the daemon's first append" is the
 * ordinary first-write shape of the bug this guards. The cost is that a
 * deliberately *staged* truncation-to-empty of a page would read as a lag and be
 * reset away — unreachable for a cortex repo, where the only writers append
 * JSONL lines and nothing ever empties a page. Anything reusing this outside
 * that domain needs its own empty-blob guard.
 */
function isPrefixOf(a: Buffer, b: Buffer): boolean {
  return a.length <= b.length && b.subarray(0, a.length).equals(a);
}

/**
 * AGT-1299 / think-cli#95 — refuse to salvage an index that is merely BEHIND a
 * plumbing-advanced HEAD.
 *
 * The daemon's L1 writer (`lib/git-plumbing.ts`) advances `refs/heads/<cortex>`
 * with `commit-tree` + `update-ref` and deliberately never touches the index or
 * the worktree. When that branch happens to be the checked-out one, HEAD moves
 * out from under a now-stale index, and `git status` reports the daemon's own
 * appends inverted: the appended lines look like staged deletions and every
 * page the writer created looks like a staged file deletion. The legacy salvage
 * (`git add -u` + `commit`) then commits that stale index as the new tree —
 * a commit that reverts the daemon's writes. think-cli#95 saw ~6,000 deleted
 * lines from exactly this.
 *
 * `git status` alone cannot tell "stale" from "edited", so this proves it from
 * content before mutating anything:
 *
 *  1. HEAD ↔ index: every difference must be the index LAGGING. A path present
 *     in HEAD and absent from the index (`D`) is a page the writer created —
 *     the index records nothing there, so nothing can be lost. A modified path
 *     (`M`) must have an index blob that is a byte-prefix of HEAD's blob, i.e.
 *     HEAD holds the index's bytes plus an append. Anything else (a path the
 *     index has and HEAD does not, a type change, a rename, an unparseable
 *     record) means the index carries state HEAD does not, and we bail.
 *  2. index ↔ worktree: each difference must be a plain modification whose
 *     worktree bytes EXTEND the index blob — a genuine in-flight append. The
 *     new bytes (the suffix past the index blob) are the only thing the
 *     worktree holds that git does not, so they are hashed into the object
 *     database before any mutation and re-applied on top of HEAD's content
 *     afterwards. A worktree deletion or type change is not an append, cannot
 *     be merged onto HEAD, and bails.
 *
 * Only once both proofs hold do we mutate: `git reset --hard HEAD` (safe here
 * and only here — proof 1 showed the index holds nothing HEAD lacks, proof 2
 * captured everything the worktree holds beyond the index), then rewrite each
 * genuinely-appended page as HEAD's content + the captured suffix. The result:
 *
 *  - pure stale state → index and worktree land on HEAD, `git status -s` is
 *    empty, no commit is created and HEAD's tree is untouched;
 *  - stale + a genuine append → the caller's salvage commit still happens and
 *    its diff against HEAD is the append alone, never the stale deletions.
 *
 * Bailing returns `false` and leaves the tree exactly as found, so the legacy
 * salvage path runs unchanged — the conservative direction, since that path
 * commits (never discards) whatever it finds.
 *
 * Note: `git checkout -- .` does NOT clear this state (it copies the stale
 * index back onto the worktree); resetting to HEAD is what clears it.
 *
 * Exported (AGT-1308) because it is the read-only half: `think doctor` reports
 * the "`~/.think/repo` index stale vs HEAD" check purely from this verdict and
 * never mutates, while `think doctor --fix` runs `reconcilePlumbingStaleIndex`
 * below. Report and repair therefore share one definition of "stale".
 *
 * @returns the worktree files to rewrite after the reset (empty for the pure
 *          stale state), or `null` when the state is not provably stale.
 */
export function planStaleIndexReconcile(): Array<{ absPath: string; content: Buffer }> | null {
  // Unborn HEAD: there is no tree to be behind.
  let head: string;
  try {
    head = runGit(['rev-parse', '--verify', '--quiet', 'HEAD']);
  } catch {
    return null;
  }
  if (!head) return null;

  // Cheap gate for the steady state: `diff-index --cached --quiet` exits 0 when
  // the index matches HEAD, in which case nothing is stale and any dirt is a
  // plain worktree edit for the legacy path to salvage.
  try {
    runGit(['diff-index', '--cached', '--quiet', 'HEAD']);
    return null;
  } catch {
    /* index differs from HEAD — prove which direction below */
  }

  // --- Proof 1: every HEAD ↔ index difference is the index lagging ---------
  const headVsIndex = parseRawDiffZ(runGitBuffer(['diff-index', '--cached', '-z', 'HEAD']));
  if (headVsIndex === null || headVsIndex.length === 0) return null;
  const headBlobs = new Map<string, string>();
  for (const entry of headVsIndex) {
    // `D` here means "in HEAD, not in the index" — a page the plumbing writer
    // added. The index holds no bytes for it, so there is nothing to lose.
    if (entry.status === 'D') continue;
    if (entry.status !== 'M') return null;
    if (!GIT_OID.test(entry.srcSha) || !GIT_OID.test(entry.dstSha)) return null;
    const headContent = catBlob(entry.srcSha);
    const indexContent = catBlob(entry.dstSha);
    if (!isPrefixOf(indexContent, headContent)) return null;
    headBlobs.set(entry.path, entry.srcSha);
  }

  // --- Proof 2: capture genuine worktree appends ---------------------------
  const indexVsWorktree = parseRawDiffZ(runGitBuffer(['diff-files', '-z']));
  if (indexVsWorktree === null) return null;
  const restores: Array<{ absPath: string; content: Buffer }> = [];
  for (const entry of indexVsWorktree) {
    if (entry.status !== 'M') return null;
    if (!GIT_OID.test(entry.srcSha)) return null;
    const absPath = resolveInsideRepo(entry.path);
    if (absPath === null) return null;
    // Hash the worktree bytes into the object database BEFORE anything is
    // reset, so the in-flight append is recoverable (`git cat-file blob <sha>`)
    // even if a later step throws. `--no-filters` keeps the blob byte-identical
    // to what is on disk, which is what the prefix proof compares.
    const worktreeSha = runGit(['hash-object', '-w', '--no-filters', '--', entry.path]);
    if (!GIT_OID.test(worktreeSha)) return null;
    const worktreeContent = catBlob(worktreeSha);
    const indexContent = catBlob(entry.srcSha);
    // Not an append (rewritten or truncated in place) — we cannot merge it onto
    // HEAD without guessing, so hand the whole situation to the legacy path.
    if (!isPrefixOf(indexContent, worktreeContent)) return null;
    const suffix = worktreeContent.subarray(indexContent.length);
    // Identical bytes: `diff-files` also reports merely stat-dirty entries.
    if (suffix.length === 0) continue;
    const headSha = headBlobs.get(entry.path);
    // No HEAD↔index entry for this path ⇒ HEAD and the index agree on it.
    const headContent = headSha === undefined ? indexContent : catBlob(headSha);
    restores.push({ absPath, content: Buffer.concat([headContent, suffix]) });
  }

  return restores;
}

/**
 * Run `planStaleIndexReconcile`'s verdict. Split from the analysis so the two
 * halves have different error policies: the analysis is read-only, so a
 * surprise from git there is non-fatal and simply hands the tree to the legacy
 * salvage path; the mutation below must never be swallowed — a half-applied
 * reconcile has to surface, not fall through into a commit of whatever state
 * it left behind.
 *
 * Exported (AGT-1308) as the repair `think doctor --fix` applies for the stale
 * index check. Its AGT-1299 rule is unchanged and non-negotiable: it mutates
 * only after proving nothing in the index or worktree would be lost, and
 * otherwise returns false having touched nothing.
 *
 * @returns true when the reconciliation ran, false when the state was not
 *          provably stale.
 */
export function reconcilePlumbingStaleIndex(): boolean {
  let restores: Array<{ absPath: string; content: Buffer }> | null;
  try {
    restores = planStaleIndexReconcile();
  } catch {
    // Read-only probe failed (unreadable object, oversized blob, unmerged
    // index, ...). Nothing has been touched — let the legacy path decide.
    return false;
  }
  if (restores === null) return false;

  // Proven safe above: `reset --hard` discards only bytes HEAD already holds,
  // and every genuine append is both hashed into the object database and
  // rewritten on top of HEAD's content immediately after.
  runGit(['reset', '--hard', 'HEAD']);
  for (const restore of restores) {
    fs.writeFileSync(restore.absPath, restore.content);
  }
  return true;
}

/**
 * Self-heal (#69): bring the shared worktree to a clean state before a
 * `git switch` or `git merge --ff-only` — both hard-fail when the tree carries
 * uncommitted changes. The daemon time-shares ONE worktree across every cortex
 * branch, so a single leftover uncommitted engram — from a cycle that
 * crashed/aborted after appending to an L1 page but before committing — wedges
 * branch switching for ALL cortexes ("local changes would be overwritten by
 * checkout") until a human cleans it by hand.
 *
 * Recovery is by COMMIT, not discard: by the orphan-branch-per-cortex
 * invariant (`createOrphanBranch`) every tracked path in the worktree belongs
 * to the currently checked-out cortex branch, so an uncommitted change is
 * always legitimate, in-flight data for THAT branch. A salvage commit preserves
 * it and lets it push on the next cycle (the union merge driver reconciles any
 * divergence). `git reset --hard` would be simpler but would silently drop
 * writes from the direct (non-outbox) writers — the event-curator and scheduler
 * append straight to the L1 page — so it is not safe here.
 *
 * Stages only TRACKED modifications/deletions (`git add -u`): those are what
 * make `git switch`/`merge --ff-only` refuse. Untracked files don't block
 * either operation, so we deliberately leave them rather than sweeping stray
 * files into cortex history — an in-flight new page survives on disk and is
 * committed by the next cycle's scoped `git add -- <cortex>`.
 *
 * No-op on a clean (or untracked-only) tree — the steady state — and outside a
 * git repo. Best-effort on detached HEAD: the salvage commit is created anyway
 * so the switch can proceed; it stays reachable via the reflog.
 *
 * AGT-1299: "dirty" is not the same as "carries data". When HEAD was advanced
 * under a stale index by the plumbing writer, `git status` inverts the daemon's
 * own appends into staged deletions and committing them would revert real
 * writes. `reconcilePlumbingStaleIndex` catches that case first and brings the
 * index and worktree to HEAD instead; what it leaves behind (if anything) is a
 * genuine append, which the commit below salvages as before.
 */
function salvageDirtyWorktree(): void {
  if (!fs.existsSync(path.join(getRepoPath(), '.git'))) return;
  reconcilePlumbingStaleIndex();
  runGit(['add', '-u']);
  // `diff --cached --quiet` exits 0 when nothing is staged (clean or
  // untracked-only → no wedge) and non-zero when tracked changes are staged.
  try {
    runGit(['diff', '--cached', '--quiet']);
    return;
  } catch {
    /* tracked changes staged — salvage them below */
  }
  const current = getCurrentBranch();
  runGit(['commit', '-m', salvageCommitSubject(current)]);
}

// ---------------------------------------------------------------------------
// AGT-1310 — finding and undoing a bad salvage commit that never pushed
//
// Before AGT-1299 landed the guard above, `salvageDirtyWorktree` on a
// plumbing-stale index committed the daemon's own appends INVERTED: whole L1
// pages recorded as deletions (think-cli#95: ~6,000 deleted lines). That commit
// cannot fast-forward onto origin, so the branch wedges — every later push is
// rejected non-fast-forward and the machine silently stops propagating.
//
// The guard stops NEW ones. The commits already sitting on a machine's local
// branch are what `think doctor` reports and `think doctor --fix` undoes, by
// resetting the branch to `origin/<branch>` — but only after proving that
// every entry the local-only commits carry survives the reset. The proof and
// the re-queue live in `lib/salvage-repair.ts`; everything here is git-only,
// read-only unless its name says otherwise, and never checks the branch out.
// ---------------------------------------------------------------------------

/**
 * The subject line `salvageDirtyWorktree` writes, and the pattern
 * `planSalvageCommitRepair` matches commits against. One definition, so a
 * future reword cannot leave the detector hunting for text nothing writes.
 */
const SALVAGE_SUBJECT_HEAD = 'chore(cortex): salvage uncommitted worktree changes';
const SALVAGE_SUBJECT_TAIL = '(self-heal #69)';

export function salvageCommitSubject(branchName: string | null): string {
  return `${SALVAGE_SUBJECT_HEAD}${branchName ? ` on ${branchName}` : ''} ${SALVAGE_SUBJECT_TAIL}`;
}

/**
 * Is `subject` a `salvageCommitSubject(...)` line? Matched by its fixed head
 * and tail rather than by equality, because the middle carries whatever branch
 * name was checked out when the commit was made — which on a machine that has
 * since switched branches is not the branch we are inspecting.
 */
export function isSalvageCommitSubject(subject: string): boolean {
  return subject.startsWith(SALVAGE_SUBJECT_HEAD) && subject.endsWith(SALVAGE_SUBJECT_TAIL);
}

/** L1 page basenames, as `lib/l1-page.ts` numbers them. */
const L1_PAGE_BASENAME = /^\d{6}\.jsonl$/;

/**
 * Is `filePath` an L1 page of `branchName`? Accepts both the canonical
 * `<branch>/NNNNNN.jsonl` layout and the pre-`migrate-layout` flat one at the
 * branch root, for the same reason `listBranchFiles` reads both: an unmigrated
 * cortex still holds real data there.
 */
function isL1PagePath(branchName: string, filePath: string): boolean {
  const prefix = `${branchName}/`;
  if (filePath.startsWith(prefix)) return L1_PAGE_BASENAME.test(filePath.slice(prefix.length));
  return L1_PAGE_BASENAME.test(filePath);
}

/** Resolve a ref to its object name, or null when it does not exist. */
function resolveRef(ref: string): string | null {
  let out: string;
  try {
    out = runGit(['rev-parse', '--verify', '--quiet', ref]);
  } catch {
    return null; // `--quiet` exits 1 on a missing ref
  }
  return GIT_OID.test(out) ? out : null;
}

/** One commit's parents and subject, read from the raw object. */
interface CommitMeta {
  sha: string;
  subject: string;
}

/**
 * Parse `git rev-list --format=%x01%H%x00%s` output.
 *
 * rev-list prefixes every record with its own `commit <sha>` header line and
 * there is no portable way to suppress it (`--no-commit-header` is git 2.33+),
 * so the format opens each record with a `\x01` sentinel: splitting on it
 * discards the headers, and the first chunk (everything before the first
 * sentinel) with them. Within a record, `\x00` separates the object name from
 * the subject, and the subject — `%s`, always a single line — ends at the
 * newline rev-list appends.
 *
 * Returns null on anything that does not match that shape, which callers treat
 * as "cannot reason about this branch" rather than as "no salvage commit".
 */
function parseRevListSubjects(out: Buffer): CommitMeta[] | null {
  const commits: CommitMeta[] = [];
  const records = out.toString('utf-8').split('\x01');
  for (const record of records.slice(1)) {
    const line = record.split('\n', 1)[0] ?? '';
    const sep = line.indexOf('\x00');
    if (sep === -1) return null;
    const sha = line.slice(0, sep);
    if (!GIT_OID.test(sha)) return null;
    commits.push({ sha, subject: line.slice(sep + 1) });
  }
  return commits;
}

/** Parse `--name-status -z` diff output: repeated `<status>\0<path>\0`. */
function parseNameStatusZ(out: Buffer): Array<{ status: string; path: string }> | null {
  const fields = out.toString('utf-8').split('\0');
  const entries: Array<{ status: string; path: string }> = [];
  let i = 0;
  while (i < fields.length) {
    const status = fields[i];
    if (status === undefined || status === '') break; // trailing separator
    const filePath = fields[i + 1];
    // `--no-renames` at every call site keeps statuses to a single letter, so a
    // multi-character status (`R100`) or a missing path means the output is not
    // the shape we are parsing and nothing here may be acted on.
    if (!filePath || status.length !== 1) return null;
    entries.push({ status, path: filePath });
    i += 2;
  }
  return entries;
}

/** Parse `git ls-tree -r -z`: repeated `<mode> <type> <sha>\t<path>\0`. */
function parseLsTreeZ(out: Buffer): Array<{ sha: string; path: string }> | null {
  const entries: Array<{ sha: string; path: string }> = [];
  for (const record of out.toString('utf-8').split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    if (tab === -1) return null;
    const meta = record.slice(0, tab).split(' ');
    if (meta.length !== 3) return null;
    const [, type, sha] = meta;
    if (type !== 'blob') continue; // `-r` already flattens trees; submodules are not pages
    if (!GIT_OID.test(sha)) return null;
    entries.push({ sha, path: record.slice(tab + 1) });
  }
  return entries;
}

/** One local-only salvage commit and the L1 pages its diff deletes. */
export interface SalvageCommitFinding {
  sha: string;
  subject: string;
  /** Whole pages the commit deletes — `D` entries, not deleted lines. */
  deletedPages: string[];
}

/** What `planSalvageCommitRepair` knows about one local cortex branch. */
export interface CortexSalvagePlan {
  branch: string;
  /** Tip of `refs/heads/<branch>`. */
  localTip: string;
  /**
   * Tip of `refs/remotes/origin/<branch>`, or null when this clone has no such
   * ref. Null is the "no upstream" case: nothing on the branch is provably
   * pushed, and there is nothing to reset to — so the branch is reported but
   * never repaired.
   */
  originTip: string | null;
  /** `origin/<branch>..<branch>`, newest first — or the whole branch when
   *  `originTip` is null, since then nothing on it is known to be on origin. */
  localOnlyCommits: string[];
  /** The subset of `localOnlyCommits` that is a page-deleting salvage commit. */
  salvageCommits: SalvageCommitFinding[];
}

/**
 * Read-only: does `branchName` carry an unpushed, page-deleting salvage commit?
 *
 * Purely local — it reads `refs/remotes/origin/<branch>` as last fetched and
 * makes no network call, so `think doctor` stays offline-safe and cheap. The
 * repair fetches before it resets; a stale remote-tracking ref can therefore
 * only make this under-report, never over-report.
 *
 * Returns null when there is no local ref for the branch (nothing to inspect).
 * Throws only when git itself could not be questioned — callers report that as
 * a warning rather than converting it into a clean bill of health.
 */
export function planSalvageCommitRepair(branchName: string): CortexSalvagePlan | null {
  assertSafePositional(branchName, 'branch name');
  const localTip = resolveRef(`refs/heads/${branchName}`);
  if (localTip === null) return null;
  const originTip = resolveRef(`refs/remotes/origin/${branchName}`);

  // With an upstream, "unpushed" is the range. Without one, every commit on the
  // branch is unpushed by definition — the clone has never seen this branch on
  // origin, so nothing on it is known to be anywhere else.
  const range = originTip === null ? branchName : `${originTip}..${localTip}`;
  const commits = parseRevListSubjects(
    runGitBuffer(['rev-list', '--format=%x01%H%x00%s', range, '--']),
  );
  if (commits === null) {
    throw new Error(`Could not read the commit list for ${branchName}.`);
  }

  const salvageCommits: SalvageCommitFinding[] = [];
  for (const commit of commits) {
    if (!isSalvageCommitSubject(commit.subject)) continue;
    const deletedPages = deletedPagesInCommit(branchName, commit.sha);
    // The subject alone is not the bug: a salvage commit that carries a genuine
    // in-flight append (AGT-1299's AC3 outcome) is a legitimate commit and must
    // not be reported. Only one that DELETES whole pages is the inversion.
    if (deletedPages.length > 0) {
      salvageCommits.push({ sha: commit.sha, subject: commit.subject, deletedPages });
    }
  }

  return {
    branch: branchName,
    localTip,
    originTip,
    localOnlyCommits: commits.map((commit) => commit.sha),
    salvageCommits,
  };
}

/**
 * The whole L1 pages `sha` deletes relative to its parent. Empty for a merge
 * or a root commit: neither has a single parent to diff against, so we decline
 * to guess rather than reading a two-parent diff as evidence of deletion.
 */
function deletedPagesInCommit(branchName: string, sha: string): string[] {
  const parents = runGit(['rev-list', '--parents', '-n', '1', sha, '--'])
    .split(' ')
    .slice(1)
    .filter((parent) => GIT_OID.test(parent));
  if (parents.length !== 1) return [];
  const entries = parseNameStatusZ(
    runGitBuffer(['diff-tree', '-r', '-z', '--no-renames', '--name-status', parents[0], sha, '--']),
  );
  if (entries === null) return [];
  return entries
    .filter((entry) => entry.status === 'D' && isL1PagePath(branchName, entry.path))
    .map((entry) => entry.path);
}

/** One L1 entry recovered from a page blob, with the bytes it was stored as. */
export interface RecoveredEntry {
  id: string;
  /** The JSONL line verbatim, WITHOUT its trailing newline — the exact shape
   *  `l1_outbox.line` holds and `appendRawLineToL1Page` writes back. */
  line: string;
  /** The entry's own `ts`, so a re-queued row keeps its original timestamp. */
  ts: string;
}

/**
 * What only local history holds, and what the reset would therefore discard —
 * or the reason no such proof could be built, which is always a refusal to
 * reset rather than a reason to proceed.
 */
export type LocalOnlyEntryPlan =
  | {
      ok: true;
      /** Entries reachable from the local-only commits (and, when the branch is
       *  checked out, the worktree) that are NOT in the pages at
       *  `origin/<branch>`. */
      entries: RecoveredEntry[];
      /** How many distinct local entry ids origin already holds. */
      presentOnOrigin: number;
      /** Whether `branchName` is the branch the shared worktree is parked on. */
      checkedOut: boolean;
    }
  | { ok: false; reason: string };

/**
 * Read-only: everything the reset would drop, so the caller can make sure it
 * is not dropped. THE LOSSLESSNESS PROOF FOR AGT-1310 AC2 LIVES HERE.
 *
 * The set is deliberately a superset of "added by the local-only commits":
 * every entry in every L1 page of every local-only commit's tree, minus every
 * entry id present at `origin/<branch>`. Computing it from trees rather than
 * from diffs means it needs no parent arithmetic, is unaffected by merges, and
 * cannot miss an entry that a later local commit deleted again — which matters
 * precisely here, because the commit we are undoing deletes pages.
 *
 * When the branch is the checked-out one the worktree is included too: any
 * tracked path that differs from HEAD is read and its entries counted, so an
 * in-flight append that no commit holds yet is covered by the same proof.
 *
 * Refuses — `{ ok: false }`, never "nothing to lose" — when:
 *  - there is no local ref, or no `origin/<branch>` to reset to;
 *  - a page blob holds a line that is not JSON with a string `id` (we cannot
 *    say whether origin has it, so we must not discard it);
 *  - the checked-out worktree differs from HEAD at a path that is not an L1
 *    page, since `git reset --hard` would discard that edit and this function
 *    can say nothing about it.
 */
export function planLocalOnlyEntries(branchName: string): LocalOnlyEntryPlan {
  const plan = planSalvageCommitRepair(branchName);
  if (plan === null) {
    return { ok: false, reason: `no local ref refs/heads/${branchName}` };
  }
  if (plan.originTip === null) {
    return { ok: false, reason: `no upstream origin/${branchName} to reset to` };
  }

  const originEntries = readEntriesAtRev(branchName, plan.originTip);
  if (originEntries === null) {
    return { ok: false, reason: `could not read the L1 pages at origin/${branchName}` };
  }
  const originIds = new Set(originEntries.keys());

  const entries = new Map<string, RecoveredEntry>();
  // Distinct ids, not sightings: the same entry appears in every commit's tree
  // that still holds its page, and counting those again per commit would make
  // the repair's report read as many times the data there is.
  const alreadyOnOrigin = new Set<string>();
  const collect = (recovered: Map<string, RecoveredEntry>): void => {
    for (const [id, entry] of recovered) {
      if (originIds.has(id)) {
        alreadyOnOrigin.add(id);
        continue;
      }
      // First sighting wins: identical ids across commits are the same entry,
      // and the oldest blob holding it is the one closest to how it was written.
      if (!entries.has(id)) entries.set(id, entry);
    }
  };

  // Oldest commit first, so `entries` reads in the order the entries were made.
  for (const sha of [...plan.localOnlyCommits].reverse()) {
    const recovered = readEntriesAtRev(branchName, sha);
    if (recovered === null) {
      return { ok: false, reason: `could not read the L1 pages at ${sha.slice(0, 8)}` };
    }
    collect(recovered);
  }

  const checkedOut = getCurrentBranch() === branchName;
  if (checkedOut) {
    const fromWorktree = readDirtyWorktreeEntries(branchName);
    if (fromWorktree === null) {
      return {
        ok: false,
        reason:
          `the worktree is on ${branchName} and differs from HEAD outside its L1 pages — ` +
          `a reset would discard an edit this check cannot account for`,
      };
    }
    collect(fromWorktree);
  }

  return {
    ok: true,
    entries: [...entries.values()],
    presentOnOrigin: alreadyOnOrigin.size,
    checkedOut,
  };
}

/**
 * Every L1 entry in every page of `rev`'s tree, keyed by id. Blobs are read
 * once per object name, so pages a run of commits left untouched (the common
 * case) cost one `cat-file` between them all.
 *
 * Returns null if any line is not a JSON object carrying a string `id`.
 */
function readEntriesAtRev(branchName: string, rev: string): Map<string, RecoveredEntry> | null {
  if (!GIT_OID.test(rev)) return null;
  const tree = parseLsTreeZ(runGitBuffer(['ls-tree', '-r', '-z', rev, '--']));
  if (tree === null) return null;

  const entries = new Map<string, RecoveredEntry>();
  const seenBlobs = new Set<string>();
  for (const entry of tree) {
    if (!isL1PagePath(branchName, entry.path)) continue;
    if (seenBlobs.has(entry.sha)) continue;
    seenBlobs.add(entry.sha);
    const recovered = parseJsonlPage(catBlob(entry.sha).toString('utf-8'));
    if (recovered === null) return null;
    for (const [id, value] of recovered) if (!entries.has(id)) entries.set(id, value);
  }
  return entries;
}

/**
 * Every L1 entry in the checked-out worktree's pages that differ from HEAD.
 * Paths that match HEAD are skipped: their entries are already in the tip
 * tree, which `planLocalOnlyEntries` has read.
 *
 * Returns null when a differing path is not an L1 page — see that function's
 * contract. A differing path that no longer exists on disk contributes nothing.
 */
function readDirtyWorktreeEntries(branchName: string): Map<string, RecoveredEntry> | null {
  const changed = runGitBuffer(['diff-index', '-z', '--name-only', 'HEAD', '--'])
    .toString('utf-8')
    .split('\0')
    .filter((filePath) => filePath !== '');

  const entries = new Map<string, RecoveredEntry>();
  for (const filePath of changed) {
    if (!isL1PagePath(branchName, filePath)) return null;
    const absPath = resolveInsideRepo(filePath);
    if (absPath === null) return null;
    let raw: string;
    try {
      raw = fs.readFileSync(absPath, 'utf-8');
    } catch {
      continue; // deleted in the worktree — it holds nothing to lose
    }
    const recovered = parseJsonlPage(raw);
    if (recovered === null) return null;
    for (const [id, value] of recovered) if (!entries.has(id)) entries.set(id, value);
  }
  return entries;
}

/**
 * Split one L1 page into entries keyed by id, keeping each line's exact bytes.
 * Returns null on a line that is not a JSON object with a string `id` — an
 * entry we cannot name is an entry we cannot prove is safe to discard.
 */
function parseJsonlPage(raw: string): Map<string, RecoveredEntry> | null {
  const entries = new Map<string, RecoveredEntry>();
  for (const line of raw.split('\n')) {
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { id, ts } = parsed as { id?: unknown; ts?: unknown };
    if (typeof id !== 'string' || id === '') return null;
    entries.set(id, { id, line, ts: typeof ts === 'string' ? ts : new Date().toISOString() });
  }
  return entries;
}

/**
 * Move `refs/heads/<branch>` back to `refs/remotes/origin/<branch>`.
 *
 * MUTATING, and the caller owns the proof: this discards every local-only
 * commit on the branch. `lib/salvage-repair.ts` is the only caller and it runs
 * `planLocalOnlyEntries` first, re-queueing anything origin does not already
 * hold. Nothing else should call it.
 *
 * `update-ref` with an old-value argument is the plumbing writer's
 * compare-and-swap convention (`lib/git-plumbing.ts`): if the daemon advanced
 * the branch between the plan and here, the ref move fails loudly instead of
 * clobbering the newer tip.
 *
 * When the branch is the checked-out one, HEAD has just moved BACKWARDS, so
 * the index is now ahead of it rather than behind — the direction AGT-1299's
 * `reconcilePlumbingStaleIndex` is built to prove and therefore cannot help
 * with here (its prefix proof would fail and leave the stale index in place,
 * the one outcome this repair must not produce). `reset --hard HEAD` — the
 * same mutation that function performs once its own proof holds — brings the
 * index and worktree to the new HEAD, licensed by the entry-level proof
 * `planLocalOnlyEntries` has already established over both.
 *
 * @returns false when the branch was already at the origin tip.
 */
export function resetCortexBranchToOrigin(branchName: string): boolean {
  assertSafePositional(branchName, 'branch name');
  const localTip = resolveRef(`refs/heads/${branchName}`);
  const originTip = resolveRef(`refs/remotes/origin/${branchName}`);
  if (localTip === null || originTip === null) {
    throw new Error(`Cannot reset ${branchName}: no local ref, or no origin/${branchName}.`);
  }
  if (localTip === originTip) return false;

  runGit(['update-ref', `refs/heads/${branchName}`, originTip, localTip]);
  if (getCurrentBranch() === branchName) {
    runGit(['reset', '--hard', 'HEAD']);
  }
  return true;
}

/**
 * Idempotently switch the working tree to `branchName` and fast-forward it
 * toward `origin/<branchName>` when the local ref is behind.
 *
 * Logic:
 *  - If the local branch ref exists: `git switch <branch>`, then attempt a
 *    `git merge --ff-only origin/<branch>` to advance it. The ff-only step
 *    is a no-op when already up to date and fails loudly (rather than
 *    clobbering) when histories have diverged — satisfying AC 4 (behind) and
 *    AC 6 (no data loss on divergence). The error is swallowed only for the
 *    "unborn upstream" and "not possible to fast-forward" cases; an unrelated
 *    git failure still propagates.
 *  - If the local branch ref does NOT exist: `git switch -c <branch> --
 *    origin/<branch>` (the original create path).
 *
 * Guards:
 *  - No-op when the working tree is already on the target branch (fast path).
 *  - No-op when there is no `.git` directory (test fixtures / local-fs backend).
 *  - `assertSafePositional` is called before any git command.
 */
export function ensureOnBranch(branchName: string): void {
  assertSafePositional(branchName, 'branch name');
  if (!fs.existsSync(path.join(getRepoPath(), '.git'))) return;
  if (getCurrentBranch() === branchName) {
    // Already on the correct branch — salvage any leftover dirt first so the
    // ff-only below isn't blocked by a tree a prior cycle left uncommitted
    // ("local changes would be overwritten by merge"), then try to ff-only in
    // case we drifted behind origin during a long daemon session.
    salvageDirtyWorktree();
    tryFfOnly(branchName);
    return;
  }
  // A dirty tree here belongs to the branch we're about to leave; commit it
  // before switching so `git switch` doesn't refuse the checkout. Without this,
  // one stuck file wedges branch switching for every cortex (#69).
  salvageDirtyWorktree();
  if (localBranchExists(branchName)) {
    runGit(['switch', '--', branchName]);
    tryFfOnly(branchName);
  } else {
    // Branch absent locally — create it from origin.
    // `git switch -c <new> <start-point>`: -c consumes the next arg as the
    // new branch name. We can't put `--` between -c and its arg. Validated
    // via assertSafePositional above.
    runGit(['switch', '-c', branchName, '--', `origin/${branchName}`]);
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
  // Born union-merged: stamp `.gitattributes` into the very first commit so
  // every clone of this cortex inherits lossless concurrent-append merging
  // without a later migration. See `ensureUnionMergeAttribute`.
  fs.writeFileSync(path.join(repoPath, '.gitattributes'), UNION_MERGE_ATTRIBUTE + '\n', 'utf-8');
  runGit(['add', '--', `${branchName}/000001.jsonl`, '.gitattributes']);
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
 *
 * Note: unlike the old implementation, this now delegates to `ensureOnBranch`
 * and will attempt a `merge --ff-only` even when the branch is already
 * checked out. The extra git I/O is intentional — it keeps long-lived daemon
 * sessions from falling behind `origin` silently between retro writes.
 */
export function ensureBranchCheckedOut(branchName: string): void {
  ensureOnBranch(branchName);
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

  ensureOnBranch(branchName);

  // Stamp the union merge driver before the rebase so a divergent page
  // reconciles losslessly instead of throwing a conflict. Self-heals any
  // pre-existing branch that pre-dates this attribute; no-op once present.
  ensureUnionMergeAttribute(branchName);

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

  ensureOnBranch(branchName);

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
