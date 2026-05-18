/**
 * think MCP server — AGT-314
 *
 * Exposes think tools over the Model Context Protocol using stdio transport.
 * Claude Code launches this process on demand via `think mcp`; it MUST NOT
 * be auto-started by the daemon or any other process.
 *
 * Architecture:
 *   MCP client (Claude Code) ↔ stdio ↔ this process ↔ daemon RPC (Unix socket)
 *
 * Stdout is the JSON-RPC channel. All human-readable diagnostics go to stderr.
 *
 * Tools are registered by downstream tickets (AGT-315/316/317). This scaffold
 * starts the server, validates daemon connectivity, and provides the
 * registration table that subsequent tickets append to.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { connectDaemon, DaemonUnavailableError, type DaemonClient } from '../lib/daemon-client.js';
import { readPackageVersion } from '../lib/version.js';
import { thinkSyncTool } from './tools/sync.js';
import { thinkExpandTool } from './tools/expand.js';

// ---------------------------------------------------------------------------
// Tool registration table
//
// AGT-315/316/317 append entries here. Each entry provides:
//   - `tool`: the MCP Tool descriptor (name, description, inputSchema)
//   - `handler`: async function that receives validated params and a live
//     DaemonClient, performs the daemon RPC call, and returns a CallToolResult
// ---------------------------------------------------------------------------

export interface ThinkToolEntry {
  tool: Tool;
  handler: (
    params: Record<string, unknown>,
    client: DaemonClient,
  ) => Promise<CallToolResult>;
}

/**
 * Registered think tools. Populated by downstream tickets; empty for AGT-314.
 * Exported so tests and future ticket modules can inspect or extend the table.
 */
export const registeredTools: ThinkToolEntry[] = [thinkSyncTool, thinkExpandTool]; // AGT-316

// ---------------------------------------------------------------------------
// Server factory
//
// Exported so tests can call `createMcpServer()` without going through the
// full stdio transport lifecycle.
// ---------------------------------------------------------------------------

export function createMcpServer(): Server {
  let version: string;
  try {
    version = readPackageVersion();
  } catch (err) {
    process.stderr.write(`[think mcp] warning: could not read package version — ${String(err)}\n`);
    version = '0.0.0';
  }

  const server = new Server(
    { name: 'think', version },
    { capabilities: { tools: {} } },
  );

  // -- tools/list -----------------------------------------------------------
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: registeredTools.map((entry) => entry.tool),
    };
  });

  // -- tools/call -----------------------------------------------------------
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const params = rawArgs ?? {};

    const entry = registeredTools.find((e) => e.tool.name === name);
    if (!entry) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    // Obtain a daemon client for this call. connectDaemon() reuses an open
    // connection within the process lifetime (module-level singleton in
    // daemon-client.ts), so this is cheap after the first call.
    let client: DaemonClient;
    try {
      client = await connectDaemon();
    } catch (err) {
      const msg = err instanceof DaemonUnavailableError
        ? `think daemon unavailable: ${err.message}`
        : `failed to connect to think daemon: ${String(err)}`;
      return {
        content: [{ type: 'text', text: msg }],
        isError: true,
      };
    }

    return entry.handler(params, client);
  });

  return server;
}

// ---------------------------------------------------------------------------
// runMcpServer — called by `think mcp`
// ---------------------------------------------------------------------------

/**
 * Start the MCP server using stdio transport.
 *
 * Validates daemon connectivity before accepting MCP connections so a clean
 * error surfaces to the agent immediately if the daemon can't start.
 *
 * Returns a Promise that resolves when the transport closes (client disconnect
 * or process signal). Caller is responsible for process.exit() if needed.
 */
export async function runMcpServer(): Promise<void> {
  // Validate daemon connectivity up-front. This spawns the daemon if it's not
  // already running so the first tool call doesn't pay the cold-start latency.
  process.stderr.write('[think mcp] validating daemon connectivity...\n');
  try {
    const client = await connectDaemon();
    // Ping the daemon with a status call to confirm it's responsive.
    await client.call('status', {}, 5_000);
    process.stderr.write('[think mcp] daemon connected\n');
  } catch (err) {
    const msg = err instanceof DaemonUnavailableError
      ? err.message
      : String(err);
    // Write error to stderr (stdout must remain JSON-RPC only) then exit so
    // the MCP client receives a clean process failure rather than a hung server.
    //
    // Use `process.exit(1)` (not `process.exitCode = 1; return`) because
    // `connectDaemon()` may have succeeded before the `status` call failed,
    // in which case the daemon-client module holds an open Unix-socket
    // singleton that's ref'd into the event loop. Letting the event loop
    // drain would hang the process; same reasoning as the shutdown handler.
    process.stderr.write(`[think mcp] error: daemon unavailable — ${msg}\n`);
    process.exit(1);
  }

  const server = createMcpServer();
  const transport = new StdioServerTransport();

  process.stderr.write('[think mcp] server starting (stdio transport)\n');
  await server.connect(transport);
  process.stderr.write('[think mcp] server ready\n');

  // Graceful shutdown on signals.
  //
  // `connectDaemon()` returns a module-level singleton with an open Unix-socket
  // connection that's ref'd into the event loop, so `await server.close()` alone
  // is not enough to terminate — the process will hang. Explicitly call
  // `process.exit(0)` after the transport has shut down to guarantee termination.
  async function shutdown(reason: string): Promise<void> {
    process.stderr.write(`[think mcp] shutting down (reason=${reason})\n`);
    await server.close();
    process.exit(0);
  }

  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => { process.exit(0); }); });
  process.on('SIGINT',  () => { shutdown('SIGINT').catch(() => { process.exit(0); }); });
}
