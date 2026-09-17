/**
 * AGT-1322 — guard tests for the suite's home isolation.
 *
 * AC3: fail if anything the CLI resolves through `getThinkDir()` /
 * `getLaunchAgentsDir()` lands outside the OS temp directory while the suite
 * is running. The always-on tripwire is the beforeEach/afterEach pair in
 * tests/setup/home-isolation.ts; these are the explicit, readable assertions
 * that say what "isolated" means and prove the choke point is actually wired
 * into vitest — a silently dropped `setupFiles`/`globalSetup` entry fails here.
 *
 * `os.userInfo().homedir` is the reference for "the developer's real home":
 * it comes from the passwd entry and, unlike `os.homedir()`, ignores $HOME.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  getThinkDir,
  getThinkConfigDir,
  getThinkDataDir,
  getIndexDir,
  getRepoPath,
} from '../../src/lib/paths.js';
import { getLaunchAgentsDir } from '../../src/lib/launch-agent.js';
import {
  SENTINEL_DIR_ENV,
  SENTINEL_PLIST_NAME,
  canonicalPath,
  isInsideOsTmpdir,
  sentinelPlistXml,
} from '../setup/home-isolation-paths.js';

const REAL_HOME = os.userInfo().homedir;

describe('AGT-1322 — test-suite home isolation', () => {
  it('HOME points inside the OS temp dir, not the real home', () => {
    const home = process.env.HOME;
    expect(home, 'HOME unset — tests/setup/home-isolation.ts did not run').toBeDefined();
    expect(isInsideOsTmpdir(home as string), `HOME resolved to ${home}`).toBe(true);
    expect(canonicalPath(home as string)).not.toBe(canonicalPath(REAL_HOME));
  });

  it('os.homedir() follows the isolated HOME', () => {
    // Everything in src/ that doesn't read process.env.HOME directly
    // (lib/claude-settings.ts, commands/daemon.ts, commands/cortex.ts) goes
    // through os.homedir(), which reads $HOME on POSIX and %USERPROFILE% on
    // win32 — both of which the setup file repoints.
    expect(isInsideOsTmpdir(os.homedir()), `os.homedir() = ${os.homedir()}`).toBe(true);
    expect(canonicalPath(os.homedir())).not.toBe(canonicalPath(REAL_HOME));
  });

  it('every think path helper resolves under the OS temp dir', () => {
    const resolved: Array<[string, string]> = [
      ['getThinkDir', getThinkDir()],
      ['getThinkConfigDir', getThinkConfigDir()],
      ['getThinkDataDir', getThinkDataDir()],
      ['getIndexDir', getIndexDir()],
      ['getRepoPath', getRepoPath()],
      ['getLaunchAgentsDir', getLaunchAgentsDir()],
    ];
    for (const [name, value] of resolved) {
      expect(isInsideOsTmpdir(value), `${name}() resolved to ${value}`).toBe(true);
    }
  });

  it('getThinkDir() cannot reach the real ~/.think-personal / ~/.think', () => {
    // The AGT-1305 incident: a test wrote block-registry.json into the real
    // THINK_HOME because nothing forced one for the suite.
    const canonical = canonicalPath(getThinkDir());
    expect(canonical.startsWith(canonicalPath(REAL_HOME) + path.sep)).toBe(false);
  });

  it('getLaunchAgentsDir() resolves under the temp HOME (AC2)', () => {
    const dir = getLaunchAgentsDir();
    expect(canonicalPath(dir)).toBe(
      canonicalPath(path.join(process.env.HOME as string, 'Library', 'LaunchAgents')),
    );
    expect(canonicalPath(dir)).not.toBe(
      canonicalPath(path.join(REAL_HOME, 'Library', 'LaunchAgents')),
    );
    // Not merely resolving into temp — the directory must EXIST, so the
    // reaper's readdir actually enumerates it instead of no-opping on ENOENT
    // and passing the AC2 daemon test for the wrong reason.
    expect(fs.existsSync(dir)).toBe(true);
  });

  describe('sentinel LaunchAgents directory', () => {
    it('is planted outside the isolated HOME and still intact', () => {
      const sentinelDir = process.env[SENTINEL_DIR_ENV];
      expect(sentinelDir, `${SENTINEL_DIR_ENV} unset — globalSetup did not run`).toBeDefined();

      const plist = path.join(sentinelDir as string, SENTINEL_PLIST_NAME);
      expect(fs.existsSync(plist), `sentinel ${plist} was deleted during the suite`).toBe(true);
      expect(fs.readFileSync(plist, 'utf-8')).toBe(sentinelPlistXml());

      // The sentinel stands in for the real ~/Library/LaunchAgents: it holds a
      // plist the reaper WOULD delete, at a path nothing in the suite should
      // ever resolve. It lives in temp, never in the real LaunchAgents dir —
      // planting a fixture there is the damage this ticket exists to prevent.
      expect(isInsideOsTmpdir(sentinelDir as string)).toBe(true);
      expect(canonicalPath(sentinelDir as string)).not.toBe(canonicalPath(getLaunchAgentsDir()));
    });
  });

  describe('the tripwire predicate', () => {
    const originalThinkHome = process.env.THINK_HOME;

    afterEach(() => {
      if (originalThinkHome === undefined) delete process.env.THINK_HOME;
      else process.env.THINK_HOME = originalThinkHome;
    });

    it('rejects a THINK_HOME outside the OS temp dir', () => {
      // Exercises the predicate the setup file's hooks use, without tripping
      // them: this afterEach is registered later than the setup file's, and
      // vitest unwinds afterEach hooks in reverse registration order, so the
      // restore above runs first.
      process.env.THINK_HOME = path.join(REAL_HOME, '.think-personal');
      expect(isInsideOsTmpdir(process.env.THINK_HOME)).toBe(false);
      expect(isInsideOsTmpdir(getThinkDir())).toBe(false);
    });
  });
});
