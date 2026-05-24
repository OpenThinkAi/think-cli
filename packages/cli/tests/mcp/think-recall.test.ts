/**
 * Tests for the AGT-315 think_recall MCP tool.
 *
 * In-process tests use InMemoryTransport + MCP Client so no real daemon is needed.
 * The daemon-client module is mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { formatEntry, formatEntries } from '../../src/mcp/tools/think-recall.js';

// ---------------------------------------------------------------------------
// Mock daemon-client — no real socket needed.
// ---------------------------------------------------------------------------

const mockCall = vi.fn();

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
      call: mockCall,
      close: vi.fn(),
    }),
    DaemonUnavailableError,
  };
});

// ---------------------------------------------------------------------------
// formatEntry / formatEntries — pure formatter unit tests
// ---------------------------------------------------------------------------

describe('formatEntry', () => {
  it('formats an entry with kind', () => {
    const entry = { id: '1', ts: '', kind: 'memory', content: 'Auth uses Ed25519', cortex: 'fx-tracker' };
    expect(formatEntry(entry)).toBe('- [fx-tracker/memory] Auth uses Ed25519');
  });

  it('formats an entry without kind (null)', () => {
    const entry = { id: '1', ts: '', kind: null, content: 'Some content', cortex: 'my-cortex' };
    expect(formatEntry(entry)).toBe('- [my-cortex] Some content');
  });

  it('uses only the first line of multi-line content with truncation indicator', () => {
    const entry = { id: '1', ts: '', kind: 'retro', content: 'Line one\nLine two\nLine three', cortex: 'proj' };
    expect(formatEntry(entry)).toBe('- [proj/retro] Line one …');
  });

  it('does not append truncation indicator for single-line content', () => {
    const entry = { id: '1', ts: '', kind: 'memory', content: 'Single line', cortex: 'proj' };
    expect(formatEntry(entry)).toBe('- [proj/memory] Single line');
  });
});

describe('formatEntries', () => {
  it('returns no-results string for empty array', () => {
    expect(formatEntries([])).toBe('_No matching entries found._');
  });

  it('joins entries with newlines', () => {
    const entries = [
      { id: '1', ts: '', kind: 'memory', content: 'First', cortex: 'a' },
      { id: '2', ts: '', kind: 'retro', content: 'Second', cortex: 'b' },
    ];
    expect(formatEntries(entries)).toBe('- [a/memory] First\n- [b/retro] Second');
  });
});

// ---------------------------------------------------------------------------
// think_recall tool — in-process MCP client/server tests
// ---------------------------------------------------------------------------

describe('think_recall MCP tool', () => {
  async function makeClientServerPair() {
    const { createMcpServer } = await import('../../src/mcp/server.js');
    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(
      { name: 'test-client', version: '0.0.0' },
      { capabilities: {} },
    );
    await client.connect(clientTransport);
    return { server, client };
  }

  beforeEach(() => {
    mockCall.mockReset();
  });

  it('appears in tools/list', async () => {
    const { server, client } = await makeClientServerPair();
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toContain('think_recall');
    await client.close();
    await server.close();
  });

  it('returns formatted markdown when daemon returns entries', async () => {
    const { server, client } = await makeClientServerPair();
    mockCall.mockResolvedValue([
      { id: 'a', ts: '2026-05-17T00:00:00Z', kind: 'memory', content: 'Auth uses Ed25519 since March', cortex: 'fx-tracker' },
    ]);

    const result = await client.callTool({ name: 'think_recall', arguments: { query: 'auth' } });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain('- [fx-tracker/memory] Auth uses Ed25519 since March');

    await client.close();
    await server.close();
  });

  it('returns no-results message when daemon returns empty array', async () => {
    const { server, client } = await makeClientServerPair();
    mockCall.mockResolvedValue([]);

    const result = await client.callTool({ name: 'think_recall', arguments: { query: 'nonexistent' } });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toBe('_No matching entries found._');

    await client.close();
    await server.close();
  });

  it('returns isError:true when daemon call throws', async () => {
    const { server, client } = await makeClientServerPair();
    mockCall.mockRejectedValue(new Error('daemon RPC failed'));

    const result = await client.callTool({ name: 'think_recall', arguments: { query: 'anything' } });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toMatch(/daemon error/i);

    await client.close();
    await server.close();
  });

  it('returns isError:true when query is empty string', async () => {
    const { server, client } = await makeClientServerPair();
    const result = await client.callTool({ name: 'think_recall', arguments: { query: '' } });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toMatch(/query is required/i);
    await client.close();
    await server.close();
  });

  it('returns isError:true when query is whitespace-only', async () => {
    const { server, client } = await makeClientServerPair();
    const result = await client.callTool({ name: 'think_recall', arguments: { query: '   ' } });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toMatch(/query is required/i);
    await client.close();
    await server.close();
  });

  it('passes scope, limit, kind, cortex to daemon when provided', async () => {
    const { server, client } = await makeClientServerPair();
    mockCall.mockResolvedValue([]);

    await client.callTool({
      name: 'think_recall',
      arguments: { query: 'auth', scope: 'active', limit: 3, kind: 'retro', cortex: 'fx-tracker' },
    });

    // source is always tagged 'mcp'; session_id is added only when
    // CLAUDE_CODE_SESSION_ID is set, so match on a superset to stay env-robust.
    expect(mockCall).toHaveBeenCalledWith(
      'recall',
      expect.objectContaining({
        query: 'auth',
        scope: 'active',
        limit: 3,
        kind: 'retro',
        cortex: 'fx-tracker',
        source: 'mcp',
      }),
    );

    await client.close();
    await server.close();
  });
});
