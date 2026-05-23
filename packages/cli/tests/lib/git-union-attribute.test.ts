import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  UNION_MERGE_ATTRIBUTE,
  withUnionMergeAttribute,
  ensureLocalUnionMergeAttribute,
} from '../../src/lib/git.js';

// Pure-function coverage for the `.gitattributes` union-merge helper. The
// committed-side I/O wrapper (`ensureUnionMergeAttribute`, `createOrphanBranch`)
// is exercised through the git-adapter / push-debouncer integration paths;
// this pins the content-shaping logic that both the sync and async write paths
// share, so they can't drift into emitting different `.gitattributes` bytes.
// `ensureLocalUnionMergeAttribute` (the `.git/info/attributes` half) gets
// direct fs coverage below since it's the load-bearing bootstrap fix.

describe('withUnionMergeAttribute', () => {
  it('adds the union line to an empty file', () => {
    expect(withUnionMergeAttribute('')).toBe(`${UNION_MERGE_ATTRIBUTE}\n`);
  });

  it('returns null when the line is already present (idempotent)', () => {
    expect(withUnionMergeAttribute(`${UNION_MERGE_ATTRIBUTE}\n`)).toBeNull();
  });

  it('returns null even when the line has surrounding whitespace', () => {
    expect(withUnionMergeAttribute(`  ${UNION_MERGE_ATTRIBUTE}  \n`)).toBeNull();
  });

  it('appends to existing unrelated attributes, preserving them', () => {
    const existing = '*.png binary\n*.md text\n';
    const result = withUnionMergeAttribute(existing);
    expect(result).toBe(`${existing}${UNION_MERGE_ATTRIBUTE}\n`);
  });

  it('inserts a separating newline when the existing content lacks a trailing one', () => {
    const existing = '*.png binary'; // no trailing newline
    const result = withUnionMergeAttribute(existing);
    expect(result).toBe(`*.png binary\n${UNION_MERGE_ATTRIBUTE}\n`);
  });

  it('does not duplicate when the line is among other attributes', () => {
    const existing = `*.png binary\n${UNION_MERGE_ATTRIBUTE}\n*.md text\n`;
    expect(withUnionMergeAttribute(existing)).toBeNull();
  });
});

describe('ensureLocalUnionMergeAttribute', () => {
  let prevThinkHome: string | undefined;
  let tmpHome: string;
  let repoPath: string;

  beforeEach(() => {
    prevThinkHome = process.env.THINK_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'think-localattr-'));
    process.env.THINK_HOME = tmpHome;
    repoPath = path.join(tmpHome, 'repo');
    fs.mkdirSync(repoPath, { recursive: true });
  });

  afterEach(() => {
    if (prevThinkHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = prevThinkHome;
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it('writes .git/info/attributes (creating the info dir) when .git is a directory', () => {
    fs.mkdirSync(path.join(repoPath, '.git'), { recursive: true });
    ensureLocalUnionMergeAttribute();
    const content = fs.readFileSync(path.join(repoPath, '.git', 'info', 'attributes'), 'utf-8');
    expect(content).toContain(UNION_MERGE_ATTRIBUTE);
    // It writes the LOCAL file, not a committed .gitattributes at repo root.
    expect(fs.existsSync(path.join(repoPath, '.gitattributes'))).toBe(false);
  });

  it('is idempotent — does not duplicate the line on repeat calls', () => {
    fs.mkdirSync(path.join(repoPath, '.git'), { recursive: true });
    ensureLocalUnionMergeAttribute();
    ensureLocalUnionMergeAttribute();
    const content = fs.readFileSync(path.join(repoPath, '.git', 'info', 'attributes'), 'utf-8');
    const occurrences = content.split('\n').filter((l) => l.trim() === UNION_MERGE_ATTRIBUTE).length;
    expect(occurrences).toBe(1);
  });

  it('preserves pre-existing local attributes', () => {
    const infoDir = path.join(repoPath, '.git', 'info');
    fs.mkdirSync(infoDir, { recursive: true });
    fs.writeFileSync(path.join(infoDir, 'attributes'), '*.bin -text\n', 'utf-8');
    ensureLocalUnionMergeAttribute();
    const content = fs.readFileSync(path.join(infoDir, 'attributes'), 'utf-8');
    expect(content).toContain('*.bin -text');
    expect(content).toContain(UNION_MERGE_ATTRIBUTE);
  });

  it('is a no-op when there is no .git (test fixtures / local-fs backend)', () => {
    // No .git created.
    expect(() => ensureLocalUnionMergeAttribute()).not.toThrow();
    expect(fs.existsSync(path.join(repoPath, '.git'))).toBe(false);
  });

  it('is a no-op when .git is a file (worktree) rather than a directory', () => {
    fs.writeFileSync(path.join(repoPath, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n', 'utf-8');
    expect(() => ensureLocalUnionMergeAttribute()).not.toThrow();
    // Must not have tried to create an info/ dir under the .git *file*.
    expect(fs.existsSync(path.join(repoPath, '.git', 'info'))).toBe(false);
  });
});
