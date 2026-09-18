/**
 * Check: other think homes present on this machine (AGT-1308 AC1).
 *
 * `THINK_HOME` makes a second (or third) install trivially easy —
 * `~/.think-personal` and `~/.think-work` next to a `~/.think` left over from
 * before the split. Every one of them has its own daemon, its own cortex repo,
 * its own LaunchAgents, and its own copy of everything else `think doctor`
 * reports on. A user chasing "why didn't my note show up" is usually looking
 * at the wrong home.
 *
 * INFORMATIONAL, NEVER A FAILURE. Several homes is a supported setup, not a
 * fault — the design doc's wording is "informational warn, never fail". This
 * check reports what exists and whether each one has a cortex repo; it forms
 * no opinion about which is right and never offers to change one.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getThinkDir } from '../paths.js';
import { result, plural, type CheckResult } from './types.js';

export const THINK_HOMES_CHECK_ID = 'think-homes';

/** One think home found on disk. */
export interface DiscoveredThinkHome {
  dirPath: string;
  /** True when `<home>/repo/.git` exists — i.e. it has a cortex clone. */
  hasCortexRepo: boolean;
  /** True when this is the home the current process is using. */
  active: boolean;
}

export interface ThinkHomesOptions {
  /** Directory to scan for `.think` / `.think-*`. Tests MUST inject. */
  homeDir?: string;
  /** The home this process resolved. Defaults to `getThinkDir()`. */
  activeThinkDir?: string;
}

/**
 * Discover `~/.think` and every `~/.think-*` sibling. Exported so the detail
 * line and any future caller agree on what counts as a home.
 *
 * Only directories directly inside `homeDir` are considered, and
 * `readdirSync(..., { withFileTypes: true })` + `isDirectory()` is false for a
 * symlink, so this never follows one out of the home directory.
 */
export function discoverThinkHomes(options: ThinkHomesOptions = {}): DiscoveredThinkHome[] {
  const homeDir = options.homeDir ?? process.env.HOME ?? '';
  const activeDir = options.activeThinkDir ?? safeThinkDir();
  const active = activeDir.length > 0 ? path.resolve(activeDir) : '';

  // An unreadable home directory yields no siblings, not no homes: the active
  // home below is still real and still worth naming.
  let entries: fs.Dirent[] = [];
  if (homeDir.length > 0) {
    try {
      entries = fs.readdirSync(homeDir, { withFileTypes: true });
    } catch { /* nothing to enumerate */ }
  }

  const homes: DiscoveredThinkHome[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name !== '.think' && !entry.name.startsWith('.think-')) continue;
    const dirPath = path.join(homeDir, entry.name);
    homes.push({
      dirPath,
      hasCortexRepo: fs.existsSync(path.join(dirPath, 'repo', '.git')),
      active: path.resolve(dirPath) === active,
    });
  }

  // An active THINK_HOME set somewhere outside the home directory (a temp dir,
  // an external volume) is still a home, and leaving it out would report "1
  // home" while the user is looking at a second one.
  if (active.length > 0 && !homes.some((home) => home.active)) {
    homes.push({
      dirPath: active,
      hasCortexRepo: fs.existsSync(path.join(active, 'repo', '.git')),
      active: true,
    });
  }

  return homes.sort((a, b) => a.dirPath.localeCompare(b.dirPath));
}

export function checkThinkHomes(options: ThinkHomesOptions = {}): CheckResult {
  const homes = discoverThinkHomes(options);

  if (homes.length <= 1) {
    const only = homes[0];
    return result(
      THINK_HOMES_CHECK_ID,
      'pass',
      only ? `One think home: ${only.dirPath}.` : 'No think home found.',
    );
  }

  const described = homes
    .map((home) => {
      const marks = [home.active ? 'active' : null, home.hasCortexRepo ? 'cortex repo' : 'no cortex repo']
        .filter((mark): mark is string => mark !== null)
        .join(', ');
      return `${home.dirPath} (${marks})`;
    })
    .join('; ');

  return result(
    THINK_HOMES_CHECK_ID,
    'warn',
    `${plural(homes.length, 'think home')} on this machine: ${described}. ` +
      'Each has its own daemon and cortex — set THINK_HOME to pick one.',
    false,
  );
}

function safeThinkDir(): string {
  try {
    return getThinkDir();
  } catch {
    return '';
  }
}
