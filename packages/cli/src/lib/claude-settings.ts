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

/** The shape of a single hook command entry in Claude Code's settings. */
export interface HookCommandEntry {
  type: 'command';
  command: string;
}

/** Minimal subset of the Claude Code settings shape we care about. */
export interface ClaudeSettings {
  hooks?: {
    UserPromptSubmit?: HookCommandEntry[];
    [key: string]: unknown;
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
 * Atomically write `settings` to `filePath`.
 *
 * Writes to a sibling `.tmp-<random>` file first, then `rename()`s into
 * place. The rename is atomic on POSIX systems — a crash between the two
 * steps leaves either the old file untouched or the new file fully in place.
 */
export function writeSettings(filePath: string, settings: ClaudeSettings): void {
  validateSettingsPath(filePath);

  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tmp = `${filePath}.tmp-${Math.random().toString(36).slice(2)}`;
  const serialized = JSON.stringify(settings, null, 2) + '\n';

  try {
    fs.writeFileSync(tmp, serialized, { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch (err) {
    // Clean up the temp file if it exists.
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Add a `UserPromptSubmit` hook entry for the given command path.
 *
 * - If the entry is already present (same `command`), returns `'already_installed'`.
 * - Otherwise merges the new entry into the existing list and returns `'installed'`.
 */
export function addHookEntry(
  settings: ClaudeSettings,
  commandPath: string,
): 'installed' | 'already_installed' {
  if (!settings.hooks) {
    settings.hooks = {};
  }
  if (!settings.hooks.UserPromptSubmit) {
    settings.hooks.UserPromptSubmit = [];
  }

  const existing = settings.hooks.UserPromptSubmit;
  const alreadyPresent = existing.some((e) => e.command === commandPath);
  if (alreadyPresent) {
    return 'already_installed';
  }

  existing.push({ type: 'command', command: commandPath });
  return 'installed';
}

/**
 * Remove the `UserPromptSubmit` hook entry for the given command path.
 *
 * Returns `'removed'` if an entry was found and removed, `'not_found'` otherwise.
 * Cleans up empty `UserPromptSubmit` arrays and empty `hooks` objects.
 */
export function removeHookEntry(
  settings: ClaudeSettings,
  commandPath: string,
): 'removed' | 'not_found' {
  const list = settings.hooks?.UserPromptSubmit;
  if (!list) return 'not_found';

  const before = list.length;
  const after = list.filter((e) => e.command !== commandPath);
  if (after.length === before) return 'not_found';

  if (after.length === 0) {
    delete settings.hooks!.UserPromptSubmit;
  } else {
    settings.hooks!.UserPromptSubmit = after;
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  return 'removed';
}

/**
 * Resolve the absolute path to the installed `user-prompt-submit.js` hook
 * script. The hook ships alongside the `think` binary at:
 *
 *   <dir-of-think-binary>/hooks/user-prompt-submit.js
 *
 * `process.argv[1]` is the path to the running `think` binary (e.g.
 * `/usr/local/lib/node_modules/@openthink/think/dist/index.js`).
 */
export function resolveHookScriptPath(): string {
  const thinkBin = process.argv[1];
  if (!thinkBin) {
    throw new Error('Cannot resolve hook script path: process.argv[1] is not set.');
  }
  return path.join(path.dirname(thinkBin), 'hooks', 'user-prompt-submit.js');
}
