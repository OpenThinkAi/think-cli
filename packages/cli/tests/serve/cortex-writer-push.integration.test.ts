/**
 * AGT-399 — end-to-end push verification for the proxy cortex-writer.
 *
 * Pins the operator wiring path: a `think cortex setup <bare-repo-url>` +
 * `think cortex create engineering` setup is enough for `writeMemoriesForEvent`
 * to land memories on the *remote* — no extra config-field plumbing or boot
 * step is required.
 *
 * The test wires up the same primitives a real `think serve` does on boot
 * (config, repo clone, orphan branch) against a `file://` bare repo standing
 * in for HiveDB, then calls `writeMemoriesForEvent` and waits for the
 * (per-test, short-window) push-debouncer to push.
 *
 * Why the inline `PushDebouncer`: the module-level singleton uses a 500ms
 * window and runs git via `execFile`, which is fine in production but
 * sluggish + noisy under tests. We construct a private debouncer with a
 * 50ms window and hand it to `writeMemoriesForEvent` via the `notifyPush`
 * seam; everything else (the JSONL append, the cortex-name → branch
 * mapping, the `git add/commit/push` shape) is the production path.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { writeMemoriesForEvent } from '../../src/serve/cortex-writer.js';
import { PushDebouncer } from '../../src/daemon/push-debouncer.js';
import {
  ensureRepoCloned,
  createOrphanBranch,
} from '../../src/lib/git.js';
import { saveConfig, getConfig } from '../../src/lib/config.js';
import { closeAllCortexDbs } from '../../src/db/engrams.js';

const TEST_DEBOUNCE_MS = 50;
const CORTEX = 'engineering-test';
const PROXY_PEER_ID = 'proxy-agt-399-test';

interface Harness {
  thinkHome: string;
  bareRepo: string;
  bareRepoUrl: string;
  cleanup: () => void;
}

function setupHarness(): Harness {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'agt-399-push-'));
  const thinkHome = join(tmpRoot, 'think-home');
  const bareRepo = join(tmpRoot, 'hivedb.git');
  mkdirSync(thinkHome, { recursive: true });
  mkdirSync(bareRepo, { recursive: true });

  execFileSync('git', ['init', '--bare', '--initial-branch=main', bareRepo], { stdio: 'pipe' });

  // Seed the bare repo with a main branch so clone --no-checkout has a HEAD.
  // `ensureRepoCloned` (called below) does `git clone --no-checkout` and needs
  // something on the other side; an empty bare repo would leave the local
  // clone in a broken "no commits yet" state that the push-debouncer's
  // `git add` then can't recover from cleanly.
  const seed = join(tmpRoot, 'seed');
  mkdirSync(seed);
  execFileSync('git', ['init', '--initial-branch=main', seed], { stdio: 'pipe' });
  execFileSync('git', ['-C', seed, 'config', 'user.email', 'agt-399@example.com'], { stdio: 'pipe' });
  execFileSync('git', ['-C', seed, 'config', 'user.name', 'agt-399'], { stdio: 'pipe' });
  execFileSync('git', ['-C', seed, 'commit', '--allow-empty', '-m', 'init'], { stdio: 'pipe' });
  execFileSync('git', ['-C', seed, 'push', `file://${bareRepo}`, 'main'], { stdio: 'pipe' });

  return {
    thinkHome,
    bareRepo,
    bareRepoUrl: `file://${bareRepo}`,
    cleanup: () => {
      closeAllCortexDbs();
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

describe('writeMemoriesForEvent — end-to-end push to a bare remote (AGT-399)', () => {
  let harness: Harness;
  let originalHome: string | undefined;
  let originalAuthorName: string | undefined;
  let originalAuthorEmail: string | undefined;
  let originalCommitterName: string | undefined;
  let originalCommitterEmail: string | undefined;

  beforeAll(() => {
    process.env.THINK_TEST_ALLOW_FILE_URL = '1';
  });

  afterAll(() => {
    delete process.env.THINK_TEST_ALLOW_FILE_URL;
  });

  beforeEach(() => {
    originalHome = process.env.THINK_HOME;
    originalAuthorName = process.env.GIT_AUTHOR_NAME;
    originalAuthorEmail = process.env.GIT_AUTHOR_EMAIL;
    originalCommitterName = process.env.GIT_COMMITTER_NAME;
    originalCommitterEmail = process.env.GIT_COMMITTER_EMAIL;

    harness = setupHarness();
    process.env.THINK_HOME = harness.thinkHome;
    // The push-debouncer commits via `git commit -m ...` and needs an
    // author/committer identity in the environment because we strip
    // GIT_CONFIG_GLOBAL/SYSTEM in safeGitEnv (no ~/.gitconfig fallback).
    process.env.GIT_AUTHOR_NAME = 'agt-399';
    process.env.GIT_AUTHOR_EMAIL = 'agt-399@example.com';
    process.env.GIT_COMMITTER_NAME = 'agt-399';
    process.env.GIT_COMMITTER_EMAIL = 'agt-399@example.com';

    // Mirror `think cortex setup <repo-url>` — write the git backend config.
    saveConfig({
      ...getConfig(),
      cortex: { repo: harness.bareRepoUrl, author: 'agt-399' },
    });
  });

  afterEach(() => {
    harness.cleanup();
    if (originalHome === undefined) delete process.env.THINK_HOME;
    else process.env.THINK_HOME = originalHome;
    if (originalAuthorName === undefined) delete process.env.GIT_AUTHOR_NAME;
    else process.env.GIT_AUTHOR_NAME = originalAuthorName;
    if (originalAuthorEmail === undefined) delete process.env.GIT_AUTHOR_EMAIL;
    else process.env.GIT_AUTHOR_EMAIL = originalAuthorEmail;
    if (originalCommitterName === undefined) delete process.env.GIT_COMMITTER_NAME;
    else process.env.GIT_COMMITTER_NAME = originalCommitterName;
    if (originalCommitterEmail === undefined) delete process.env.GIT_COMMITTER_EMAIL;
    else process.env.GIT_COMMITTER_EMAIL = originalCommitterEmail;
  });

  it('lands a proxy-written memory on the bare remote after cortex create + writeMemoriesForEvent', async () => {
    // --- Step 1: mirror `think cortex setup` + `think cortex create <name>` ---
    // setupHarness already saved the config. ensureRepoCloned + createOrphanBranch
    // is exactly what `think cortex setup` (clone) and `think cortex create`
    // (create + push) do on the host today.
    ensureRepoCloned();
    createOrphanBranch(CORTEX);

    expect(existsSync(join(harness.thinkHome, 'repo', '.git'))).toBe(true);

    // --- Step 2: stand up a private push-debouncer with a short window ---
    // Production uses the 500ms module-level singleton; here we want a fast
    // debounce so the test completes quickly. The push semantics (the
    // git add/commit/push triple) are identical.
    const dbn = new PushDebouncer(TEST_DEBOUNCE_MS);

    // --- Step 3: fire writeMemoriesForEvent as the proxy curator would ---
    writeMemoriesForEvent({
      event: { id: 'test-event-1', episodeKey: 'test:smoke#1' },
      memories: [
        { content: 'smoke test memory — AGT-399', topics: ['smoke', 'agt-399'] },
      ],
      cortexName: CORTEX,
      peerId: PROXY_PEER_ID,
      notifyPush: (cortex) => dbn.notify(cortex),
    });

    // --- Step 4: wait for the debouncer to fire + push to complete ---
    // The debouncer kicks off git work via setImmediate after the
    // 50ms timer. Poll the bare repo for the auto: commit landing.
    await waitForAutoCommit(harness.bareRepo, CORTEX, 5000);

    // --- Step 5: assert the bare repo has the commit and the JSONL line ---
    const log = execFileSync('git', ['-C', harness.bareRepo, 'log', '--oneline', CORTEX], {
      encoding: 'utf-8',
    });
    // Expect at least two commits: the orphan "init: create cortex" and the
    // "auto: 1 entry via daemon" from the push-debouncer.
    const lines = log.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.some(l => /auto:\s+1 entry via daemon/.test(l))).toBe(true);

    // The JSONL line lives at `<cortex>/000001.jsonl` (subdirectory layout
    // matching the daemon sync-handler — see sync-handler.ts:337 and
    // l1-page.ts).
    const jsonl = execFileSync(
      'git',
      ['-C', harness.bareRepo, 'show', `${CORTEX}:${CORTEX}/000001.jsonl`],
      { encoding: 'utf-8' },
    );
    const memoryLines = jsonl.trim().split('\n').filter(Boolean);
    expect(memoryLines).toHaveLength(1);
    const memory = JSON.parse(memoryLines[0]);
    expect(memory.content).toBe('smoke test memory — AGT-399');
    expect(memory.episode_key).toBe('test:smoke#1');
    expect(memory.source_ids).toEqual(['test-event-1']);
    expect(memory.author).toBe('proxy');
    expect(memory.origin_peer_id).toBe(PROXY_PEER_ID);
    expect(memory.topics).toEqual(['smoke', 'agt-399']);
  });
});

/**
 * Poll the bare repo until an `auto:` commit appears on `<cortex>`. Times
 * out with a descriptive error if the push never lands — far easier to
 * debug than a bare timeout in `waitFor`.
 */
async function waitForAutoCommit(bareRepo: string, cortex: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const log = execFileSync('git', ['-C', bareRepo, 'log', '--oneline', cortex], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (/auto:\s+\d+\s+entry|entries/.test(log)) return;
    } catch {
      // Branch may not exist yet; keep polling.
    }
    await new Promise(r => setTimeout(r, 25));
  }
  // One last fetch for the error message
  let lastLog = '(no log available)';
  try {
    lastLog = execFileSync('git', ['-C', bareRepo, 'log', '--all', '--oneline'], { encoding: 'utf-8' });
  } catch { /* best effort */ }
  throw new Error(
    `Timed out waiting ${timeoutMs}ms for auto-commit on '${cortex}' in ${bareRepo}.\n` +
      `Last log across all branches:\n${lastLog}`,
  );
}
