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
    'Write to <cwd>/.claude/settings.local.json instead of ~/.claude/settings.json',
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

    if (!fs.existsSync(hookScript)) {
      console.error(
        `warning: hook script not found at ${hookScript}; ` +
          `run \`npm run build\` or reinstall @openthink/think before using this hook.`,
      );
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
      console.log(`already installed (${settingsFile})`);
      return;
    }

    try {
      writeSettings(settingsFile, settings);
    } catch (err) {
      console.error(`error writing ${settingsFile}: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }

    console.log(`installed → ${settingsFile}`);
    console.log(`hook script: ${hookScript}`);
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
      console.log(`not installed (no matching entry in ${settingsFile})`);
      return;
    }

    try {
      writeSettings(settingsFile, settings);
    } catch (err) {
      console.error(`error writing ${settingsFile}: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }

    console.log(`removed from ${settingsFile}`);
  });

// ---------------------------------------------------------------------------
// Parent command
// ---------------------------------------------------------------------------

export const hookCommand = new Command('hook')
  .description('Manage Claude Code hook integration for think.')
  .addCommand(installSubcommand)
  .addCommand(uninstallSubcommand);
