/**
 * think_recall MCP tool — AGT-315
 *
 * Exposes the daemon `recall` RPC as an MCP tool so agents can retrieve
 * relevant entries mid-conversation without leaving the Claude Code context.
 *
 * Input schema: query, scope, limit, kind, cortex (all per AC #2).
 * Output: MCP content block with markdown-formatted results (AC #4 / #5).
 * Error: isError:true content block when the daemon is unavailable (AC #4).
 */

import type { ThinkToolEntry } from '../server.js';
import type { DaemonClient } from '../../lib/daemon-client.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { sanitizeForLog } from '../../lib/sanitize.js';

// ---------------------------------------------------------------------------
// Types — mirroring RecallEntry from daemon/recall.ts (no circular import)
// ---------------------------------------------------------------------------

interface RecallEntry {
  id: string;
  ts: string;
  kind: string | null;
  content: string;
  cortex: string;
}

// ---------------------------------------------------------------------------
// Markdown formatter (pure function — easy to unit-test)
// ---------------------------------------------------------------------------

/**
 * Format a single recall entry as a markdown list item.
 *
 * Format: `- [cortex/kind] content`
 *
 * When `kind` is absent or null, the tag is `[cortex]` (no kind segment).
 * Content is trimmed; multi-line content is collapsed to its first line for
 * readability in the agent context window.
 *
 * @example
 *   formatEntry({ cortex: "fx-tracker", kind: "memory", content: "Auth uses Ed25519" })
 *   // => "- [fx-tracker/memory] Auth uses Ed25519"
 */
export function formatEntry(entry: RecallEntry): string {
  const tag = entry.kind ? `${entry.cortex}/${entry.kind}` : entry.cortex;
  // Use only the first line so the agent sees a compact list.
  const lines = entry.content.trim().split('\n');
  const firstLine = lines[0] ?? '';
  const truncated = lines.length > 1;
  return `- [${tag}] ${firstLine}${truncated ? ' …' : ''}`;
}

/**
 * Format an array of recall entries as a markdown bulleted list.
 * Returns a human-readable "no results" line when the array is empty.
 */
export function formatEntries(entries: RecallEntry[]): string {
  if (entries.length === 0) return '_No matching entries found._';
  return entries.map(formatEntry).join('\n');
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handler(
  params: Record<string, unknown>,
  client: DaemonClient,
): Promise<CallToolResult> {
  const query = typeof params['query'] === 'string' ? params['query'] : '';
  if (!query.trim()) {
    return {
      content: [{ type: 'text', text: 'think_recall: query is required and must be a non-empty string' }],
      isError: true,
    };
  }

  // Build the daemon RPC params — pass only defined optional fields.
  const rpcParams: Record<string, unknown> = { query };

  if (typeof params['scope'] === 'string') rpcParams['scope'] = params['scope'];
  if (typeof params['limit'] === 'number') rpcParams['limit'] = params['limit'];
  if (typeof params['kind'] === 'string') rpcParams['kind'] = params['kind'];
  if (typeof params['cortex'] === 'string') rpcParams['cortex'] = params['cortex'];

  process.stderr.write(
    `[think mcp] recall query="${sanitizeForLog(query)}"\n`,
  );

  let entries: RecallEntry[];
  try {
    entries = (await client.call('recall', rpcParams)) as RecallEntry[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `think_recall: daemon error — ${msg}` }],
      isError: true,
    };
  }

  return {
    content: [{ type: 'text', text: formatEntries(entries) }],
  };
}

// ---------------------------------------------------------------------------
// Tool entry — appended to registeredTools by the registration module.
// ---------------------------------------------------------------------------

export const thinkRecallTool: ThinkToolEntry = {
  tool: {
    name: 'think_recall',
    // AC #3 — verbatim description
    description:
      "Recall entries (memories, retros, events) from the user's think knowledge base, ranked by semantic similarity and recency. Use this when you need to know what's been decided, learned, or done about something the user is currently working on.",
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Semantic query — what you want to recall',
        },
        scope: {
          type: 'string',
          enum: ['active', 'accessible'],
          default: 'accessible',
          description: 'active = active cortex only; accessible = all locally-cloned cortexes (default)',
        },
        limit: {
          type: 'number',
          default: 5,
          description: 'Maximum number of entries to return (default 5)',
        },
        kind: {
          type: 'string',
          enum: ['memory', 'retro', 'event'],
          description: 'Filter by entry kind: memory = freeform observations; retro = durable codebase wisdom; event = milestones/decisions/incidents',
        },
        cortex: {
          type: 'string',
          description: 'Name of the cortex (knowledge base) to query. Defaults to the active cortex or all accessible cortexes when scope is accessible.',
        },
      },
      required: ['query'],
    },
  },
  handler,
};
