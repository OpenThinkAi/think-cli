/**
 * `think hook` — install / uninstall the Claude Code UserPromptSubmit hook.
 *
 * AGT-313
 *
 * Subcommands:
 *   think hook install [--project]
 *   think hook uninstall [--project]
 *
 * Without --project the target is the global Claude Code settings file at
 * ~/.claude/settings.json (or $CLAUDE_CONFIG_DIR/settings.json).
 *
 * With --project the target is <cwd>/.claude/settings.local.json.
 */

import fs from 'node:fs';
import { Command } from 'commander';
import {
  globalSettingsPath,
  projectSettingsPath,
  readSettings,
  writeSettings,
  addHookEntry,
  removeHookEntry,
  resolveHookScriptPath,
} from '../lib/claude-settings.js';

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

const installSubcommand = new Command('install')
  .description('Register the think UserPromptSubmit hook in Claude Code settings.')
  .option(
    '--project',
    'Target <cwd>/.claude/settings.local.json instead of ~/.claude/settings.json',
  )
  .action((opts: { project?: boolean }) => {
    const settingsFile = opts.project ? projectSettingsPath() : globalSettingsPath();

    let hookScript: string;
    try {
      hookScript = resolveHookScriptPath();
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }

    // Guard: if the hook script does not exist on disk (e.g. partial install or
    // dev build without compiling), registering it would leave Claude Code with
    // a broken hook path. Abort with a clear error rather than silently writing
    // a dangling entry.
    if (!fs.existsSync(hookScript)) {
      console.error(
        `error: hook script not found at ${hookScript}. ` +
          `Reinstall @openthink/think and try again.`,
      );
      process.exitCode = 1;
      return;
    }

    let settings;
    try {
      settings = readSettings(settingsFile);
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }

    const result = addHookEntry(settings, hookScript);

    if (result === 'already_installed') {
      console.log(`think hook install: already installed (${settingsFile})`);
      return;
    }

    try {
      writeSettings(settingsFile, settings);
    } catch (err) {
      console.error(`error writing ${settingsFile}: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }

    console.log(`think hook install: installed to ${settingsFile}`);
  });

// ---------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------

const uninstallSubcommand = new Command('uninstall')
  .description('Remove the think UserPromptSubmit hook from Claude Code settings.')
  .option(
    '--project',
    'Target <cwd>/.claude/settings.local.json instead of ~/.claude/settings.json',
  )
  .action((opts: { project?: boolean }) => {
    const settingsFile = opts.project ? projectSettingsPath() : globalSettingsPath();

    let hookScript: string;
    try {
      hookScript = resolveHookScriptPath();
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }

    let settings;
    try {
      settings = readSettings(settingsFile);
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }

    const result = removeHookEntry(settings, hookScript);

    if (result === 'not_found') {
      console.log(`think hook uninstall: not installed (${settingsFile})`);
      return;
    }

    try {
      writeSettings(settingsFile, settings);
    } catch (err) {
      console.error(`error writing ${settingsFile}: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }

    console.log(`think hook uninstall: removed from ${settingsFile}`);
  });

// ---------------------------------------------------------------------------
// Parent command
// ---------------------------------------------------------------------------

export const hookCommand = new Command('hook')
  .description('Manage Claude Code hook integration for think.')
  .addCommand(installSubcommand)
  .addCommand(uninstallSubcommand);
