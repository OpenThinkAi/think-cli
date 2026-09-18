/**
 * Unit tests for checkRepoIndex() — AGT-1308 AC1/AC5, severity fixed by
 * AGT-1326 (a pure plumbing lag with no in-flight append at risk is a `pass`,
 * not a `fail`; only a genuine append sitting on a stale index is a `warn`).
 *
 * `repoPath` and the AGT-1299 planner are injected in every test, so nothing
 * here runs git against the real `~/.think/repo` and nothing here can mutate a
 * worktree: the planner is the read-only half by construction, and the check
 * only ever calls that half.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRepoIndex, REPO_INDEX_CHECK_ID } from '../../../src/lib/doctor/repo-index.js';

describe('checkRepoIndex (AGT-1308)', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), 'think-doctor-repo-'));
    mkdirSync(join(repoPath, '.git'));
  });

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  it('passes when there is no clone to inspect', () => {
    const missing = join(repoPath, 'nope');
    const result = checkRepoIndex({
      repoPath: missing,
      plan: () => {
        throw new Error('the planner must not run without a .git directory');
      },
    });

    expect(result.status).toBe('pass');
    expect(result.detail).toContain(missing);
    expect(result.fixable).toBe(false);
  });

  it('passes when the planner finds nothing provably stale', () => {
    const result = checkRepoIndex({ repoPath, plan: () => null });

    expect(result).toEqual({
      id: REPO_INDEX_CHECK_ID,
      status: 'pass',
      detail: `Index in ${repoPath} is not behind HEAD.`,
      fixable: false,
    });
  });

  it('AGT-1326 state 1: passes, not fixable, for the pure stale state (nothing to restore)', () => {
    // Pure plumbing lag — the daemon advances HEAD every few seconds and by
    // design never touches the index. No genuine edit is at risk, so this is
    // a pass like any other check that found nothing wrong: nothing commits a
    // bare-stale index anymore, and AGT-1299's guard reconciles it whenever a
    // checkout needs the tree clean.
    const result = checkRepoIndex({ repoPath, plan: () => [] });

    expect(result.status).toBe('pass');
    expect(result.fixable).toBe(false);
    expect(result.detail).toContain(`Index in ${repoPath} lags the daemon's appends`);
    expect(result.detail).toContain('expected on 3.0');
    expect(result.detail).toContain('reconciled automatically when a checkout is needed');
  });

  it('AGT-1326 state 2: warns, fixable, when genuine in-flight appends sit on a stale index', () => {
    const result = checkRepoIndex({
      repoPath,
      plan: () => [
        { absPath: join(repoPath, 'personal', 'l1-0001.jsonl'), content: Buffer.from('x') },
        { absPath: join(repoPath, 'personal', 'l1-0002.jsonl'), content: Buffer.from('y') },
      ],
    });

    expect(result.status).toBe('warn');
    expect(result.fixable).toBe(true);
    expect(result.detail).toContain('2 in-flight worktree appends sit on a stale index');
    expect(result.detail).toContain('think doctor --fix');
    expect(result.detail).toContain('preserves every append');
  });

  it('AGT-1326 state 2: pluralizes the append count for a single restore', () => {
    const result = checkRepoIndex({
      repoPath,
      plan: () => [{ absPath: join(repoPath, 'personal', 'l1-0001.jsonl'), content: Buffer.from('x') }],
    });

    expect(result.status).toBe('warn');
    expect(result.fixable).toBe(true);
    expect(result.detail).toContain('1 in-flight worktree append sit on a stale index');
  });

  it('warns without offering a repair when git could not be questioned', () => {
    // The planner is read-only; a throw means git itself failed, and running
    // the mutating half on that basis would be exactly what AGT-1299 forbids.
    const result = checkRepoIndex({
      repoPath,
      plan: () => {
        throw new Error('unmerged index');
      },
    });

    expect(result.status).toBe('warn');
    expect(result.fixable).toBe(false);
    expect(result.detail).toContain('unmerged index');
  });
});
