/**
 * Helpers for reading and writing Claude Code settings files
 * (global `~/.claude/settings.json` and project-local
 * `.claude/settings.local.json`).
 *
 * Claude Code settings files are JSON (strict — no comments, no trailing
 * commas). The format has not shipped a stable JSONC variant in the wild;
 * if the caller encounters a comment-bearing file they will receive a clear
 * parse error rather than a silent corruption. We document this constraint
 * in `--help` for `think hook install`.
 *
 * Write safety: modifications are written to a temp file beside the target,
 * then atomically renamed into place. A partial write (OOM, SIGKILL) never
 * corrupts the existing settings.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolvePackageEntry } from './pkg-paths.js';

/** The shape of a single hook command entry (inner item in a matcher-group). */
export interface HookCommandEntry {
  type: 'command';
  command: string;
}

/**
 * The shape of a hook matcher-group as required by Claude Code.
 *
 * Claude Code's settings schema wraps each hook command in a matcher-group
 * object.  A flat `{ type, command }` entry at the top level is the OLD
 * (broken) shape that triggers `/doctor` warnings.  The correct shape is:
 *
 * ```jsonc
 * { "matcher": "", "hooks": [{ "type": "command", "command": "node \"…\"" }] }
 * ```
 *
 * An empty-string `matcher` means "always fire", which is appropriate for
 * `UserPromptSubmit` context injection.
 */
export interface HookMatcherGroup {
  matcher: string;
  hooks: HookCommandEntry[];
}

/** Minimal subset of the Claude Code settings shape we care about. */
export interface ClaudeSettings {
  hooks?: {
    UserPromptSubmit?: HookMatcherGroup[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** The shape of a single MCP server entry. */
export interface McpServerEntry {
  command: string;
  args: string[];
}

/** Minimal subset of the ~/.claude.json / .mcp.json shape we care about. */
export interface McpConfig {
  mcpServers?: {
    [name: string]: McpServerEntry;
  };
  [key: string]: unknown;
}

/**
 * Resolve the absolute path of the global Claude Code settings file.
 * Respects CLAUDE_CONFIG_DIR for non-standard setups.
 */
export function globalSettingsPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  return path.join(configDir, 'settings.json');
}

/**
 * Resolve the absolute path of the project-local settings file
 * (`<cwd>/.claude/settings.local.json`).
 */
export function projectSettingsPath(): string {
  return path.join(process.cwd(), '.claude', 'settings.local.json');
}

/**
 * Resolve the absolute path of the global MCP config file (`~/.claude.json`).
 */
export function globalMcpConfigPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

/**
 * Resolve the absolute path of the project-local MCP config file
 * (`<cwd>/.mcp.json`).
 */
export function projectMcpConfigPath(): string {
  return path.join(process.cwd(), '.mcp.json');
}

/**
 * Validate that `target` does not escape the home directory or the project
 * working directory. This is a defense-in-depth check — callers should only
 * pass paths produced by `globalSettingsPath()` or `projectSettingsPath()`,
 * but we verify anyway before any write.
 *
 * Throws with a descriptive message if the path escapes the allowed roots.
 */
export function validateSettingsPath(target: string): void {
  const homeDir = os.homedir();
  const cwd = process.cwd();
  const resolved = path.resolve(target);

  const underHome = resolved.startsWith(homeDir + path.sep) || resolved === homeDir;
  const underCwd = resolved.startsWith(cwd + path.sep) || resolved === cwd;

  if (!underHome && !underCwd) {
    throw new Error(
      `Refusing to write to ${resolved}: path is outside the home directory and the current working directory. ` +
        `This is a safety check — if you intended a different path, set CLAUDE_CONFIG_DIR.`,
    );
  }
}

/**
 * Read and parse a settings file. Returns an empty object if the file does
 * not exist. Throws with a clear message on malformed JSON.
 */
export function readSettings(filePath: string): ClaudeSettings {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read ${filePath}: ${(err as NodeJS.ErrnoException).message}`);
  }

  try {
    return JSON.parse(raw) as ClaudeSettings;
  } catch (err) {
    throw new Error(
      `Failed to parse ${filePath}: ${(err as Error).message}. ` +
        `Claude Code settings files must be strict JSON (no comments, no trailing commas).`,
    );
  }
}

/**
 * Read and parse an MCP config file (`~/.claude.json` or `.mcp.json`).
 * Returns an empty object if the file does not exist.
 * Throws with a clear message on malformed JSON.
 */
export function readMcpConfig(filePath: string): McpConfig {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read ${filePath}: ${(err as NodeJS.ErrnoException).message}`);
  }

  try {
    return JSON.parse(raw) as McpConfig;
  } catch (err) {
    throw new Error(
      `Failed to parse ${filePath}: ${(err as Error).message}. ` +
        `MCP config files must be strict JSON (no comments, no trailing commas).`,
    );
  }
}

/**
 * Internal: atomically write JSON data to filePath with mode 0o600.
 * Writes to a sibling .tmp-<random> file first, then renames into place.
 * A crash leaves either the old file untouched or the new file fully in place.
 */
function writeJsonFile(filePath: string, data: object): void {
  validateSettingsPath(filePath);

  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tmp = `${filePath}.tmp-${Math.random().toString(36).slice(2)}`;
  const serialized = JSON.stringify(data, null, 2) + '\n';

  try {
    fs.writeFileSync(tmp, serialized, { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/** Atomically write settings to filePath (write safety: see writeJsonFile). */
export function writeSettings(filePath: string, settings: ClaudeSettings): void {
  writeJsonFile(filePath, settings);
}

/** Atomically write MCP config to filePath (write safety: see writeJsonFile). */
export function writeMcpConfig(filePath: string, config: McpConfig): void {
  writeJsonFile(filePath, config);
}

/**
 * Add a `think` MCP server entry to the given config.
 *
 * - If the entry already exists with the same `args[0]` path, returns 'already_installed'.
 * - Otherwise adds/replaces the entry and returns 'installed'.
 */
export function addMcpEntry(
  config: McpConfig,
  serverScriptPath: string,
): 'installed' | 'already_installed' {
  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  const existing = config.mcpServers['think'];
  if (existing && existing.args?.[0] === serverScriptPath) {
    return 'already_installed';
  }

  config.mcpServers['think'] = { command: 'node', args: [serverScriptPath] };
  return 'installed';
}

/**
 * Remove the `think` MCP server entry from the given config.
 *
 * Returns 'removed' if found and removed, 'not_found' otherwise.
 * Cleans up empty `mcpServers` objects.
 */
export function removeMcpEntry(config: McpConfig): 'removed' | 'not_found' {
  if (!config.mcpServers || !('think' in config.mcpServers)) {
    return 'not_found';
  }

  delete config.mcpServers['think'];
  if (Object.keys(config.mcpServers).length === 0) {
    delete config.mcpServers;
  }

  return 'removed';
}

/**
 * Build the shell command string for the hook script.
 *
 * Claude Code executes `command` via shell, so a bare `.js` path won't run.
 * We prefix with `node` and quote the path so it survives spaces in the
 * install prefix (e.g. "/Users/some name/.npm-global/…"). Any embedded `"`
 * in the path is backslash-escaped so a pathological path can't break out
 * of the quoted string.
 */
function buildHookCommand(scriptPath: string): string {
  const escaped = scriptPath.replace(/"/g, '\\"');
  return `node "${escaped}"`;
}

/**
 * Return true if an entry in either the old (flat) shape or the new
 * (matcher-group) shape references the hook script identified by
 * `scriptBasename`.
 *
 * Old flat shape:  `{ type: 'command', command: '/abs/path/<basename>' }`
 * New shape:       `{ matcher: '', hooks: [{ type: 'command', command: 'node "…/<basename>"' }] }`
 *
 * Matches on the basename substring so that the same logic catches:
 *   - bare-path entries from the old shape,
 *   - `node "…"`-wrapped entries from the new shape,
 *   - entries written by a different install prefix (different absolute path,
 *     same basename — useful when a user reinstalls under a different npm
 *     prefix and we want the upgrade to clean up the stale entry).
 *
 * The basename is supplied by the caller from `resolveHookScriptPath()` so
 * the match always tracks whatever the current build emits — no hardcoding.
 */
function isOurHookEntry(entry: unknown, scriptBasename: string): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as Record<string, unknown>;

  // Old flat shape
  if (typeof e['command'] === 'string' && e['command'].includes(scriptBasename)) {
    return true;
  }

  // New matcher-group shape
  if (Array.isArray(e['hooks'])) {
    return (e['hooks'] as unknown[]).some(
      (inner) =>
        typeof inner === 'object' &&
        inner !== null &&
        typeof (inner as Record<string, unknown>)['command'] === 'string' &&
        ((inner as Record<string, unknown>)['command'] as string).includes(scriptBasename),
    );
  }

  return false;
}

/**
 * Add a `UserPromptSubmit` hook entry for the given script path.
 *
 * Writes the correct matcher-group shape required by Claude Code:
 *   `{ matcher: '', hooks: [{ type: 'command', command: 'node "…"' }] }`
 *
 * Migration: any existing entries in either the old flat shape or the new
 * matcher-group shape that reference `user-prompt-submit.js` are removed
 * first, then the single correct entry is added.  This makes re-running
 * `think hook install` idempotent and self-healing for users on alpha.4–alpha.8.
 *
 * Unrelated `UserPromptSubmit` entries (hooks not from think) are preserved.
 *
 * Returns `'already_installed'` if our entry is already present in the
 * correct shape (no changes needed), `'installed'` otherwise.
 */
export function addHookEntry(
  settings: ClaudeSettings,
  scriptPath: string,
): 'installed' | 'already_installed' {
  if (!settings.hooks) {
    settings.hooks = {};
  }
  if (!settings.hooks.UserPromptSubmit) {
    settings.hooks.UserPromptSubmit = [];
  }

  const existing = settings.hooks.UserPromptSubmit as unknown[];
  const expectedCommand = buildHookCommand(scriptPath);

  // Check if the correct new-shape entry is already present
  const alreadyCorrect = existing.some(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      (entry as Record<string, unknown>)['matcher'] === '' &&
      Array.isArray((entry as Record<string, unknown>)['hooks']) &&
      ((entry as Record<string, unknown>)['hooks'] as unknown[]).some(
        (inner) =>
          typeof inner === 'object' &&
          inner !== null &&
          (inner as Record<string, unknown>)['command'] === expectedCommand,
      ),
  );

  if (alreadyCorrect) {
    return 'already_installed';
  }

  // Remove any existing entries (old flat shape or new shape) pointing at our script
  const scriptBasename = path.basename(scriptPath);
  const cleaned = existing.filter((entry) => !isOurHookEntry(entry, scriptBasename));

  // Add the correct matcher-group entry
  cleaned.push({
    matcher: '',
    hooks: [{ type: 'command', command: expectedCommand }],
  } as unknown as HookMatcherGroup);

  settings.hooks.UserPromptSubmit = cleaned as HookMatcherGroup[];
  return 'installed';
}

/**
 * Remove all `UserPromptSubmit` hook entries pointing at the hook script
 * identified by `scriptPath`.
 *
 * Match is by basename (`path.basename(scriptPath)`), which covers both:
 *   - the old flat shape (alpha.4–alpha.8): `{ type: 'command', command: '<path>' }`
 *   - the new matcher-group shape: `{ matcher: '', hooks: [{ type, command: 'node "<path>"' }] }`
 *
 * Basename matching also catches stale entries written by a different install
 * prefix on the same machine (e.g. a user who switched npm prefix between
 * installs), which is the upgrade-self-heal case this function exists for.
 * Unrelated `UserPromptSubmit` entries (hooks not from think) are preserved.
 *
 * Returns `'removed'` if at least one entry was removed, `'not_found'` otherwise.
 * Cleans up empty `UserPromptSubmit` arrays and empty `hooks` objects.
 */
export function removeHookEntry(
  settings: ClaudeSettings,
  scriptPath: string,
): 'removed' | 'not_found' {
  const list = settings.hooks?.UserPromptSubmit as unknown[] | undefined;
  if (!list) return 'not_found';

  const scriptBasename = path.basename(scriptPath);
  const before = list.length;
  const after = list.filter((entry) => !isOurHookEntry(entry, scriptBasename));
  if (after.length === before) return 'not_found';

  if (after.length === 0) {
    delete settings.hooks!.UserPromptSubmit;
  } else {
    settings.hooks!.UserPromptSubmit = after as HookMatcherGroup[];
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  return 'removed';
}

/**
 * Resolve the absolute path to the installed `user-prompt-submit.js` hook
 * script.
 *
 * Uses the same package-root sentinel-walk as `daemon-client.ts` so the path
 * is correct regardless of how Node resolves the `think` binary — global npm
 * install, `npm link`, nvm-shim, or direct invocation. The previous
 * `process.argv[1]`-based approach broke on globally-installed npm packages
 * because `process.argv[1]` resolves to the `bin/` symlink directory, not the
 * `dist/` directory where the hook script lives.
 */
export function resolveHookScriptPath(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return resolvePackageEntry(path.dirname(thisFile), 'dist', 'hooks', 'user-prompt-submit.js');
}

/**
 * Resolve the absolute path to the installed `mcp/server.js` script.
 *
 * Uses the same package-root sentinel-walk as `daemon-client.ts` so the path
 * is correct regardless of how Node resolves the `think` binary. The previous
 * `process.argv[1]`-based approach broke on globally-installed npm packages
 * because `process.argv[1]` resolves to the `bin/` symlink directory, not the
 * `dist/` directory where the MCP server script lives.
 */
export function resolveMcpServerPath(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return resolvePackageEntry(path.dirname(thisFile), 'dist', 'mcp', 'server.js');
}
