/**
 * Tests for lib/working-context — iterative-learning v3 (retro locality).
 *
 * Verifies:
 *  1. normalizeContext lowercases/trims and rejects empty.
 *  2. contextTopic / contextFromTopics round-trip via the repo: prefix.
 *  3. contextFromTopics ignores non-prefixed and non-string topics.
 *  4. detectWorkingContext returns the git-root basename inside a repo and
 *     null outside one.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeContext,
  contextTopic,
  contextFromTopics,
  detectWorkingContext,
  CONTEXT_TOPIC_PREFIX,
} from '../../src/lib/working-context.js';

describe('working-context pure helpers', () => {
  it('normalizeContext lowercases, trims, and rejects empty', () => {
    expect(normalizeContext('  Stamp-CLI  ')).toBe('stamp-cli');
    expect(normalizeContext('think-cli')).toBe('think-cli');
    expect(normalizeContext('   ')).toBeNull();
    expect(normalizeContext('')).toBeNull();
  });

  it('contextTopic encodes with the repo: prefix', () => {
    expect(contextTopic('stamp-cli')).toBe('repo:stamp-cli');
    expect(contextTopic('Think-CLI')).toBe('repo:think-cli');
    expect(CONTEXT_TOPIC_PREFIX).toBe('repo:');
  });

  it('contextFromTopics extracts the prefixed context, case-insensitively', () => {
    expect(contextFromTopics(['ux', 'repo:stamp-cli'])).toBe('stamp-cli');
    expect(contextFromTopics(['Repo:Think-CLI'])).toBe('think-cli');
    expect(contextFromTopics(['ux', 'auth'])).toBeNull();
    expect(contextFromTopics([])).toBeNull();
    // first repo: wins
    expect(contextFromTopics(['repo:a', 'repo:b'])).toBe('a');
  });

  it('contextFromTopics tolerates non-string entries', () => {
    // @ts-expect-error — exercising defensive runtime guard
    expect(contextFromTopics([null, 42, 'repo:x'])).toBe('x');
  });

  it('round-trips contextTopic → contextFromTopics', () => {
    const t = contextTopic('My-Repo');
    expect(contextFromTopics([t])).toBe('my-repo');
  });
});

describe('detectWorkingContext', () => {
  let repoDir: string;
  let nonRepoDir: string;

  beforeAll(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'think-wc-'));
    repoDir = path.join(base, 'My-Sample-Repo');
    nonRepoDir = path.join(base, 'plain');
    fs.mkdirSync(repoDir);
    fs.mkdirSync(nonRepoDir);
    execSync('git init -q', { cwd: repoDir, stdio: 'ignore' });
  });

  afterAll(() => {
    try { fs.rmSync(path.dirname(repoDir), { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('returns the lowercased git-root basename inside a repo', () => {
    expect(detectWorkingContext(repoDir)).toBe('my-sample-repo');
  });

  it('returns the repo basename from a nested subdirectory', () => {
    const nested = path.join(repoDir, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    expect(detectWorkingContext(nested)).toBe('my-sample-repo');
  });

  it('returns null outside any git repo', () => {
    expect(detectWorkingContext(nonRepoDir)).toBeNull();
  });
});
