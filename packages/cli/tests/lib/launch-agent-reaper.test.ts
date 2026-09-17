/**
 * Unit tests for reapStaleLaunchAgents() — AGT-1301
 *
 * Every test injects a temp fixture directory, a fake platform, and a fake
 * `unload` function. This suite MUST NEVER touch the real
 * ~/Library/LaunchAgents or call the real `launchctl` — the Studio's two
 * real loaded curate/sync agents are evidence AGT-1320 needs intact, and a
 * builder's test run corrupting that would poison that ticket's before/after
 * comparison.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reapStaleLaunchAgents } from '../../src/lib/launch-agent.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function plistXml(label: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/bin/node</string>
      <string>/usr/local/bin/think</string>
    </array>
    <key>StartInterval</key>
    <integer>300</integer>
  </dict>
</plist>
`;
}

function writePlist(dir: string, filenameLabel: string, contentLabel = filenameLabel): string {
  const p = join(dir, `${filenameLabel}.plist`);
  writeFileSync(p, plistXml(contentLabel), { mode: 0o644 });
  return p;
}

/** All of the ticket's named agents, seeded into one fixture directory. */
function seedFixtureDirectory(dir: string): void {
  // Two different THINK_HOMEs' worth of curate/sync agents — the whole
  // point of AGT-1301 is that these are reaped regardless of which home
  // this daemon process is currently running under.
  writePlist(dir, 'ai.openthink.curate.aaaaaaaa');
  writePlist(dir, 'ai.openthink.curate.bbbbbbbb');
  writePlist(dir, 'ai.openthink.sync.aaaaaaaa');
  writePlist(dir, 'ai.openthink.sync.bbbbbbbb');
  writePlist(dir, 'ai.openthink.curate.default');
  writePlist(dir, 'ai.openthink.sync.default');

  // Must survive untouched.
  writePlist(dir, 'ai.openthink.subscribe.aaaaaaaa');
  writePlist(dir, 'ai.openthink.pablo.aaaaaaaa');
  writePlist(dir, 'com.openthink.vault-autocommit');

  // Prefix-boundary trap: no dot after "sync"/"curate" — must NOT match.
  writePlist(dir, 'ai.openthink.syncfoo');
  writePlist(dir, 'ai.openthink.curatefoo');

  // Unrelated third-party agent.
  writePlist(dir, 'com.apple.something', 'com.apple.something');
}

let fixtureDir: string;

beforeEach(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'launch-agent-reap-test-'));
});

afterEach(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('reapStaleLaunchAgents', () => {
  it('removes every ai.openthink.curate.* and ai.openthink.sync.* plist across all THINK_HOMEs, leaves everything else untouched', () => {
    seedFixtureDirectory(fixtureDir);
    const unloadedPaths: string[] = [];
    const logs: string[] = [];

    const removed = reapStaleLaunchAgents({
      launchAgentsDir: fixtureDir,
      platform: 'darwin',
      unload: (p) => { unloadedPaths.push(p); },
      log: (m) => logs.push(m),
    });

    const removedLabels = removed.map((r) => r.label).sort();
    expect(removedLabels).toEqual([
      'ai.openthink.curate.aaaaaaaa',
      'ai.openthink.curate.bbbbbbbb',
      'ai.openthink.curate.default',
      'ai.openthink.sync.aaaaaaaa',
      'ai.openthink.sync.bbbbbbbb',
      'ai.openthink.sync.default',
    ]);
    expect(removed.every((r) => r.unloaded)).toBe(true);
    expect(unloadedPaths).toHaveLength(6);

    // AC2 — protected agents survive.
    expect(existsSync(join(fixtureDir, 'ai.openthink.subscribe.aaaaaaaa.plist'))).toBe(true);
    expect(existsSync(join(fixtureDir, 'ai.openthink.pablo.aaaaaaaa.plist'))).toBe(true);
    expect(existsSync(join(fixtureDir, 'com.openthink.vault-autocommit.plist'))).toBe(true);
    expect(existsSync(join(fixtureDir, 'com.apple.something.plist'))).toBe(true);

    // Prefix boundary — "sync"/"curate" without a following dot must survive.
    expect(existsSync(join(fixtureDir, 'ai.openthink.syncfoo.plist'))).toBe(true);
    expect(existsSync(join(fixtureDir, 'ai.openthink.curatefoo.plist'))).toBe(true);

    // Reaped files are actually gone.
    expect(existsSync(join(fixtureDir, 'ai.openthink.curate.aaaaaaaa.plist'))).toBe(false);
    expect(existsSync(join(fixtureDir, 'ai.openthink.sync.bbbbbbbb.plist'))).toBe(false);

    // AC3 — each removal is logged.
    expect(logs.some((l) => l.includes('ai.openthink.curate.aaaaaaaa'))).toBe(true);
    expect(logs.some((l) => l.includes('ai.openthink.sync.bbbbbbbb'))).toBe(true);
  });

  it('is a no-op on Linux, even with matching plists present', () => {
    seedFixtureDirectory(fixtureDir);
    const removed = reapStaleLaunchAgents({
      launchAgentsDir: fixtureDir,
      platform: 'linux',
      unload: () => { throw new Error('unload should never be called on Linux'); },
    });
    expect(removed).toEqual([]);
    expect(existsSync(join(fixtureDir, 'ai.openthink.curate.aaaaaaaa.plist'))).toBe(true);
  });

  it('is a no-op, without throwing, when the directory does not exist', () => {
    const missing = join(fixtureDir, 'does-not-exist');
    expect(() =>
      reapStaleLaunchAgents({ launchAgentsDir: missing, platform: 'darwin' }),
    ).not.toThrow();
    expect(
      reapStaleLaunchAgents({ launchAgentsDir: missing, platform: 'darwin' }),
    ).toEqual([]);
  });

  it('is a no-op, without throwing, when no matching plist exists', () => {
    writePlist(fixtureDir, 'ai.openthink.subscribe.aaaaaaaa');
    const removed = reapStaleLaunchAgents({ launchAgentsDir: fixtureDir, platform: 'darwin' });
    expect(removed).toEqual([]);
  });

  it('still deletes the plist when launchctl unload fails (agent not loaded)', () => {
    writePlist(fixtureDir, 'ai.openthink.curate.cccccccc');
    const removed = reapStaleLaunchAgents({
      launchAgentsDir: fixtureDir,
      platform: 'darwin',
      unload: () => { throw new Error('Could not find specified service'); },
    });
    expect(removed).toHaveLength(1);
    expect(removed[0].unloaded).toBe(false);
    expect(removed[0].label).toBe('ai.openthink.curate.cccccccc');
    expect(existsSync(join(fixtureDir, 'ai.openthink.curate.cccccccc.plist'))).toBe(false);
  });

  it('conservatively skips a plist whose filename and Label disagree', () => {
    // Filename says curate; the plist's own Label key says something else
    // entirely. Neither signal alone is trusted — this must survive.
    const p = writePlist(fixtureDir, 'ai.openthink.curate.dddddddd', 'ai.openthink.subscribe.dddddddd');
    const logs: string[] = [];
    const removed = reapStaleLaunchAgents({
      launchAgentsDir: fixtureDir,
      platform: 'darwin',
      log: (m) => logs.push(m),
    });
    expect(removed).toEqual([]);
    expect(existsSync(p)).toBe(true);
    expect(logs.some((l) => l.includes('ai.openthink.curate.dddddddd'))).toBe(true);
  });

  it('conservatively skips a plist with no parseable Label key', () => {
    const p = join(fixtureDir, 'ai.openthink.sync.eeeeeeee.plist');
    writeFileSync(p, 'not a plist at all', { mode: 0o644 });
    const removed = reapStaleLaunchAgents({ launchAgentsDir: fixtureDir, platform: 'darwin' });
    expect(removed).toEqual([]);
    expect(existsSync(p)).toBe(true);
  });

  it('never follows a symlink, even one named like a stale agent', () => {
    const realTarget = join(fixtureDir, 'not-a-plist-really.txt');
    writeFileSync(realTarget, plistXml('ai.openthink.sync.ffffffff'));
    const linkPath = join(fixtureDir, 'ai.openthink.sync.ffffffff.plist');
    symlinkSync(realTarget, linkPath);

    const removed = reapStaleLaunchAgents({ launchAgentsDir: fixtureDir, platform: 'darwin' });
    expect(removed).toEqual([]);
    expect(existsSync(linkPath)).toBe(true);
    expect(existsSync(realTarget)).toBe(true);
  });

  it('never descends into a subdirectory', () => {
    const subdir = join(fixtureDir, 'ai.openthink.curate.subdir.plist');
    mkdirSync(subdir);
    writePlist(subdir, 'ai.openthink.curate.nested');

    const removed = reapStaleLaunchAgents({ launchAgentsDir: fixtureDir, platform: 'darwin' });
    expect(removed).toEqual([]);
    expect(existsSync(join(subdir, 'ai.openthink.curate.nested.plist'))).toBe(true);
  });

  it('ignores non-.plist files even if named with a matching prefix', () => {
    const p = join(fixtureDir, 'ai.openthink.curate.notaplist.txt');
    writeFileSync(p, plistXml('ai.openthink.curate.notaplist'));
    const removed = reapStaleLaunchAgents({ launchAgentsDir: fixtureDir, platform: 'darwin' });
    expect(removed).toEqual([]);
    expect(existsSync(p)).toBe(true);
  });

  it('reports the matched prefix on each removed agent', () => {
    writePlist(fixtureDir, 'ai.openthink.curate.gggggggg');
    writePlist(fixtureDir, 'ai.openthink.sync.gggggggg');
    const removed = reapStaleLaunchAgents({ launchAgentsDir: fixtureDir, platform: 'darwin' });
    const byLabel = new Map(removed.map((r) => [r.label, r]));
    expect(byLabel.get('ai.openthink.curate.gggggggg')?.prefix).toBe('ai.openthink.curate.');
    expect(byLabel.get('ai.openthink.sync.gggggggg')?.prefix).toBe('ai.openthink.sync.');
  });
});
