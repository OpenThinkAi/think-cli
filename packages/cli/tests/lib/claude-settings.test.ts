/**
 * Tests for the Claude Code settings read/write helpers (AGT-313).
 *
 * Covers:
 *  - readSettings: missing file, valid JSON, malformed JSON
 *  - addHookEntry: new entry, idempotent (no duplicate), multiple entries coexist
 *  - removeHookEntry: found, not found, cleans up empty structures
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
// addHookEntry
// ---------------------------------------------------------------------------

describe('addHookEntry', () => {
  it('adds a new entry to an empty settings object', () => {
    const settings: ClaudeSettings = {};
    const result = addHookEntry(settings, '/usr/local/bin/hook.js');
    expect(result).toBe('installed');
    expect(settings.hooks?.UserPromptSubmit).toEqual([
      { type: 'command', command: '/usr/local/bin/hook.js' },
    ]);
  });

  it('returns already_installed and does not duplicate when the same command is added twice', () => {
    const settings: ClaudeSettings = {};
    addHookEntry(settings, '/usr/local/bin/hook.js');
    const result = addHookEntry(settings, '/usr/local/bin/hook.js');
    expect(result).toBe('already_installed');
    expect(settings.hooks?.UserPromptSubmit?.length).toBe(1);
  });

  it('appends a new entry when other entries already exist', () => {
    const settings: ClaudeSettings = {
      hooks: {
        UserPromptSubmit: [{ type: 'command', command: '/other/hook.js' }],
      },
    };
    addHookEntry(settings, '/usr/local/bin/hook.js');
    expect(settings.hooks?.UserPromptSubmit?.length).toBe(2);
    expect(settings.hooks?.UserPromptSubmit?.[1]).toEqual({
      type: 'command',
      command: '/usr/local/bin/hook.js',
    });
  });

  it('preserves other hooks keys when adding UserPromptSubmit', () => {
    const settings: ClaudeSettings = {
      hooks: { OtherEvent: [{ type: 'command', command: '/other.js' }] },
    };
    addHookEntry(settings, '/usr/local/bin/hook.js');
    expect(settings.hooks?.OtherEvent).toBeDefined();
    expect(settings.hooks?.UserPromptSubmit?.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// removeHookEntry
// ---------------------------------------------------------------------------

describe('removeHookEntry', () => {
  it('returns not_found when settings has no hooks', () => {
    const settings: ClaudeSettings = {};
    const result = removeHookEntry(settings, '/usr/local/bin/hook.js');
    expect(result).toBe('not_found');
  });

  it('returns not_found when hook is not in the list', () => {
    const settings: ClaudeSettings = {
      hooks: {
        UserPromptSubmit: [{ type: 'command', command: '/other/hook.js' }],
      },
    };
    const result = removeHookEntry(settings, '/usr/local/bin/hook.js');
    expect(result).toBe('not_found');
  });

  it('removes the matching entry and returns removed', () => {
    const settings: ClaudeSettings = {
      hooks: {
        UserPromptSubmit: [{ type: 'command', command: '/usr/local/bin/hook.js' }],
      },
    };
    const result = removeHookEntry(settings, '/usr/local/bin/hook.js');
    expect(result).toBe('removed');
    expect(settings.hooks?.UserPromptSubmit).toBeUndefined();
  });

  it('removes only the matching entry when multiple entries exist', () => {
    const settings: ClaudeSettings = {
      hooks: {
        UserPromptSubmit: [
          { type: 'command', command: '/other/hook.js' },
          { type: 'command', command: '/usr/local/bin/hook.js' },
        ],
      },
    };
    removeHookEntry(settings, '/usr/local/bin/hook.js');
    expect(settings.hooks?.UserPromptSubmit).toEqual([
      { type: 'command', command: '/other/hook.js' },
    ]);
  });

  it('cleans up empty hooks object after removing the last entry', () => {
    const settings: ClaudeSettings = {
      hooks: {
        UserPromptSubmit: [{ type: 'command', command: '/usr/local/bin/hook.js' }],
      },
    };
    removeHookEntry(settings, '/usr/local/bin/hook.js');
    expect(settings.hooks).toBeUndefined();
  });

  it('preserves hooks object when other event types remain', () => {
    const settings: ClaudeSettings = {
      hooks: {
        UserPromptSubmit: [{ type: 'command', command: '/usr/local/bin/hook.js' }],
        OtherEvent: [{ type: 'command', command: '/other.js' }],
      },
    };
    removeHookEntry(settings, '/usr/local/bin/hook.js');
    expect(settings.hooks?.OtherEvent).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// writeSettings + readSettings round-trip
// ---------------------------------------------------------------------------

describe('writeSettings + readSettings round-trip', () => {
  it('persists and reloads settings correctly', () => {
    const file = path.join(tmpDir, 'settings.json');
    const settings: ClaudeSettings = {
      hooks: {
        UserPromptSubmit: [{ type: 'command', command: '/usr/local/bin/hook.js' }],
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
// Full install/uninstall flow via real temp file
// ---------------------------------------------------------------------------

describe('install → verify → re-install (no-op) → uninstall → verify flow', () => {
  it('correctly manages lifecycle of a hook entry in a file', () => {
    const file = path.join(tmpDir, 'settings.json');
    const hookPath = '/usr/local/lib/node_modules/@openthink/think/dist/hooks/user-prompt-submit.js';

    // 1. Install into an empty file
    const s1 = readSettings(file);
    expect(addHookEntry(s1, hookPath)).toBe('installed');
    writeSettings(file, s1);

    // 2. Verify entry is present
    const s2 = readSettings(file);
    expect(s2.hooks?.UserPromptSubmit).toEqual([{ type: 'command', command: hookPath }]);

    // 3. Install again — no-op
    expect(addHookEntry(s2, hookPath)).toBe('already_installed');
    writeSettings(file, s2);

    // 4. Verify still exactly one entry (no duplicate)
    const s3 = readSettings(file);
    expect(s3.hooks?.UserPromptSubmit?.length).toBe(1);

    // 5. Uninstall
    expect(removeHookEntry(s3, hookPath)).toBe('removed');
    writeSettings(file, s3);

    // 6. Verify entry is gone
    const s4 = readSettings(file);
    expect(s4.hooks?.UserPromptSubmit).toBeUndefined();
  });
});
