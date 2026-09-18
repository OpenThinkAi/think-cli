/**
 * Check: the `UserPromptSubmit` hook and the `think` MCP entry are present and
 * point at the INSTALLED build (AGT-1308 AC1).
 *
 * Both are absolute paths written into files think does not own
 * (`~/.claude/settings.json`, `~/.claude.json`). Reinstalling under a different
 * npm prefix, or moving between a global install and `npm link`, leaves an
 * entry that still parses, still loads, and silently points at a `dist/` that
 * is gone or stale — the hook stops injecting context and nobody is told.
 *
 * "Points at the installed build" is exact-path equality against
 * `resolveHookScriptPath()` / `resolveMcpServerPath()`, which are what
 * `think hook install` and `think mcp install` write. A basename match is
 * deliberately NOT enough here: the whole failure mode is a right-named file
 * under the wrong prefix.
 *
 * Never fixable. Writing into another tool's settings file is `think hook
 * install` / `think mcp install` — an explicit act, not something `--fix`
 * should do behind the user's back (and AC5 keeps doctor out of any file
 * outside managed markers).
 */

import fs from 'node:fs';
import {
  globalSettingsPath,
  globalMcpConfigPath,
  resolveHookScriptPath,
  resolveMcpServerPath,
} from '../claude-settings.js';
import { result, type CheckResult } from './types.js';

export const CLAUDE_INTEGRATION_CHECK_ID = 'claude-integration';

export interface ClaudeIntegrationOptions {
  /** `~/.claude/settings.json`. Tests MUST inject a temp path. */
  settingsPath?: string;
  /** `~/.claude.json`. Tests MUST inject a temp path. */
  mcpConfigPath?: string;
  /** Absolute path of the installed hook script. */
  hookScriptPath?: string;
  /** Absolute path of the installed MCP server script. */
  mcpServerPath?: string;
}

export function checkClaudeIntegration(options: ClaudeIntegrationOptions = {}): CheckResult {
  const settingsPath = options.settingsPath ?? globalSettingsPath();
  const mcpConfigPath = options.mcpConfigPath ?? globalMcpConfigPath();
  const hookScriptPath = options.hookScriptPath ?? safeResolve(resolveHookScriptPath);
  const mcpServerPath = options.mcpServerPath ?? safeResolve(resolveMcpServerPath);

  const problems: string[] = [];

  if (hookScriptPath === null) {
    problems.push('could not resolve the installed hook script path');
  } else {
    problems.push(...hookProblems(settingsPath, hookScriptPath));
  }

  if (mcpServerPath === null) {
    problems.push('could not resolve the installed MCP server path');
  } else {
    problems.push(...mcpProblems(mcpConfigPath, mcpServerPath));
  }

  if (problems.length === 0) {
    return result(
      CLAUDE_INTEGRATION_CHECK_ID,
      'pass',
      'UserPromptSubmit hook and MCP entry both point at the installed build.',
    );
  }

  return result(
    CLAUDE_INTEGRATION_CHECK_ID,
    'warn',
    `${problems.join('; ')}. Re-run \`think hook install\` / \`think mcp install\`.`,
    false,
  );
}

/** What is wrong with the hook registration, if anything. */
function hookProblems(settingsPath: string, hookScriptPath: string): string[] {
  const settings = readJson(settingsPath);
  if (settings === 'missing') return [`no Claude settings file at ${settingsPath}`];
  if (settings === 'unreadable') return [`could not read ${settingsPath}`];

  const hooks = asRecord(settings['hooks']);
  const entries = hooks === null ? undefined : hooks['UserPromptSubmit'];
  if (!Array.isArray(entries) || entries.length === 0) {
    return [`no UserPromptSubmit hook registered in ${settingsPath}`];
  }

  // Collect every command string, in either the old flat shape or the current
  // matcher-group shape, so a legacy entry is recognised as "ours" rather than
  // reported as missing.
  const commands: string[] = [];
  for (const entry of entries) {
    const record = asRecord(entry);
    if (record === null) continue;
    if (typeof record['command'] === 'string') commands.push(record['command']);
    if (Array.isArray(record['hooks'])) {
      for (const inner of record['hooks']) {
        const innerRecord = asRecord(inner);
        if (innerRecord !== null && typeof innerRecord['command'] === 'string') {
          commands.push(innerRecord['command']);
        }
      }
    }
  }

  if (commands.some((command) => command.includes(hookScriptPath))) return [];

  const ours = commands.filter((command) => command.includes('user-prompt-submit'));
  if (ours.length > 0) {
    return [`the UserPromptSubmit hook points at another build (${ours.join(', ')}), not ${hookScriptPath}`];
  }
  return [`no think UserPromptSubmit hook registered in ${settingsPath}`];
}

/** What is wrong with the MCP registration, if anything. */
function mcpProblems(mcpConfigPath: string, mcpServerPath: string): string[] {
  const config = readJson(mcpConfigPath);
  if (config === 'missing') return [`no MCP config file at ${mcpConfigPath}`];
  if (config === 'unreadable') return [`could not read ${mcpConfigPath}`];

  const servers = asRecord(config['mcpServers']);
  const entry = servers === null ? null : asRecord(servers['think']);
  if (entry === null) return [`no \`think\` MCP server registered in ${mcpConfigPath}`];

  const args = entry['args'];
  const first = Array.isArray(args) && typeof args[0] === 'string' ? args[0] : null;
  if (first === mcpServerPath) return [];
  if (first === null) return [`the \`think\` MCP entry in ${mcpConfigPath} has no script path`];
  return [`the \`think\` MCP entry points at another build (${first}), not ${mcpServerPath}`];
}

/**
 * Read a JSON object, distinguishing "not there" from "there but unusable" —
 * an unparseable settings file is a different conversation from an absent one,
 * and both are different from a well-formed file missing our entry.
 */
function readJson(filePath: string): Record<string, unknown> | 'missing' | 'unreadable' {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return asRecord(parsed) ?? 'unreadable';
  } catch {
    return 'unreadable';
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** The resolvers walk for a package sentinel and throw when they cannot find
 *  one (a source checkout with no `dist/`). That is reportable, not fatal. */
function safeResolve(resolver: () => string): string | null {
  try {
    return resolver();
  } catch {
    return null;
  }
}
