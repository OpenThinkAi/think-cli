/**
 * Unit tests for checkClaudeIntegration() — AGT-1308 AC1/AC5.
 *
 * Every path is injected, so this suite reads only temp files — never the
 * developer's real `~/.claude/settings.json` or `~/.claude.json` — and writes
 * nothing at all: the check is read-only and reports `fixable: false`, because
 * editing another tool's settings file is `think hook install`'s job.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkClaudeIntegration,
  CLAUDE_INTEGRATION_CHECK_ID,
} from '../../../src/lib/doctor/claude-integration.js';

const HOOK = '/opt/npm/lib/node_modules/@openthink/think/dist/hooks/user-prompt-submit.js';
const MCP = '/opt/npm/lib/node_modules/@openthink/think/dist/mcp/server.js';

describe('checkClaudeIntegration (AGT-1308)', () => {
  let dir: string;
  let settingsPath: string;
  let mcpConfigPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'think-doctor-claude-'));
    settingsPath = join(dir, 'settings.json');
    mcpConfigPath = join(dir, '.claude.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSettings(value: unknown): void {
    writeFileSync(settingsPath, JSON.stringify(value), 'utf-8');
  }

  function writeMcp(value: unknown): void {
    writeFileSync(mcpConfigPath, JSON.stringify(value), 'utf-8');
  }

  function check() {
    return checkClaudeIntegration({
      settingsPath,
      mcpConfigPath,
      hookScriptPath: HOOK,
      mcpServerPath: MCP,
    });
  }

  function writeHealthy(): void {
    writeSettings({
      hooks: { UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: `node "${HOOK}"` }] }] },
    });
    writeMcp({ mcpServers: { think: { command: 'node', args: [MCP] } } });
  }

  it('passes when both entries point at the installed build', () => {
    writeHealthy();

    expect(check()).toEqual({
      id: CLAUDE_INTEGRATION_CHECK_ID,
      status: 'pass',
      detail: 'UserPromptSubmit hook and MCP entry both point at the installed build.',
      fixable: false,
    });
  });

  it('AC5: reporting writes nothing', () => {
    writeHealthy();
    const before = readdirSync(dir).sort();

    check();

    expect(readdirSync(dir).sort()).toEqual(before);
  });

  it('accepts the legacy flat hook shape', () => {
    writeSettings({ hooks: { UserPromptSubmit: [{ type: 'command', command: HOOK }] } });
    writeMcp({ mcpServers: { think: { command: 'node', args: [MCP] } } });

    expect(check().status).toBe('pass');
  });

  it('warns, unfixable, when the settings file is absent', () => {
    writeMcp({ mcpServers: { think: { command: 'node', args: [MCP] } } });

    const result = check();

    expect(result.status).toBe('warn');
    expect(result.fixable).toBe(false);
    expect(result.detail).toContain('no Claude settings file');
    expect(result.detail).toContain('think hook install');
  });

  it('warns when the hook points at another install prefix', () => {
    // The whole failure mode: right basename, wrong prefix. A basename match
    // would call this healthy.
    const stale = '/usr/local/lib/node_modules/@openthink/think/dist/hooks/user-prompt-submit.js';
    writeSettings({
      hooks: { UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: `node "${stale}"` }] }] },
    });
    writeMcp({ mcpServers: { think: { command: 'node', args: [MCP] } } });

    const result = check();

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('points at another build');
    expect(result.detail).toContain(stale);
  });

  it('warns when no think hook is registered but other hooks are', () => {
    writeSettings({
      hooks: { UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: 'node "/other/tool.js"' }] }] },
    });
    writeMcp({ mcpServers: { think: { command: 'node', args: [MCP] } } });

    const result = check();

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('no think UserPromptSubmit hook registered');
  });

  it('warns when the MCP entry is missing', () => {
    writeSettings({
      hooks: { UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: `node "${HOOK}"` }] }] },
    });
    writeMcp({ mcpServers: { other: { command: 'node', args: ['/other/server.js'] } } });

    const result = check();

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('no `think` MCP server registered');
  });

  it('warns when the MCP entry points at another build', () => {
    writeSettings({
      hooks: { UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: `node "${HOOK}"` }] }] },
    });
    writeMcp({ mcpServers: { think: { command: 'node', args: ['/elsewhere/dist/mcp/server.js'] } } });

    const result = check();

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('/elsewhere/dist/mcp/server.js');
  });

  it('reports an unparseable settings file distinctly from a missing one', () => {
    writeFileSync(settingsPath, '{ not json', 'utf-8');
    writeMcp({ mcpServers: { think: { command: 'node', args: [MCP] } } });

    const result = check();

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('could not read');
  });

  it('reports both halves when both are wrong', () => {
    writeSettings({});
    writeMcp({});

    const result = check();

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('UserPromptSubmit');
    expect(result.detail).toContain('MCP');
  });

});
