/**
 * AGT-1322 — run-scoped half of the home isolation.
 *
 * Runs once in the vitest main process, before any worker is forked, and
 * therefore before any test module exists:
 *
 *  - creates the per-run root that tests/setup/home-isolation.ts carves each
 *    worker's isolated HOME out of, and publishes it through the environment
 *    (forked workers inherit `process.env` at fork time);
 *  - plants the AC2 sentinel: a directory standing in for the real
 *    `~/Library/LaunchAgents`, holding an `ai.openthink.curate.fixture.plist`
 *    that the reaper WOULD delete if it ever pointed outside the temp HOME;
 *  - on teardown, removes the root and fails the run if the sentinel plist was
 *    modified or deleted while the suite ran.
 *
 * The sentinel is a temp directory, never the real `~/Library/LaunchAgents`:
 * writing a fixture into the real one would hand the suite exactly the damage
 * this ticket exists to prevent.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  HOME_ROOT_ENV,
  SENTINEL_DIR_ENV,
  SENTINEL_PLIST_NAME,
  makeRunRoot,
  sentinelPlistXml,
} from './home-isolation-paths.js';

let runRoot: string | undefined;
let sentinelPlistPath: string | undefined;
let sentinelContents: string | undefined;

export function setup(): void {
  runRoot = makeRunRoot();
  process.env[HOME_ROOT_ENV] = runRoot;

  const sentinelDir = path.join(runRoot, 'sentinel-LaunchAgents');
  fs.mkdirSync(sentinelDir, { recursive: true });
  sentinelPlistPath = path.join(sentinelDir, SENTINEL_PLIST_NAME);
  sentinelContents = sentinelPlistXml();
  fs.writeFileSync(sentinelPlistPath, sentinelContents, { mode: 0o644 });
  process.env[SENTINEL_DIR_ENV] = sentinelDir;
}

export function teardown(): void {
  // Run-scoped backstop. The primary sentinel check is the per-test hook in
  // tests/setup/home-isolation.ts, because vitest 4 prints a teardown throw as
  // "error during close" and still exits 0 — hence the explicit
  // `process.exitCode` below as well as the throw.
  let failure: string | undefined;
  if (sentinelPlistPath && sentinelContents !== undefined) {
    if (!fs.existsSync(sentinelPlistPath)) {
      failure = `AGT-1322: the sentinel LaunchAgent ${sentinelPlistPath} was DELETED during the suite — something reaped outside the isolated HOME.`;
    } else if (fs.readFileSync(sentinelPlistPath, 'utf-8') !== sentinelContents) {
      failure = `AGT-1322: the sentinel LaunchAgent ${sentinelPlistPath} was MODIFIED during the suite — something wrote outside the isolated HOME.`;
    }
  }

  if (runRoot) {
    try { fs.rmSync(runRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  if (failure) {
    process.exitCode = 1;
    throw new Error(failure);
  }
}
