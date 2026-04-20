import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getRepoPath } from './paths.js';
import { getConfig } from './config.js';

// Sanitized environment for git subprocesses — strips variables that could
// alter git behavior (hook injection, credential interception, path redirection)
function safeGitEnv(): NodeJS.ProcessEnv {
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
    throw new Error(
      `Invalid ${fieldName}: "${value}" starts with '-'. ` +
        `Values passed to git as positional arguments cannot begin with a hyphen.`,
    );
  }
}

// Pull --rebase with explicit conflict handling — aborts the rebase on
// conflict so the working tree doesn't linger in a rebase-in-progress state
// across retry attempts. Append-only files shouldn't produce conflicts in
// practice, but both call sites (initial pull + retry-loop pull) need the
// same behavior.
//
// Re-validates branchName here as defense-in-depth even though every
// current caller validates first. Future callers could forget the contract,
// and the cost of the redundant check is negligible. The inner `--`
// separator already defangs a leading-hyphen branchName at the git argv
// boundary, so this assertion mostly improves error specificity (named
// field vs opaque git error).
//
// Tolerates only the no-upstream / first-push case by matching git's own
// error text. Network failures, auth errors, and other unexpected git
// failures surface — an earlier revision of this helper swallowed every
// non-CONFLICT error, which silently masked real problems and produced
// confusing downstream push failures.
function pullRebaseOrAbort(branchName: string): void {
  assertSafePositional(branchName, 'branchName');
  try {
    runGit(['pull', '--rebase', 'origin', '--', branchName]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('CONFLICT') || message.includes('could not apply')) {
      try { runGit(['rebase', '--abort']); } catch { /* best effort */ }
      throw new Error(`Rebase conflict on ${branchName}. This should not happen with append-only files.`);
    }
    // Acceptable: the remote branch doesn't exist yet (first push), or the
    // local branch has no tracking information. git prints these specific
    // strings; anything else is a real failure worth surfacing.
    if (
      message.includes("Couldn't find remote ref") ||
      message.includes("couldn't find remote ref") ||
      message.includes('no tracking information')
    ) {
      return;
    }
    throw new Error(`git pull --rebase failed on ${branchName}: ${message}`);
  }
}

export function ensureRepoCloned(): void {
  const config = getConfig();
  if (!config.cortex?.repo) {
    throw new Error('No cortex repo configured. Run: think cortex setup');
  }
  // Read-time validation — config.json tampering that injected a leading
  // '-' into cortex.repo would otherwise get interpreted by git as a flag
  // (e.g. '--upload-pack=<cmd>' → RCE).
  assertSafePositional(config.cortex.repo, 'cortex.repo');

  const repoPath = getRepoPath();

  if (fs.existsSync(path.join(repoPath, '.git'))) {
    const remote = runGit(['remote', 'get-url', 'origin'], repoPath);
    if (remote !== config.cortex.repo) {
      throw new Error(`Repo at ${repoPath} points to ${remote}, expected ${config.cortex.repo}`);
    }
    return;
  }

  fs.mkdirSync(repoPath, { recursive: true });
  // Both args after `--` are positionals: config.cortex.repo (validated above
  // via assertSafePositional) and repoPath. repoPath is constructed by
  // getRepoPath() from THINK_HOME / HOME — fully internally derived, no user
  // input flows into it, so it doesn't need a separate validator.
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=', 'clone', '--no-checkout', '--', config.cortex.repo, repoPath], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: safeGitEnv(),
  });
}

export function branchExists(branchName: string): boolean {
  assertSafePositional(branchName, 'branchName');
  try {
    runGit(['ls-remote', '--exit-code', '--heads', 'origin', '--', branchName]);
    return true;
  } catch {
    return false;
  }
}

export function createOrphanBranch(branchName: string): void {
  assertSafePositional(branchName, 'branchName');
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

  const repoPath = getRepoPath();
  fs.writeFileSync(path.join(repoPath, '000001.jsonl'), '', 'utf-8');
  runGit(['add', '000001.jsonl']);
  runGit(['commit', '-m', `init: create cortex ${branchName}`]);
  runGit(['push', '--set-upstream', 'origin', '--', branchName]);
}

export function fetchBranch(branchName: string): void {
  assertSafePositional(branchName, 'branchName');
  runGit(['fetch', 'origin', '--', branchName]);
}

export function readFileFromBranch(branchName: string, filePath: string): string | null {
  assertSafePositional(branchName, 'branchName');
  try {
    // `show` takes a single composed ref:path argument, so `--` doesn't help
    // here. assertSafePositional on branchName handles the leading-hyphen
    // concern; filePath is repo-internal and fully controlled by callers.
    return runGit(['show', `origin/${branchName}:${filePath}`]);
  } catch {
    return null;
  }
}

export function appendAndCommit(
  branchName: string,
  newLines: string[],
  commitMessage: string,
  maxRetries: number = 3,
  targetFile: string = 'memories.jsonl',
): void {
  assertSafePositional(branchName, 'branchName');
  const repoPath = getRepoPath();
  const filePath = path.join(repoPath, targetFile);

  try {
    runGit(['switch', '--', branchName]);
  } catch {
    // `git switch -c <new> <start-point>`: -c consumes the next arg as the
    // new branch name. We can't put `--` between -c and its arg. Validated
    // via assertSafePositional above.
    runGit(['switch', '-c', branchName, '--', `origin/${branchName}`]);
  }

  pullRebaseOrAbort(branchName);

  const content = newLines.join('\n') + '\n';
  fs.appendFileSync(filePath, content, 'utf-8');

  runGit(['add', targetFile]);
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
  assertSafePositional(branchName, 'branchName');
  return runGit(['log', '--oneline', `origin/${branchName}`, '--', filePath]);
}

export function listRemoteBranches(): string[] {
  const output = runGit(['ls-remote', '--heads', 'origin']);
  return output.trim().split('\n')
    .filter(Boolean)
    .map(line => line.split('\t')[1]?.replace('refs/heads/', ''))
    .filter(Boolean) as string[];
}

export function listBranchFiles(branchName: string, extension?: string): string[] {
  assertSafePositional(branchName, 'branchName');
  try {
    // `origin/${branchName}` is a composed ref, not a positional that git
    // would parse as a flag — a ref like `origin/--foo` is a ref name, not
    // a --foo option. assertSafePositional still guards the leading-hyphen
    // case for defense in depth.
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

export function countBranchFileLines(branchName: string, filePath: string): number {
  const content = readFileFromBranch(branchName, filePath);
  if (!content) return 0;
  return content.trim().split('\n').filter(Boolean).length;
}

export function migrateToBuckets(branchName: string): void {
  assertSafePositional(branchName, 'branchName');
  const repoPath = getRepoPath();

  try { runGit(['switch', '--', branchName]); }
  catch { runGit(['switch', '-c', branchName, '--', `origin/${branchName}`]); }

  // pull --rebase updates local branch pointer + working tree from remote.
  // Caller already called fetchBranch (updates remote refs), so this pull
  // is fast. appendAndCommit also does pull --rebase, but that's a no-op
  // if nothing changed between migration and append. The helper tolerates
  // first-push / no-upstream cases internally (prior inline catch
  // commented it as "tolerate upstream issues (e.g. first push)").
  pullRebaseOrAbort(branchName);

  const legacyPath = path.join(repoPath, 'memories.jsonl');
  const bucketPath = path.join(repoPath, '000001.jsonl');

  if (fs.existsSync(legacyPath) && !fs.existsSync(bucketPath)) {
    // Save pre-migration ref for rollback
    const preMigrationRef = runGit(['rev-parse', 'HEAD']);

    fs.renameSync(legacyPath, bucketPath);
    runGit(['add', '-A']);
    runGit(['commit', '-m', 'migrate: memories.jsonl -> 000001.jsonl']);

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        runGit(['push', 'origin', '--', branchName]);
        return;
      } catch {
        if (attempt === 3) {
          // Rollback to pre-migration commit. That commit has memories.jsonl
          // (the rename to 000001.jsonl happened after it), so --hard reset
          // restores memories.jsonl and removes 000001.jsonl from working tree.
          try { runGit(['reset', '--hard', preMigrationRef]); } catch { /* best effort */ }
          throw new Error('Migration push failed after 3 attempts — local commit rolled back');
        }
        pullRebaseOrAbort(branchName);
      }
    }
  }
}
