/**
 * Unit tests for checkSalvageCommits() — AGT-1310 AC1.
 *
 * `repoPath` and the sweep are injected in every test, so nothing here runs
 * git against the real `~/.think/repo` and nothing here can mutate a branch:
 * the sweep is the read-only half by construction, and the check only ever
 * calls that half. The end-to-end behaviour against real git and a real bare
 * origin lives in tests/lib/salvage-repair.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkSalvageCommits,
  SALVAGE_COMMIT_CHECK_ID,
} from '../../../src/lib/doctor/salvage-commit.js';
import type { SalvageFinding } from '../../../src/lib/salvage-repair.js';

function finding(branch: string, overrides: Partial<SalvageFinding> = {}): SalvageFinding {
  return {
    branch,
    commits: [
      {
        sha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
        subject: 'chore(cortex): salvage uncommitted worktree changes (self-heal #69)',
        deletedPages: [`${branch}/000002.jsonl`],
      },
    ],
    deletedPages: [`${branch}/000002.jsonl`],
    hasUpstream: true,
    ...overrides,
  };
}

describe('checkSalvageCommits (AGT-1310)', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), 'think-doctor-salvage-'));
    mkdirSync(join(repoPath, '.git'));
  });

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  it('passes when there is no clone to inspect', () => {
    const missing = join(repoPath, 'nope');
    const result = checkSalvageCommits({
      repoPath: missing,
      scan: () => {
        throw new Error('the sweep must not run without a .git directory');
      },
    });

    expect(result.status).toBe('pass');
    expect(result.detail).toContain(missing);
    expect(result.fixable).toBe(false);
  });

  it('passes when no branch carries a salvage commit', () => {
    const result = checkSalvageCommits({ repoPath, scan: () => [] });

    expect(result).toEqual({
      id: SALVAGE_COMMIT_CHECK_ID,
      status: 'pass',
      detail: 'No cortex branch carries an unpushed salvage commit.',
      fixable: false,
    });
  });

  it('fails, fixable, naming the branch, the commit and the pages it deleted', () => {
    const result = checkSalvageCommits({ repoPath, scan: () => [finding('personal')] });

    expect(result.status).toBe('fail');
    expect(result.fixable).toBe(true);
    expect(result.detail).toContain('personal carries 1 unpushed salvage commit');
    expect(result.detail).toContain('a1b2c3d4');
    expect(result.detail).toContain('deleting 1 L1 page');
    expect(result.detail).toContain('cannot fast-forward onto origin');
  });

  it('reports every affected branch, and pluralises', () => {
    const result = checkSalvageCommits({
      repoPath,
      scan: () => [
        finding('personal', {
          deletedPages: ['personal/000002.jsonl', 'personal/000003.jsonl'],
        }),
        finding('cortex/engineering'),
      ],
    });

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('deleting 2 L1 pages');
    expect(result.detail).toContain('cortex/engineering carries');
  });

  it('warns without offering a repair when the branch has no origin ref', () => {
    // There is no tip to reset to and nothing on the branch is known to be on
    // origin, so a "repair" would be an offer to delete the only copy.
    const result = checkSalvageCommits({
      repoPath,
      scan: () => [finding('fresh', { hasUpstream: false })],
    });

    expect(result.status).toBe('warn');
    expect(result.fixable).toBe(false);
    expect(result.detail).toContain('no origin ref to reset to');
  });

  it('fails on a repairable branch while still naming the unrepairable one', () => {
    const result = checkSalvageCommits({
      repoPath,
      scan: () => [finding('personal'), finding('fresh', { hasUpstream: false })],
    });

    expect(result.status).toBe('fail');
    expect(result.fixable).toBe(true);
    expect(result.detail).toContain('personal carries');
    expect(result.detail).toContain('not repairable: fresh');
  });

  it('warns without offering a repair when git could not be questioned', () => {
    // The sweep is read-only; a throw means git itself failed, and running the
    // mutating half on that basis is exactly what this ticket must not do.
    const result = checkSalvageCommits({
      repoPath,
      scan: () => {
        throw new Error('not a git repository');
      },
    });

    expect(result.status).toBe('warn');
    expect(result.fixable).toBe(false);
    expect(result.detail).toContain('not a git repository');
  });
});
