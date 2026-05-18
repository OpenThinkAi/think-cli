/**
 * Tests for the Claude Code settings read/write helpers (AGT-313).
 *
 * Covers:
 *  - readSettings: missing file, valid JSON, malformed JSON
 *  - addHookEntry: new entry, idempotent (no duplicate), multiple entries coexist
 *  - addHookEntry: migration from old flat shape and from correct shape
 *  - removeHookEntry: found (new shape), found (old flat shape), not found, cleans up empty structures
 *  - writeSettings + readSettings round-trip via a real temp directory
 *  - validateSettingsPath: rejects paths outside home/cwd
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  readSettings,
  writeSettings,
  addHookEntry,
  removeHookEntry,
  validateSettingsPath,
  type ClaudeSettings,
  type HookMatcherGroup,
} from '../../src/lib/claude-settings.js';

// ---------------------------------------------------------------------------
// Temp directory fixture
//
// We place the temp dir inside ~/.think-test-tmp/ so that it falls under the
// home directory, satisfying the validateSettingsPath() guard (which rejects
// paths outside home and cwd). Using os.tmpdir() would land in /var/folders
// on macOS which is outside $HOME.
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  const base = path.join(os.homedir(), '.think-test-tmp');
  fs.mkdirSync(base, { recursive: true });
  tmpDir = fs.mkdtempSync(path.join(base, 'claude-settings-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// readSettings
// ---------------------------------------------------------------------------

describe('readSettings', () => {
  it('returns empty object when file does not exist', () => {
    const result = readSettings(path.join(tmpDir, 'nonexistent.json'));
    expect(result).toEqual({});
  });

  it('parses valid JSON', () => {
    const file = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ hooks: { UserPromptSubmit: [] } }));
    const result = readSettings(file);
    expect(result).toEqual({ hooks: { UserPromptSubmit: [] } });
  });

  it('throws with a clear message on malformed JSON', () => {
    const file = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(file, '{ "key": /* comment */ "value" }');
    expect(() => readSettings(file)).toThrow(/Failed to parse/);
    expect(() => readSettings(file)).toThrow(/strict JSON/);
  });
});

// ---------------------------------------------------------------------------
// addHookEntry — new shape
// ---------------------------------------------------------------------------

describe('addHookEntry', () => {
  it('adds a new matcher-group entry to an empty settings object', () => {
    const settings: ClaudeSettings = {};
    const scriptPath = '/usr/local/lib/node_modules/@openthink/think/dist/hooks/user-prompt-submit.js';
    const result = addHookEntry(settings, scriptPath);
    expect(result).toBe('installed');

    const ups = settings.hooks?.UserPromptSubmit as HookMatcherGroup[];
    expect(ups).toHaveLength(1);
    expect(ups[0]).toEqual({
      matcher: '',
      hooks: [{ type: 'command', command: `node "${scriptPath}"` }],
    });
  });

  it('returns already_installed and does not duplicate when run twice', () => {
    const settings: ClaudeSettings = {};
    const scriptPath = '/usr/local/lib/node_modules/@openthink/think/dist/hooks/user-prompt-submit.js';
    addHookEntry(settings, scriptPath);
    const result = addHookEntry(settings, scriptPath);
    expect(result).toBe('already_installed');

    const ups = settings.hooks?.UserPromptSubmit as HookMatcherGroup[];
    expect(ups).toHaveLength(1);
  });

  it('preserves unrelated UserPromptSubmit entries alongside ours', () => {
    const unrelated: HookMatcherGroup = { matcher: 'some-tool', hooks: [{ type: 'command', command: 'node /other/hook.js' }] };
    const settings: ClaudeSettings = {
      hooks: {
        UserPromptSubmit: [unrelated],
      },
    };
    const scriptPath = '/usr/local/lib/node_modules/@openthink/think/dist/hooks/user-prompt-submit.js';
    addHookEntry(settings, scriptPath);

    const ups = settings.hooks?.UserPromptSubmit as HookMatcherGroup[];
    expect(ups).toHaveLength(2);
    expect(ups[0]).toEqual(unrelated);
    expect(ups[1].matcher).toBe('');
    expect(ups[1].hooks[0].command).toBe(`node "${scriptPath}"`);
  });

  it('preserves other hooks keys when adding UserPromptSubmit', () => {
    const settings: ClaudeSettings = {
      hooks: { OtherEvent: [{ type: 'command', command: '/other.js' }] },
    };
    const scriptPath = '/usr/local/lib/node_modules/@openthink/think/dist/hooks/user-prompt-submit.js';
    addHookEntry(settings, scriptPath);
    expect(settings.hooks?.OtherEvent).toBeDefined();

    const ups = settings.hooks?.UserPromptSubmit as HookMatcherGroup[];
    expect(ups).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// addHookEntry — migration from old flat shape (alpha.4–alpha.8)
// ---------------------------------------------------------------------------

describe('addHookEntry — migration from old flat shape', () => {
  const scriptPath = '/usr/local/lib/node_modules/@openthink/think/dist/hooks/user-prompt-submit.js';

  it('replaces an old flat-shape entry with the correct matcher-group shape', () => {
    // Seed with the broken shape that alpha.4–alpha.8 produced
    const settings: ClaudeSettings = {
      hooks: {
        UserPromptSubmit: [
          // Cast: old shape does not satisfy HookMatcherGroup but is valid JSON
          { type: 'command', command: scriptPath } as unknown as HookMatcherGroup,
        ],
      },
    };

    const result = addHookEntry(settings, scriptPath);
    expect(result).toBe('installed');

    const ups = settings.hooks?.UserPromptSubmit as HookMatcherGroup[];
    expect(ups).toHaveLength(1);
    expect(ups[0]).toEqual({
      matcher: '',
      hooks: [{ type: 'command', command: `node "${scriptPath}"` }],
    });
  });

  it('removes old flat entry but preserves unrelated entries during migration', () => {
    const unrelated: HookMatcherGroup = { matcher: 'some-tool', hooks: [{ type: 'command', command: 'node /other/hook.js' }] };
    const settings: ClaudeSettings = {
      hooks: {
        UserPromptSubmit: [
          unrelated,
          { type: 'command', command: scriptPath } as unknown as HookMatcherGroup,
        ],
      },
    };

    addHookEntry(settings, scriptPath);

    const ups = settings.hooks?.UserPromptSubmit as HookMatcherGroup[];
    expect(ups).toHaveLength(2);
    expect(ups[0]).toEqual(unrelated);
    expect(ups[1]).toEqual({
      matcher: '',
      hooks: [{ type: 'command', command: `node "${scriptPath}"` }],
    });
  });

  it('is idempotent: running install twice on an old-shape settings produces exactly one entry', () => {
    const settings: ClaudeSettings = {
      hooks: {
        UserPromptSubmit: [
          { type: 'command', command: scriptPath } as unknown as HookMatcherGroup,
        ],
      },
    };

    addHookEntry(settings, scriptPath);
    addHookEntry(settings, scriptPath);

    const ups = settings.hooks?.UserPromptSubmit as HookMatcherGroup[];
    expect(ups).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// removeHookEntry
// ---------------------------------------------------------------------------

describe('removeHookEntry', () => {
  const scriptPath = '/usr/local/lib/node_modules/@openthink/think/dist/hooks/user-prompt-submit.js';

  it('returns not_found when settings has no hooks', () => {
    const settings: ClaudeSettings = {};
    const result = removeHookEntry(settings, scriptPath);
    expect(result).toBe('not_found');
  });

  it('returns not_found when hook is not in the list', () => {
    const settings: ClaudeSettings = {
      hooks: {
        UserPromptSubmit: [
          { matcher: 'other', hooks: [{ type: 'command', command: 'node /other/hook.js' }] },
        ],
      },
    };
    const result = removeHookEntry(settings, scriptPath);
    expect(result).toBe('not_found');
  });

  it('removes a new matcher-group entry and returns removed', () => {
    const settings: ClaudeSettings = {
      hooks: {
        UserPromptSubmit: [
          {
            matcher: '',
            hooks: [{ type: 'command', command: `node "${scriptPath}"` }],
          },
        ],
      },
    };
    const result = removeHookEntry(settings, scriptPath);
    expect(result).toBe('removed');
    expect(settings.hooks?.UserPromptSubmit).toBeUndefined();
  });

  it('removes an old flat-shape entry and returns removed (migration)', () => {
    const settings: ClaudeSettings = {
      hooks: {
        UserPromptSubmit: [
          // old broken flat shape
          { type: 'command', command: scriptPath } as unknown as HookMatcherGroup,
        ],
      },
    };
    const result = removeHookEntry(settings, scriptPath);
    expect(result).toBe('removed');
    expect(settings.hooks?.UserPromptSubmit).toBeUndefined();
  });

  it('removes only the matching entry when multiple entries exist', () => {
    const unrelated: HookMatcherGroup = { matcher: 'other', hooks: [{ type: 'command', command: 'node /other/hook.js' }] };
    const settings: ClaudeSettings = {
      hooks: {
        UserPromptSubmit: [
          unrelated,
          { matcher: '', hooks: [{ type: 'command', command: `node "${scriptPath}"` }] },
        ],
      },
    };
    removeHookEntry(settings, scriptPath);
    const ups = settings.hooks?.UserPromptSubmit as HookMatcherGroup[];
    expect(ups).toEqual([unrelated]);
  });

  it('cleans up empty hooks object after removing the last entry', () => {
    const settings: ClaudeSettings = {
      hooks: {
        UserPromptSubmit: [
          { matcher: '', hooks: [{ type: 'command', command: `node "${scriptPath}"` }] },
        ],
      },
    };
    removeHookEntry(settings, scriptPath);
    expect(settings.hooks).toBeUndefined();
  });

  it('preserves hooks object when other event types remain', () => {
    const settings: ClaudeSettings = {
      hooks: {
        UserPromptSubmit: [
          { matcher: '', hooks: [{ type: 'command', command: `node "${scriptPath}"` }] },
        ],
        OtherEvent: [{ type: 'command', command: '/other.js' }],
      },
    };
    removeHookEntry(settings, scriptPath);
    expect(settings.hooks?.OtherEvent).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// writeSettings + readSettings round-trip
// ---------------------------------------------------------------------------

describe('writeSettings + readSettings round-trip', () => {
  const scriptPath = '/usr/local/lib/node_modules/@openthink/think/dist/hooks/user-prompt-submit.js';

  it('persists and reloads the matcher-group shape correctly', () => {
    const file = path.join(tmpDir, 'settings.json');
    const settings: ClaudeSettings = {
      hooks: {
        UserPromptSubmit: [
          { matcher: '', hooks: [{ type: 'command', command: `node "${scriptPath}"` }] },
        ],
      },
    };
    writeSettings(file, settings);
    const reloaded = readSettings(file);
    expect(reloaded).toEqual(settings);
  });

  it('produces a file with mode 0o600', () => {
    const file = path.join(tmpDir, 'settings.json');
    writeSettings(file, {});
    const stat = fs.statSync(file);
    // Mask off file-type bits; check only permission bits.
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('creates parent directory if it does not exist', () => {
    const file = path.join(tmpDir, 'nested', 'dir', 'settings.json');
    writeSettings(file, { hooks: {} });
    expect(fs.existsSync(file)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateSettingsPath
// ---------------------------------------------------------------------------

describe('validateSettingsPath', () => {
  it('accepts a path inside the home directory', () => {
    const p = path.join(os.homedir(), '.claude', 'settings.json');
    expect(() => validateSettingsPath(p)).not.toThrow();
  });

  it('accepts a path inside the current working directory', () => {
    const p = path.join(process.cwd(), '.claude', 'settings.local.json');
    expect(() => validateSettingsPath(p)).not.toThrow();
  });

  it('rejects a path outside home and cwd', () => {
    expect(() => validateSettingsPath('/etc/passwd')).toThrow(/Refusing to write/);
  });
});

// ---------------------------------------------------------------------------
// Full install/uninstall lifecycle flow via real temp file
// ---------------------------------------------------------------------------

describe('install → verify → re-install (no-op) → uninstall → verify flow', () => {
  it('correctly manages lifecycle with the new matcher-group shape', () => {
    const file = path.join(tmpDir, 'settings.json');
    const scriptPath = '/usr/local/lib/node_modules/@openthink/think/dist/hooks/user-prompt-submit.js';
    const expectedCommand = `node "${scriptPath}"`;

    // 1. Install into an empty file
    const s1 = readSettings(file);
    expect(addHookEntry(s1, scriptPath)).toBe('installed');
    writeSettings(file, s1);

    // 2. Verify entry is present in the correct matcher-group shape
    const s2 = readSettings(file);
    const ups2 = s2.hooks?.UserPromptSubmit as HookMatcherGroup[];
    expect(ups2).toHaveLength(1);
    expect(ups2[0]).toEqual({
      matcher: '',
      hooks: [{ type: 'command', command: expectedCommand }],
    });

    // 3. Install again — no-op
    expect(addHookEntry(s2, scriptPath)).toBe('already_installed');
    writeSettings(file, s2);

    // 4. Verify still exactly one entry (no duplicate)
    const s3 = readSettings(file);
    expect((s3.hooks?.UserPromptSubmit as HookMatcherGroup[])?.length).toBe(1);

    // 5. Uninstall
    expect(removeHookEntry(s3, scriptPath)).toBe('removed');
    writeSettings(file, s3);

    // 6. Verify entry is gone
    const s4 = readSettings(file);
    expect(s4.hooks?.UserPromptSubmit).toBeUndefined();
  });

  it('migrates old flat-shape entries to the correct matcher-group shape on re-install', () => {
    const file = path.join(tmpDir, 'settings.json');
    const scriptPath = '/usr/local/lib/node_modules/@openthink/think/dist/hooks/user-prompt-submit.js';

    // Simulate a user who has the old broken alpha.4–alpha.8 shape on disk
    const oldSettings = {
      hooks: {
        UserPromptSubmit: [{ type: 'command', command: scriptPath }],
      },
    };
    fs.writeFileSync(file, JSON.stringify(oldSettings, null, 2));

    // Running think hook install should detect + replace the old entry
    const s1 = readSettings(file);
    const result = addHookEntry(s1, scriptPath);
    expect(result).toBe('installed');
    writeSettings(file, s1);

    // Verify the new shape is in place and the old shape is gone
    const s2 = readSettings(file);
    const ups = s2.hooks?.UserPromptSubmit as HookMatcherGroup[];
    expect(ups).toHaveLength(1);
    expect(ups[0]).toEqual({
      matcher: '',
      hooks: [{ type: 'command', command: `node "${scriptPath}"` }],
    });
  });
});
