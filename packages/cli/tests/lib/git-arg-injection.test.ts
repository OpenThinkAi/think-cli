import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression coverage for the argv-injection guards in lib/git.ts: a branch
// name or cortex repo URL shaped like a git option (`--upload-pack=<cmd>`)
// must be refused BEFORE any git subprocess is spawned. execFileSync is mocked
// so a regression shows up as a recorded spawn rather than a real git call.

const execFileSync = vi.fn(() => Buffer.from(''));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync };
});

let mockConfig: { cortex?: { repo?: string } } = {};
vi.mock('../../src/lib/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/config.js')>();
  return { ...actual, getConfig: vi.fn(() => mockConfig) };
});

const INJECTED = '--upload-pack=touch /tmp/pwned';

describe('git argv-injection guards', () => {
  beforeEach(() => {
    execFileSync.mockClear();
    mockConfig = {};
  });

  it.each([
    ['branchExists', (g: typeof import('../../src/lib/git.js')) => g.branchExists(INJECTED)],
    ['localBranchExists', (g: typeof import('../../src/lib/git.js')) => g.localBranchExists(INJECTED)],
    ['fetchBranch', (g: typeof import('../../src/lib/git.js')) => g.fetchBranch(INJECTED)],
    ['ensureOnBranch', (g: typeof import('../../src/lib/git.js')) => g.ensureOnBranch(INJECTED)],
    ['createOrphanBranch', (g: typeof import('../../src/lib/git.js')) => g.createOrphanBranch(INJECTED)],
    ['readFileFromBranch', (g: typeof import('../../src/lib/git.js')) => g.readFileFromBranch(INJECTED, 'x.jsonl')],
  ])('%s refuses a branch name of --upload-pack=... without spawning git', async (_name, call) => {
    const git = await import('../../src/lib/git.js');
    expect(() => call(git)).toThrow(/starts with '-'/);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('ensureRepoCloned refuses a cortex.repo of --upload-pack=... without spawning git', async () => {
    mockConfig = { cortex: { repo: INJECTED } };
    const git = await import('../../src/lib/git.js');
    expect(() => git.ensureRepoCloned()).toThrow();
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
