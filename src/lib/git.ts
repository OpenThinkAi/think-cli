import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getRepoPath } from './paths.js';
import { getConfig } from './config.js';

function runGit(args: string[], cwd?: string): string {
  const repoPath = cwd ?? getRepoPath();
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

export function ensureRepoCloned(): void {
  const config = getConfig();
  if (!config.cortex?.repo) {
    throw new Error('No cortex repo configured. Run: think cortex setup');
  }

  const repoPath = getRepoPath();

  if (fs.existsSync(path.join(repoPath, '.git'))) {
    const remote = runGit(['remote', 'get-url', 'origin'], repoPath);
    if (remote !== config.cortex.repo) {
      throw new Error(`Repo at ${repoPath} points to ${remote}, expected ${config.cortex.repo}`);
    }
    return;
  }

  fs.mkdirSync(repoPath, { recursive: true });
  execFileSync('git', ['clone', '--no-checkout', config.cortex.repo, repoPath], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function branchExists(branchName: string): boolean {
  try {
    runGit(['ls-remote', '--exit-code', '--heads', 'origin', branchName]);
    return true;
  } catch {
    return false;
  }
}

export function createOrphanBranch(branchName: string): void {
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
  runGit(['push', '--set-upstream', 'origin', branchName]);
}

export function fetchBranch(branchName: string): void {
  runGit(['fetch', 'origin', branchName]);
}

export function readFileFromBranch(branchName: string, filePath: string): string | null {
  try {
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
  const repoPath = getRepoPath();
  const filePath = path.join(repoPath, targetFile);

  try {
    runGit(['switch', branchName]);
  } catch {
    runGit(['switch', '-c', branchName, `origin/${branchName}`]);
  }

  try {
    runGit(['pull', '--rebase', 'origin', branchName]);
  } catch (err) {
    // Acceptable: fails when local branch has no upstream yet (first push)
    // Not acceptable: rebase conflict — abort and surface the error
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('CONFLICT') || message.includes('could not apply')) {
      try { runGit(['rebase', '--abort']); } catch { /* best effort */ }
      throw new Error(`Rebase conflict on ${branchName}. This should not happen with append-only files.`);
    }
  }

  const content = newLines.join('\n') + '\n';
  fs.appendFileSync(filePath, content, 'utf-8');

  runGit(['add', targetFile]);
  runGit(['commit', '-m', commitMessage]);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      runGit(['push', 'origin', branchName]);
      return;
    } catch {
      if (attempt === maxRetries) {
        throw new Error(`Push failed after ${maxRetries} attempts. Run 'think curate' again.`);
      }
      runGit(['pull', '--rebase', 'origin', branchName]);
    }
  }
}

export function getFileLog(branchName: string, filePath: string): string {
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

export function countBranchFileLines(branchName: string, filePath: string): number {
  const content = readFileFromBranch(branchName, filePath);
  if (!content) return 0;
  return content.trim().split('\n').filter(Boolean).length;
}

export function migrateToBuckets(branchName: string): void {
  const repoPath = getRepoPath();

  try { runGit(['switch', branchName]); }
  catch { runGit(['switch', '-c', branchName, `origin/${branchName}`]); }

  try { runGit(['pull', '--rebase', 'origin', branchName]); }
  catch { /* same as appendAndCommit — tolerate upstream issues */ }

  const legacyPath = path.join(repoPath, 'memories.jsonl');
  const bucketPath = path.join(repoPath, '000001.jsonl');

  if (fs.existsSync(legacyPath) && !fs.existsSync(bucketPath)) {
    fs.renameSync(legacyPath, bucketPath);
    runGit(['add', '-A']);
    runGit(['commit', '-m', 'migrate: memories.jsonl -> 000001.jsonl']);

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        runGit(['push', 'origin', branchName]);
        return;
      } catch {
        if (attempt === 3) {
          // Rollback local commit to avoid diverged state
          try { runGit(['reset', 'HEAD~1']); } catch { /* best effort */ }
          throw new Error('Migration push failed after 3 attempts — local commit rolled back');
        }
        runGit(['pull', '--rebase', 'origin', branchName]);
      }
    }
  }
}
