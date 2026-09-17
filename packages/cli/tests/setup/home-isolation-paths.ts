/**
 * AGT-1322 — path helpers shared by the home-isolation globalSetup, the
 * per-worker setup file, and the guard tests.
 *
 * Kept free of vitest imports so globalSetup (which runs in the vitest main
 * process, outside the test environment) can import it too.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Environment variable carrying the per-run root from globalSetup to workers. */
export const HOME_ROOT_ENV = 'THINK_TEST_HOME_ROOT';

/** Environment variable carrying the sentinel LaunchAgents directory (AC2). */
export const SENTINEL_DIR_ENV = 'THINK_TEST_SENTINEL_LAUNCH_AGENTS';

/**
 * The fixture that stands in for a real `ai.openthink.curate.*` agent. The
 * reaper matches on the `ai.openthink.curate.` / `ai.openthink.sync.` label
 * prefix, so this name is one it WOULD delete — which is the point: a copy in
 * the sentinel directory proves isolation, not indifference.
 */
export const SENTINEL_PLIST_NAME = 'ai.openthink.curate.fixture.plist';

export const SENTINEL_PLIST_LABEL = 'ai.openthink.curate.fixture';

export function sentinelPlistXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${SENTINEL_PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/bin/true</string>
    </array>
    <key>StartInterval</key>
    <integer>300</integer>
    <key>RunAtLoad</key>
    <false/>
  </dict>
</plist>
`;
}

/**
 * Normalises a path for containment checks.
 *
 * On macOS `os.tmpdir()` is `/var/folders/…`, a symlink to `/private/var/…`.
 * Whether a given path has been through `realpath` is not predictable (Node
 * returns the unresolved form from `mkdtempSync`, but a spawned process's
 * `cwd` or a `realpathSync` inside the code under test returns the resolved
 * one), so both forms have to compare equal. Resolving, then stripping the
 * macOS `/private` prefix, puts them in the same space.
 */
export function canonicalPath(input: string): string {
  let resolved = path.resolve(input);
  try {
    resolved = fs.realpathSync(resolved);
  } catch {
    // Path doesn't exist yet (a THINK_HOME a test has not created). The
    // `/private` strip below still normalises the common macOS case.
  }
  if (process.platform === 'darwin' && resolved.startsWith('/private/')) {
    resolved = resolved.slice('/private'.length);
  }
  return resolved;
}

/** True when `candidate` is the OS temp dir or lives underneath it. */
export function isInsideOsTmpdir(candidate: string): boolean {
  const root = canonicalPath(os.tmpdir());
  const target = canonicalPath(candidate);
  return target === root || target.startsWith(root + path.sep);
}

/** Creates the per-run root that every isolated HOME is carved out of. */
export function makeRunRoot(): string {
  return fs.mkdtempSync(path.join(canonicalPath(os.tmpdir()), 'think-suite-home-'));
}
