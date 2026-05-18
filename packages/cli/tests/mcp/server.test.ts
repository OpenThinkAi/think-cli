/**
 * Tests for the AGT-314 MCP server scaffold.
 *
 * In-process tests use InMemoryTransport + MCP Client so no real stdio
 * subprocess or daemon is needed. The daemon-client module is mocked so
 * no actual Unix socket is created during tests.
 *
 * A subprocess test (skipped unless dist/ exists) spawns the full `think mcp`
 * CLI and exercises the stdio JSON-RPC channel end-to-end.
 */

import { describe, it, expect, vi } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

// ---------------------------------------------------------------------------
// Mock daemon-client for all in-process tests in this file.
// vi.mock is hoisted before imports, so we stub the module globally here.
// ---------------------------------------------------------------------------

vi.mock('../../src/lib/daemon-client.js', () => {
  class DaemonUnavailableError extends Error {
    logPath = '';
    constructor(msg: string) {
      super(msg);
      this.name = 'DaemonUnavailableError';
    }
  }
  return {
    connectDaemon: vi.fn().mockResolvedValue({
      call: vi.fn().mockResolvedValue({ status: 'ok' }),
      close: vi.fn(),
    }),
    DaemonUnavailableError,
  };
});

// ---------------------------------------------------------------------------
// In-process: tools/list + tools/call
// ---------------------------------------------------------------------------

describe('MCP server scaffold — in-process', () => {
  async function makeClientServerPair() {
    // Dynamic import returns the cached module singleton; reset the shared
    // registration table immediately after to isolate each test.
    const { createMcpServer, registeredTools } = await import('../../src/mcp/server.js');

    // Clear the registration table so tests are isolated.
    registeredTools.length = 0;

    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client(
      { name: 'test-client', version: '0.0.0' },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    return { server, client, registeredTools };
  }

  it('tools/list returns an empty tools array when no tools are registered', async () => {
    const { server, client } = await makeClientServerPair();

    const result = await client.listTools();
    expect(result.tools).toEqual([]);

    await client.close();
    await server.close();
  });

  it('tools/call returns isError:true for an unknown tool', async () => {
    const { server, client } = await makeClientServerPair();

    const result = await client.callTool({ name: 'nonexistent_tool', arguments: {} });
    expect(result.isError).toBe(true);

    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toMatch(/unknown tool/i);

    await client.close();
    await server.close();
  });

  it('registered tool appears in tools/list', async () => {
    const { server, client, registeredTools } = await makeClientServerPair();

    // Register a stub tool the same way AGT-315/316/317 will.
    registeredTools.push({
      tool: {
        name: 'think_stub',
        description: 'A stub tool for testing tool registration',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      handler: async (_params, _client) => ({
        content: [{ type: 'text', text: 'stub result' }],
      }),
    });

    const result = await client.listTools();
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]?.name).toBe('think_stub');

    await client.close();
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// Subprocess: spawn `think mcp`, send JSON-RPC tools/list, verify response.
//
// Skipped unless dist/index.js exists. Run `npm run build` to enable.
// The subprocess exits cleanly when we close its stdin.
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const DIST_INDEX = join(PKG_ROOT, 'dist', 'index.js');

describe('MCP server — subprocess stdio', () => {
  it.skipIf(!existsSync(DIST_INDEX))(
    'tools/list returns valid JSON-RPC response with empty tools array',
    async () => {
      const thinkHome = mkdtempSync(join(tmpdir(), 'think-mcp-test-'));
      const testEnv = { ...process.env, THINK_HOME: thinkHome };
      const socketPath = join(thinkHome, 'daemon.sock');

      // Pre-start the daemon in-process so connectDaemon() inside the MCP
      // subprocess can connect to an existing socket. This avoids the
      // bundled-CLI path-resolution limitation in spawnDaemon().
      const daemonMod = await import('../../src/daemon/index.js');

      let resolveReady: () => void;
      const daemonReady = new Promise<void>((r) => { resolveReady = r; });

      // With foreground:true the daemon writes to stderr; spy to catch the ready line.
      const origWrite = process.stderr.write.bind(process.stderr);
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk, ...rest) => {
        if (String(chunk).includes('think daemon ready')) resolveReady();
        return (origWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
      });

      // Intercept process.exit so the test process doesn't die on shutdown.
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);

      const daemonPromise = daemonMod.runDaemon({
        socketPath,
        foreground: true,
      });

      // Wait up to 15s for the daemon to signal ready (model load on first run).
      const daemonReadyTimeout = new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('daemon did not become ready within 15s')), 15_000),
      );
      await Promise.race([daemonReady, daemonReadyTimeout]);
      // Spy no longer needed; it will be fully restored in the finally block.

      try {
        const initId = 'init-1';
        const listId = 'list-1';

        // MCP initialization handshake required before any method call.
        const initRequest = JSON.stringify({
          jsonrpc: '2.0',
          id: initId,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test', version: '0.0.0' },
          },
        }) + '\n';

        const listRequest = JSON.stringify({
          jsonrpc: '2.0',
          id: listId,
          method: 'tools/list',
          params: {},
        }) + '\n';

        const child = spawn(process.execPath, [DIST_INDEX, 'mcp'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: testEnv,
        });

        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (c: string) => { stdout += c; });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (c: string) => { stderr += c; });

        child.stdin.write(initRequest);
        child.stdin.write(listRequest);

        const toolsListResponse = await new Promise<Record<string, unknown>>((resolve, reject) => {
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`timed out waiting for tools/list response.\nstderr: ${stderr}`));
          }, 10_000);

          function scan(): void {
            for (const line of stdout.split('\n')) {
              if (!line.trim()) continue;
              let msg: unknown;
              try { msg = JSON.parse(line); } catch { continue; }
              if (
                typeof msg === 'object' && msg !== null &&
                (msg as Record<string, unknown>)['id'] === listId
              ) {
                clearTimeout(timer);
                child.stdin.end();
                resolve(msg as Record<string, unknown>);
                return;
              }
            }
          }

          child.stdout.on('data', scan);
          child.on('close', (code) => {
            clearTimeout(timer);
            scan();
            reject(new Error(`process exited (code=${code}) before tools/list response.\nstderr: ${stderr}`));
          });
        });

        expect(toolsListResponse['jsonrpc']).toBe('2.0');
        expect(toolsListResponse['id']).toBe(listId);
        expect(toolsListResponse).not.toHaveProperty('error');
        const result = toolsListResponse['result'] as Record<string, unknown>;
        expect(Array.isArray(result['tools'])).toBe(true);
        // AGT-316 registered think_sync + think_expand; AGT-315/317 may add more.
        expect((result['tools'] as unknown[]).length).toBeGreaterThanOrEqual(2);
      } finally {
        // Trigger graceful daemon shutdown. The exitSpy makes process.exit a
        // no-op so the test process itself doesn't die; restore spies after
        // a brief drain window.
        process.emit('SIGTERM');
        await new Promise<void>((res) => setTimeout(res, 200));
        stderrSpy.mockRestore();
        exitSpy.mockRestore();
        // daemonPromise never resolves (runDaemon blocks until process.exit
        // which is mocked); don't await it.
        rmSync(thinkHome, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
