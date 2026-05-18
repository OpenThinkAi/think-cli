/**
 * `think mcp` — launch the MCP server in stdio mode (AGT-314), and
 * install / uninstall it into Claude Code's MCP config (AGT-317).
 *
 * Subcommands:
 *   think mcp install [--project]
 *   think mcp uninstall [--project]
 *
 * Without --project the target is the global `~/.claude.json`.
 * With --project the target is `<cwd>/.mcp.json`.
 *
 * The bare `think mcp` action starts the server in stdio mode for use
 * by Claude Code (or any MCP client).
 */

import fs from 'node:fs';
import { Command } from 'commander';
import {
  globalMcpConfigPath,
  projectMcpConfigPath,
  readMcpConfig,
  writeMcpConfig,
  addMcpEntry,
  removeMcpEntry,
  resolveMcpServerPath,
} from '../lib/claude-settings.js';

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

const installSubcommand = new Command('install')
  .description('Register the think MCP server in Claude Code MCP config.')
  .option(
    '--project',
    'Target <cwd>/.mcp.json instead of ~/.claude.json',
  )
  .action((opts: { project?: boolean }) => {
    const configFile = opts.project ? projectMcpConfigPath() : globalMcpConfigPath();

    let serverScript: string;
    try {
      serverScript = resolveMcpServerPath();
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }

    if (!fs.existsSync(serverScript)) {
      console.error(
        `error: MCP server not found at ${serverScript}. ` +
          `Reinstall @openthink/think and try again.`,
      );
      process.exitCode = 1;
      return;
    }

    let config;
    try {
      config = readMcpConfig(configFile);
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }

    const result = addMcpEntry(config, serverScript);

    if (result === 'already_installed') {
      console.log(`think mcp install: already installed (${configFile})`);
      return;
    }

    try {
      writeMcpConfig(configFile, config);
    } catch (err) {
      console.error(`error writing ${configFile}: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }

    console.log(`think mcp install: installed to ${configFile}`);
  });

// ---------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------

const uninstallSubcommand = new Command('uninstall')
  .description('Remove the think MCP server from Claude Code MCP config.')
  .option(
    '--project',
    'Target <cwd>/.mcp.json instead of ~/.claude.json',
  )
  .action((opts: { project?: boolean }) => {
    const configFile = opts.project ? projectMcpConfigPath() : globalMcpConfigPath();

    let config;
    try {
      config = readMcpConfig(configFile);
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }

    const result = removeMcpEntry(config);

    if (result === 'not_found') {
      console.log(`think mcp uninstall: not installed (${configFile})`);
      return;
    }

    try {
      writeMcpConfig(configFile, config);
    } catch (err) {
      console.error(`error writing ${configFile}: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }

    console.log(`think mcp uninstall: removed from ${configFile}`);
  });

// ---------------------------------------------------------------------------
// Parent command
// ---------------------------------------------------------------------------

export const mcpCommand = new Command('mcp')
  .description('Manage the think MCP server (start in stdio mode, or install/uninstall).')
  .addCommand(installSubcommand)
  .addCommand(uninstallSubcommand)
  .action(async () => {
    // Lazy import keeps mcp/server.ts (and the @modelcontextprotocol/sdk peer)
    // out of the startup parse path for all other think commands.
    const { runMcpServer } = await import('../mcp/server.js');
    await runMcpServer();
  });
