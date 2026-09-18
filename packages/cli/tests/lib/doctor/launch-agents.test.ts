/**
 * Unit tests for checkStaleLaunchAgents() — AGT-1308 AC1/AC4.
 *
 * These drive the REAL AGT-1301 reaper against a temp fixture directory, which
 * is the point: the check must report through the reaper's dry run, not
 * through a second matcher of its own. Every test injects `launchAgentsDir`
 * and `platform`, so this suite never touches the real ~/Library/LaunchAgents
 * and never calls the real launchctl.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkStaleLaunchAgents,
  STALE_LAUNCH_AGENTS_CHECK_ID,
} from '../../../src/lib/doctor/launch-agents.js';

function plistXml(label: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${label}</string>
  </dict>
</plist>
`;
}

describe('checkStaleLaunchAgents (AGT-1308)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'think-doctor-agents-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writePlist(label: string): void {
    writeFileSync(join(dir, `${label}.plist`), plistXml(label), { mode: 0o644 });
  }

  it('passes when no curate/sync agent is installed', () => {
    writePlist('ai.openthink.subscribe.deadbeef');
    writePlist('com.example.unrelated');

    const result = checkStaleLaunchAgents({
      reapOptions: { launchAgentsDir: dir, platform: 'darwin' },
    });

    expect(result).toEqual({
      id: STALE_LAUNCH_AGENTS_CHECK_ID,
      status: 'pass',
      detail: 'No stale curate/sync LaunchAgents.',
      fixable: false,
    });
  });

  it('fails, fixable, and names every stale agent it found', () => {
    writePlist('ai.openthink.curate.aaaaaaaa');
    writePlist('ai.openthink.sync.bbbbbbbb');
    writePlist('ai.openthink.subscribe.cccccccc');

    const result = checkStaleLaunchAgents({
      reapOptions: { launchAgentsDir: dir, platform: 'darwin' },
    });

    expect(result.status).toBe('fail');
    expect(result.fixable).toBe(true);
    expect(result.detail).toContain('2 stale LaunchAgents');
    expect(result.detail).toContain('ai.openthink.curate.aaaaaaaa');
    expect(result.detail).toContain('ai.openthink.sync.bbbbbbbb');
    // The subscribe agent is not ours to reap and must not be reported.
    expect(result.detail).not.toContain('subscribe');
  });

  it('AC5: reporting deletes nothing — the dry run leaves every plist in place', () => {
    writePlist('ai.openthink.curate.aaaaaaaa');
    writePlist('ai.openthink.sync.bbbbbbbb');

    checkStaleLaunchAgents({ reapOptions: { launchAgentsDir: dir, platform: 'darwin' } });

    expect(readdirSync(dir).sort()).toEqual([
      'ai.openthink.curate.aaaaaaaa.plist',
      'ai.openthink.sync.bbbbbbbb.plist',
    ]);
  });

  it('AC4: reports through the reaper, in dry-run mode', () => {
    const calls: Array<Record<string, unknown>> = [];
    const result = checkStaleLaunchAgents({
      reapOptions: { launchAgentsDir: dir, platform: 'darwin' },
      reap: (options) => {
        calls.push(options as Record<string, unknown>);
        return [];
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].dryRun).toBe(true);
    expect(calls[0].launchAgentsDir).toBe(dir);
    expect(result.status).toBe('pass');
  });

  it('passes without scanning anything on a platform that has no LaunchAgents', () => {
    writePlist('ai.openthink.curate.aaaaaaaa');

    const result = checkStaleLaunchAgents({
      reapOptions: { launchAgentsDir: dir, platform: 'linux' },
      reap: () => {
        throw new Error('the reaper must not run on a non-darwin platform');
      },
    });

    expect(result.status).toBe('pass');
    expect(result.detail).toBe('No LaunchAgents on this platform.');
  });

  it('never claims a plist whose filename and Label disagree', () => {
    // Filename says curate, Label says something else — AGT-1301 leaves this
    // for manual review, so doctor must not report it as reapable either.
    writeFileSync(
      join(dir, 'ai.openthink.curate.aaaaaaaa.plist'),
      plistXml('com.someone.else'),
      { mode: 0o644 },
    );

    const result = checkStaleLaunchAgents({
      reapOptions: { launchAgentsDir: dir, platform: 'darwin' },
    });

    expect(result.status).toBe('pass');
  });
});
