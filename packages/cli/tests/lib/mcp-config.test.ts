/**
 * Tests for MCP config read/write helpers (AGT-317).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  readMcpConfig,
  writeMcpConfig,
  addMcpEntry,
  removeMcpEntry,
  globalMcpConfigPath,
  projectMcpConfigPath,
  type McpConfig,
} from '../../src/lib/claude-settings.js';

let tmpDir: string;

beforeEach(() => {
  const base = path.join(os.homedir(), '.think-test-tmp');
  fs.mkdirSync(base, { recursive: true });
  tmpDir = fs.mkdtempSync(path.join(base, 'mcp-config-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
describe('readMcpConfig', () => {
  it('returns empty object when file does not exist', () => {
    const result = readMcpConfig(path.join(tmpDir, 'nonexistent.json'));
    expect(result).toEqual({});
  });

  it('parses valid JSON', () => {
    const file = path.join(tmpDir, '.claude.json');
    fs.writeFileSync(file, JSON.stringify({ mcpServers: {} }));
    const result = readMcpConfig(file);
    expect(result).toEqual({ mcpServers: {} });
  });

  it('throws on malformed JSON', () => {
    const file = path.join(tmpDir, '.claude.json');
    fs.writeFileSync(file, '{ invalid }');
    expect(() => readMcpConfig(file)).toThrow(/Failed to parse/);
  });
});
describe('addMcpEntry', () => {
  const serverPath = '/usr/local/lib/node_modules/@openthink/think/dist/mcp/server.js';

  it('adds a new entry to an empty config', () => {
    const config: McpConfig = {};
    const result = addMcpEntry(config, serverPath);
    expect(result).toBe('installed');
    expect(config.mcpServers).toEqual({
      think: { command: 'node', args: [serverPath] },
    });
  });

  it('returns already_installed when called twice with same path', () => {
    const config: McpConfig = {};
    addMcpEntry(config, serverPath);
    const result = addMcpEntry(config, serverPath);
    expect(result).toBe('already_installed');
    expect(Object.keys(config.mcpServers!)).toHaveLength(1);
  });

  it('preserves other mcpServers when adding think entry', () => {
    const config: McpConfig = {
      mcpServers: { other: { command: 'node', args: ['/other/server.js'] } },
    };
    addMcpEntry(config, serverPath);
    expect(config.mcpServers!.other).toBeDefined();
    expect(config.mcpServers!.think).toEqual({ command: 'node', args: [serverPath] });
  });

  it('updates the entry when path differs', () => {
    const config: McpConfig = {};
    addMcpEntry(config, '/old/path/server.js');
    const result = addMcpEntry(config, serverPath);
    expect(result).toBe('installed');
    expect(config.mcpServers!.think.args[0]).toBe(serverPath);
  });

  it('preserves other top-level fields', () => {
    const config: McpConfig = { someOtherField: true };
    addMcpEntry(config, serverPath);
    expect((config as Record<string, unknown>).someOtherField).toBe(true);
  });
});
describe('removeMcpEntry', () => {
  const serverPath = '/usr/local/lib/node_modules/@openthink/think/dist/mcp/server.js';

  it('returns not_found when config has no mcpServers', () => {
    const config: McpConfig = {};
    expect(removeMcpEntry(config)).toBe('not_found');
  });

  it('returns not_found when think entry does not exist', () => {
    const config: McpConfig = {
      mcpServers: { other: { command: 'node', args: ['/other/server.js'] } },
    };
    expect(removeMcpEntry(config)).toBe('not_found');
  });

  it('removes the think entry and returns removed', () => {
    const config: McpConfig = {
      mcpServers: { think: { command: 'node', args: [serverPath] } },
    };
    expect(removeMcpEntry(config)).toBe('removed');
    expect(config.mcpServers).toBeUndefined();
  });

  it('preserves other mcpServers when removing think entry', () => {
    const config: McpConfig = {
      mcpServers: {
        think: { command: 'node', args: [serverPath] },
        other: { command: 'node', args: ['/other/server.js'] },
      },
    };
    removeMcpEntry(config);
    expect(config.mcpServers!.other).toBeDefined();
    expect(config.mcpServers!.think).toBeUndefined();
  });

  it('cleans up empty mcpServers after removing the last entry', () => {
    const config: McpConfig = {
      mcpServers: { think: { command: 'node', args: [serverPath] } },
    };
    removeMcpEntry(config);
    expect(config.mcpServers).toBeUndefined();
  });
});
describe('writeMcpConfig + readMcpConfig round-trip', () => {
  it('persists and reloads config correctly', () => {
    const file = path.join(tmpDir, '.claude.json');
    const serverPath = '/usr/local/lib/node_modules/@openthink/think/dist/mcp/server.js';
    const config: McpConfig = {
      mcpServers: { think: { command: 'node', args: [serverPath] } },
    };
    writeMcpConfig(file, config);
    const reloaded = readMcpConfig(file);
    expect(reloaded).toEqual(config);
  });

  it('produces a file with mode 0o600', () => {
    const file = path.join(tmpDir, '.claude.json');
    writeMcpConfig(file, {});
    const stat = fs.statSync(file);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('creates parent directory if it does not exist', () => {
    const file = path.join(tmpDir, 'nested', '.claude.json');
    writeMcpConfig(file, {});
    expect(fs.existsSync(file)).toBe(true);
  });

  it('preserves non-mcpServers fields on round-trip', () => {
    const file = path.join(tmpDir, '.claude.json');
    const config: McpConfig = {
      someOtherField: 'preserved',
      mcpServers: { think: { command: 'node', args: ['/path/server.js'] } },
    };
    writeMcpConfig(file, config);
    const reloaded = readMcpConfig(file);
    expect((reloaded as Record<string, unknown>).someOtherField).toBe('preserved');
  });
});
describe('install -> verify -> re-install (no-op) -> uninstall -> verify flow', () => {
  it('correctly manages full lifecycle of an MCP server entry in a file', () => {
    const file = path.join(tmpDir, '.claude.json');
    const serverPath = '/usr/local/lib/node_modules/@openthink/think/dist/mcp/server.js';

    const c1 = readMcpConfig(file);
    expect(addMcpEntry(c1, serverPath)).toBe('installed');
    writeMcpConfig(file, c1);

    const c2 = readMcpConfig(file);
    expect(c2.mcpServers?.think).toEqual({ command: 'node', args: [serverPath] });

    expect(addMcpEntry(c2, serverPath)).toBe('already_installed');
    writeMcpConfig(file, c2);

    const c3 = readMcpConfig(file);
    expect(Object.keys(c3.mcpServers!)).toHaveLength(1);

    expect(removeMcpEntry(c3)).toBe('removed');
    writeMcpConfig(file, c3);

    const c4 = readMcpConfig(file);
    expect(c4.mcpServers).toBeUndefined();
  });
});

describe('path resolution', () => {
  it('globalMcpConfigPath returns ~/.claude.json', () => {
    const p = globalMcpConfigPath();
    expect(p).toBe(path.join(os.homedir(), '.claude.json'));
  });

  it('projectMcpConfigPath returns <cwd>/.mcp.json', () => {
    const p = projectMcpConfigPath();
    expect(p).toBe(path.join(process.cwd(), '.mcp.json'));
  });
});