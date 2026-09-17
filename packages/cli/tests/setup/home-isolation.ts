/**
 * AGT-1322 — the suite's single home-isolation choke point.
 *
 * Wired as vitest `setupFiles`, so this module is evaluated in every worker
 * BEFORE any test module (and therefore before any module-scope code in a
 * test file) is imported. By the time a test can observe `process.env`, HOME
 * and THINK_HOME already point inside `os.tmpdir()`.
 *
 * Why this exists: `runDaemon()` reaps stale `ai.openthink.curate.*` /
 * `ai.openthink.sync.*` LaunchAgents from `getLaunchAgentsDir()`, which is
 * `$HOME/Library/LaunchAgents`. Six test files start a real daemon with a temp
 * THINK_HOME but inherited the real HOME, so on 2026-09-17 `npm test` unloaded
 * and deleted the runner's two real agents. A separate test wrote
 * `block-registry.json` into the real `~/.think-personal` for the same reason:
 * nothing forced THINK_HOME for the suite.
 *
 * The rule this file enforces: a test that forgets to isolate itself lands in
 * a temp directory, not in the developer's home. Tests that set their own
 * THINK_HOME keep working unchanged — this is a safety net underneath them,
 * not a replacement for them.
 *
 * Deliberately NOT done here: gating the reaper (or any other production code)
 * off under NODE_ENV=test. That would hide the default-path hazard rather than
 * remove the suite's access to the real home, and would leave the shipped
 * daemon untested on the path it actually runs.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach } from 'vitest';
import {
  HOME_ROOT_ENV,
  SENTINEL_DIR_ENV,
  SENTINEL_PLIST_NAME,
  canonicalPath,
  isInsideOsTmpdir,
  makeRunRoot,
  sentinelPlistXml,
} from './home-isolation-paths.js';

// ---------------------------------------------------------------------------
// Per-run root
//
// globalSetup (tests/setup/global-home-isolation.ts) creates the run root and
// exports it through the environment, which the forked workers inherit. The
// fallback keeps this file correct on its own if it is ever loaded without
// that globalSetup (e.g. a one-off `vitest --globalSetup=`), at the cost of
// a root that only process-exit cleanup removes.
// ---------------------------------------------------------------------------

function resolveRunRoot(): string {
  const fromGlobalSetup = process.env[HOME_ROOT_ENV];
  if (fromGlobalSetup && fs.existsSync(fromGlobalSetup)) return fromGlobalSetup;

  const ownRoot = makeRunRoot();
  process.env[HOME_ROOT_ENV] = ownRoot;
  process.once('exit', () => {
    try { fs.rmSync(ownRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  return ownRoot;
}

// ---------------------------------------------------------------------------
// Isolated HOME
//
// One fresh home per test FILE (setupFiles runs once per file), so a file that
// scribbles in `~` cannot be seen by the next one.
// ---------------------------------------------------------------------------

const runRoot = resolveRunRoot();
const isolatedHome = fs.mkdtempSync(path.join(runRoot, 'home-'));

// `~/Library/LaunchAgents` must EXIST, not merely resolve into temp: the
// reaper's readdirSync on a missing directory is a silent no-op, which would
// make the AC2 daemon test pass for the wrong reason.
fs.mkdirSync(path.join(isolatedHome, 'Library', 'LaunchAgents'), { recursive: true });

const isolatedThinkHome = path.join(isolatedHome, '.think');
fs.mkdirSync(isolatedThinkHome, { recursive: true });

process.env.HOME = isolatedHome;
// Windows' equivalent, read by os.homedir() there. Node's os.homedir() prefers
// $HOME on POSIX and %USERPROFILE% on win32, and src/lib/claude-settings.ts,
// src/commands/daemon.ts and src/commands/cortex.ts all go through it.
process.env.USERPROFILE = isolatedHome;

// Set THINK_HOME to exactly what getThinkDir() would derive from HOME anyway,
// so a test that deletes THINK_HOME to exercise the default branch resolves to
// the same temp directory instead of falling through to the real `~/.think`.
process.env.THINK_HOME = isolatedThinkHome;

// These override the HOME-derived defaults in getThinkConfigDir() /
// getThinkDataDir(), so a developer's real XDG settings would escape the
// isolated home. Unset (rather than repointed) so tests asserting the
// HOME-relative fallback keep asserting the fallback.
delete process.env.XDG_CONFIG_HOME;
delete process.env.XDG_DATA_HOME;
// Same hazard for lib/claude-settings.ts, which prefers CLAUDE_CONFIG_DIR over
// `os.homedir()/.claude`.
delete process.env.CLAUDE_CONFIG_DIR;

// ---------------------------------------------------------------------------
// Git config (AC4)
//
// HOME isolation alone doesn't fully isolate git: `GIT_CONFIG_GLOBAL`, if the
// developer or CI has it set, overrides `$HOME/.gitconfig` and would pull the
// real global config into the suite. Point it at a file inside the isolated
// home instead. (`XDG_CONFIG_HOME`, git's other global-config source, is
// already unset above.)
//
// Measured 2026-09-17: with `GIT_CONFIG_GLOBAL=/dev/null` and no GIT_AUTHOR_*
// the whole git-touching set — tests/sync, git-branch-prep, git-worktree,
// git-salvage-stale-index, daemon/git-plumbing-write — still passes, because
// every one of them sets a per-repo or per-test identity itself. So nothing
// today *needs* the identity below; it is here so that the first git test
// written after this lands fails on its own logic rather than on "Please tell
// me who you are", which is exactly the confusing second-order failure AC4 is
// about. Test files that set these themselves still win — they assign after
// this module has run.
// ---------------------------------------------------------------------------

process.env.GIT_CONFIG_GLOBAL = path.join(isolatedHome, '.gitconfig');
fs.writeFileSync(
  process.env.GIT_CONFIG_GLOBAL,
  '[user]\n\tname = think test suite\n\temail = tests@think.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n',
);
process.env.GIT_AUTHOR_NAME ??= 'think test suite';
process.env.GIT_AUTHOR_EMAIL ??= 'tests@think.invalid';
process.env.GIT_COMMITTER_NAME ??= 'think test suite';
process.env.GIT_COMMITTER_EMAIL ??= 'tests@think.invalid';

// ---------------------------------------------------------------------------
// Always-on tripwire (AC2 + AC3)
//
// The assignments above only fix the *starting* environment. A test that
// repoints HOME or THINK_HOME at a real path — or forgets to restore one it
// repointed — would quietly re-open the hole for every test after it. These
// hooks are registered before any test file's own hooks, so the `beforeEach`
// runs first (catching module-scope and outer-suite damage) and the
// `afterEach` runs last (catching a leak the test left behind).
//
// The sentinel is checked here rather than only in globalSetup's teardown
// because vitest 4 exits 0 when a teardown throws (verified 2026-09-17): the
// error is printed as "error during close" and the run still reports success.
// Checking per test both fails the run for real and attributes the damage to
// the test that did it. The teardown check stays as a run-scoped backstop.
//
// The dedicated, readable assertions for AC2/AC3 live in
// tests/lib/home-isolation.test.ts; this pair is the always-on net.
// ---------------------------------------------------------------------------

const sentinelDir = process.env[SENTINEL_DIR_ENV];
const sentinelPath = sentinelDir ? path.join(sentinelDir, SENTINEL_PLIST_NAME) : undefined;
const sentinelXml = sentinelPlistXml();

function assertIsolated(when: string): void {
  for (const name of ['HOME', 'THINK_HOME'] as const) {
    const value = process.env[name];
    if (value === undefined) continue; // absent is not "pointing at the real home"
    if (!isInsideOsTmpdir(value)) {
      throw new Error(
        `AGT-1322: ${name} escaped the isolated test home ${when}: ` +
          `${canonicalPath(value)} is outside ${canonicalPath(os.tmpdir())}. ` +
          `Tests must never resolve paths in the real home — see ` +
          `packages/cli/tests/setup/home-isolation.ts.`,
      );
    }
  }

  if (!sentinelPath) return;
  // The sentinel stands in for the real ~/Library/LaunchAgents: a plist the
  // daemon's reaper WOULD delete, at a path nothing in the suite should
  // resolve. If it moved, something reached outside the isolated HOME.
  let contents: string;
  try {
    contents = fs.readFileSync(sentinelPath, 'utf-8');
  } catch {
    throw new Error(
      `AGT-1322: the sentinel LaunchAgent ${sentinelPath} was deleted ${when} — ` +
        `something reaped outside the isolated HOME.`,
    );
  }
  if (contents !== sentinelXml) {
    throw new Error(
      `AGT-1322: the sentinel LaunchAgent ${sentinelPath} was modified ${when} — ` +
        `something wrote outside the isolated HOME.`,
    );
  }
}

beforeEach(() => { assertIsolated('before a test ran'); });
afterEach(() => { assertIsolated('after a test ran'); });

// Nothing is exported on purpose. A test importing this module would get a
// second evaluation in the test module graph (vitest loads setupFiles in their
// own registry), carving out a second isolated HOME and repointing the
// environment mid-file. Read `process.env.HOME` / `process.env.THINK_HOME`
// instead; the path predicates live in ./home-isolation-paths.ts.
export {};
