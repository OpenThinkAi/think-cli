/**
 * `think mcp` — launch the MCP server in stdio mode (AGT-314).
 *
 * Claude Code (or any MCP client) invokes this subcommand to start the server.
 * Stdout is the JSON-RPC channel; all diagnostics go to stderr.
 *
 * The command does NOT auto-start on daemon startup — it is launched on demand
 * by the MCP client via the Claude Code mcp configuration.
 */

import { Command } from 'commander';

export const mcpCommand = new Command('mcp')
  .description('Start the think MCP server (stdio transport, for use with Claude Code).')
  .action(async () => {
    // Lazy import keeps mcp/server.ts (and the @modelcontextprotocol/sdk peer)
    // out of the startup parse path for all other think commands.
    const { runMcpServer } = await import('../mcp/server.js');
    await runMcpServer();
  });
