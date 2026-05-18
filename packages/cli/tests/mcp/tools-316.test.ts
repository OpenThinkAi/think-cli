/**
 * Tests for think_sync and think_expand MCP tools — AGT-316
 *
 * Uses InMemoryTransport + mocked daemon-client so no real daemon or stdio is needed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

// ---------------------------------------------------------------------------
// Mock daemon-client
// ---------------------------------------------------------------------------

const mockCall = vi.fn();

vi.mock("../../src/lib/daemon-client.js", () => {
  class DaemonUnavailableError extends Error {
    logPath = "";
    constructor(msg: string) { super(msg); this.name = "DaemonUnavailableError"; }
  }
  return {
    connectDaemon: vi.fn().mockResolvedValue({ call: mockCall, close: vi.fn() }),
    DaemonUnavailableError,
  };
});

// ---------------------------------------------------------------------------
// Mock config so getConfig().cortex.active resolves without ~/.think
// ---------------------------------------------------------------------------

vi.mock("../../src/lib/config.js", () => ({
  getConfig: vi.fn().mockReturnValue({ cortex: { active: "test-cortex" } }),
}));

// ---------------------------------------------------------------------------
// Per-test client/server pair with afterEach teardown
// ---------------------------------------------------------------------------

let currentClient: Client | undefined;
let currentServer: Server | undefined;

afterEach(async () => {
  await currentClient?.close().catch(() => { /* best-effort */ });
  await currentServer?.close().catch(() => { /* best-effort */ });
  currentClient = undefined;
  currentServer = undefined;
});

async function makeClient(): Promise<{ server: Server; client: Client }> {
  // Reset registration table and re-add AGT-316 tools each test so tests are isolated.
  const { createMcpServer, registeredTools } = await import("../../src/mcp/server.js");
  registeredTools.length = 0;
  const { thinkSyncTool } = await import("../../src/mcp/tools/sync.js");
  const { thinkExpandTool } = await import("../../src/mcp/tools/expand.js");
  registeredTools.push(thinkSyncTool, thinkExpandTool);

  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await client.connect(clientTransport);
  currentClient = client;
  currentServer = server;
  return { server, client };
}

// ---------------------------------------------------------------------------
// think_sync tests
// ---------------------------------------------------------------------------

describe("think_sync tool (AGT-316)", () => {
  beforeEach(() => {
    mockCall.mockReset();
  });

  it("appears in tools/list", async () => {
    const { client } = await makeClient();
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("think_sync");
  });

  it("routes to daemon sync RPC and returns stored kind abbrev-id", async () => {
    mockCall.mockResolvedValueOnce({ entry_id: "01abcdef1234567890", status: "stored" });
    const { client } = await makeClient();
    const result = await client.callTool({
      name: "think_sync",
      arguments: { content: "working on AGT-316", kind: "memory" },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toMatch(/✓ stored memory 01abcde/);
    expect(mockCall).toHaveBeenCalledWith("sync", expect.objectContaining({ content: "working on AGT-316", kind: "memory", cortex: "test-cortex" }));
  });

  it("passes topics to daemon when provided", async () => {
    mockCall.mockResolvedValueOnce({ entry_id: "aabbcc1234567890ab", status: "stored" });
    const { client } = await makeClient();
    await client.callTool({
      name: "think_sync",
      arguments: { content: "retro on think-cli", kind: "retro", topics: ["think-cli", "mcp"] },
    });
    expect(mockCall).toHaveBeenCalledWith("sync", expect.objectContaining({ topics: ["think-cli", "mcp"] }));
  });

  it("returns isError:true when daemon throws", async () => {
    mockCall.mockRejectedValueOnce(new Error("daemon offline"));
    const { client } = await makeClient();
    const result = await client.callTool({ name: "think_sync", arguments: { content: "hello" } });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toMatch(/daemon error/);
  });
});

// ---------------------------------------------------------------------------
// think_expand tests
// ---------------------------------------------------------------------------

describe("think_expand tool (AGT-316)", () => {
  beforeEach(() => {
    mockCall.mockReset();
  });

  it("appears in tools/list", async () => {
    const { client } = await makeClient();
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("think_expand");
  });

  it("routes to daemon expand RPC and returns markdown bundle", async () => {
    const expandResult = {
      primary: { id: "entry-abc", ts: "2026-05-17T00:00:00Z", author: "Matt", content: "compacted memory", kind: "memory", compacted_from: ["raw-1"], topics: [], supersedes: [], deleted_at: null, cortex: "test-cortex" },
      raws: [{ id: "raw-1", ts: "2026-05-16T00:00:00Z", author: "Matt", content: "original thought", kind: "memory", compacted_from: null, topics: [], supersedes: [], deleted_at: null, cortex: "test-cortex" }],
      compactions: [],
    };
    mockCall.mockResolvedValueOnce(expandResult);
    const { client } = await makeClient();
    const result = await client.callTool({
      name: "think_expand",
      arguments: { entry_id: "entry-abc" },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toMatch(/entry-abc/);
    expect(content[0]?.text).toMatch(/raw-1/);
    expect(content[0]?.text).toMatch(/Raw entries/);
    expect(mockCall).toHaveBeenCalledWith("expand", { cortex: "test-cortex", entry_id: "entry-abc" });
  });

  it("returns isError:true when daemon throws", async () => {
    mockCall.mockRejectedValueOnce(new Error("not_found"));
    const { client } = await makeClient();
    const result = await client.callTool({ name: "think_expand", arguments: { entry_id: "missing-id" } });
    expect(result.isError).toBe(true);
  });
});
