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
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const DIST_INDEX = join(PKG_ROOT, 'dist', 'index.js');
const DIST_MCP_SERVER = join(PKG_ROOT, 'dist', 'mcp', 'server.js');

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
          }, 30_000);

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
        // AGT-315/316 registered think_recall + think_sync + think_expand; expect >= 3.
        expect((result['tools'] as unknown[]).length).toBeGreaterThanOrEqual(3);
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
    // Generous budget: a cold MCP subprocess (loads node:sqlite + the daemon
    // module graph from dist) under parallel fork-pool load can need well over
    // the old 15s. 15s daemon-ready + 30s tools/list worst case → 45s.
    45_000,
  );
});

// ---------------------------------------------------------------------------
// isDirectInvocation — the guard that self-starts the server when launched
// as `node dist/mcp/server.js` (the command `think mcp install` registers).
// ---------------------------------------------------------------------------

describe('isDirectInvocation', () => {
  async function getHelper() {
    const { isDirectInvocation } = await import('../../src/mcp/server.js');
    return isDirectInvocation;
  }

  it('returns false when argv[1] is undefined (e.g. node REPL)', async () => {
    const isDirectInvocation = await getHelper();
    expect(isDirectInvocation(undefined, import.meta.url)).toBe(false);
  });

  it('returns true when argv[1] is the module path itself', async () => {
    const isDirectInvocation = await getHelper();
    // realpathSync: on macOS tmpdir() is a symlink (/var → /private/var);
    // resolve it up front so the constructed module URL is already real,
    // matching how Node reports import.meta.url.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'think-direct-')));
    try {
      const script = join(dir, 'server.js');
      writeFileSync(script, '// stand-in module\n');
      expect(isDirectInvocation(script, pathToFileURL(script).href)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns true when argv[1] is a symlink to the module path', async () => {
    const isDirectInvocation = await getHelper();
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'think-direct-')));
    try {
      const script = join(dir, 'server.js');
      const link = join(dir, 'server-link.js');
      writeFileSync(script, '// stand-in module\n');
      symlinkSync(script, link);
      expect(isDirectInvocation(link, pathToFileURL(script).href)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns false when argv[1] is a different script (e.g. the CLI entry)', async () => {
    const isDirectInvocation = await getHelper();
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'think-direct-')));
    try {
      const script = join(dir, 'server.js');
      const other = join(dir, 'index.js');
      writeFileSync(script, '// stand-in module\n');
      writeFileSync(other, '// stand-in CLI entry\n');
      expect(isDirectInvocation(other, pathToFileURL(script).href)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns false for a nonexistent argv[1] path', async () => {
    const isDirectInvocation = await getHelper();
    expect(isDirectInvocation('/nonexistent/script.js', import.meta.url)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Subprocess: spawn `node dist/mcp/server.js` — exactly the command that
// `think mcp install` writes into Claude Code's MCP config.
//
// Regression test: before the direct-invocation guard, this loaded the
// module, did nothing, and exited 0, which Claude Code surfaced as
// "MCP error -32000: Connection closed".
//
// Skipped unless dist/mcp/server.js exists. Run `npm run build` to enable.
// ---------------------------------------------------------------------------

describe('MCP server — direct node invocation', () => {
  it.skipIf(!existsSync(DIST_MCP_SERVER))(
    'starts the server instead of exiting silently with code 0',
    async () => {
      const thinkHome = mkdtempSync(join(tmpdir(), 'think-mcp-direct-'));
      try {
        const child = spawn(process.execPath, [DIST_MCP_SERVER], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, THINK_HOME: thinkHome },
        });

        let stderr = '';
        child.stderr.setEncoding('utf8');

        // Pass as soon as the server announces itself on stderr (it may then
        // fail daemon validation in this bare environment — that's fine, the
        // bug under test is the silent 0-exit before any code runs). Fail if
        // the process exits without ever announcing, or hangs silently.
        const outcome = await new Promise<string>((res) => {
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            res(`timed out with no [think mcp] output.\nstderr: ${stderr}`);
          }, 20_000);
          child.stderr.on('data', (c: string) => {
            stderr += c;
            if (stderr.includes('[think mcp]')) {
              clearTimeout(timer);
              child.kill('SIGKILL');
              res('started');
            }
          });
          child.on('close', (code) => {
            clearTimeout(timer);
            res(stderr.includes('[think mcp]')
              ? 'started'
              : `exited (code=${code}) with no [think mcp] output.\nstderr: ${stderr}`);
          });
        });

        expect(outcome).toBe('started');
      } finally {
        rmSync(thinkHome, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
