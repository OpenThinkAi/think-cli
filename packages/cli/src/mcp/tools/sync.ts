/**
 * think_sync MCP tool — AGT-316
 *
 * Wraps the daemon `sync` RPC for agent use via MCP. Agents call this to
 * record a new entry in the user's think knowledge base mid-conversation.
 *
 * Returns:
 *   Success — { content: [{ type: "text", text: "✓ stored <kind> <abbrev-id>" }] }
 *   Error   — isError: true content block
 */

import type { ThinkToolEntry } from '../server.js';
import { getConfig } from '../../lib/config.js';

const SYNC_TOOL_DESCRIPTION =
  "Record a new entry in the user's think knowledge base. Use kind='memory' for ongoing work observations, 'retro' for durable lessons about a codebase, 'event' for notable things-that-happened.";

export const thinkSyncTool: ThinkToolEntry = {
  tool: {
    name: 'think_sync',
    description: SYNC_TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The text to store.' },
        kind: {
          type: 'string',
          enum: ['memory', 'retro', 'event'],
          description: "Entry kind. Default: 'memory'.",
        },
        topics: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional topic tags.',
        },
        cortex: {
          type: 'string',
          description: 'Target cortex name. Defaults to the active cortex.',
        },
      },
      required: ['content'],
    },
  },

  async handler(params, client) {
    const cortexParam = typeof params['cortex'] === 'string' ? params['cortex'] : undefined;
    const cortex = cortexParam ?? getConfig().cortex?.active;
    if (!cortex) {
      return {
        content: [{ type: 'text' as const, text: 'think_sync: no cortex specified and no active cortex configured. Pass cortex or run: think cortex switch <name>' }],
        isError: true,
      };
    }

    const content = params['content'];
    if (typeof content !== 'string' || content.trim().length === 0) {
      return {
        content: [{ type: 'text' as const, text: 'think_sync: content must be a non-empty string' }],
        isError: true,
      };
    }

    const kind = typeof params['kind'] === 'string' ? params['kind'] : 'memory';
    const rpcParams: Record<string, unknown> = { cortex, content, kind };
    if (Array.isArray(params['topics'])) {
      rpcParams['topics'] = params['topics'];
    }

    let result: unknown;
    try {
      result = await client.call('sync', rpcParams);
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `think_sync: daemon error — ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }

    const r = result as { entry_id?: string; status?: string };
    const entryId = typeof r?.entry_id === 'string' ? r.entry_id : 'unknown';
    const abbrev = entryId.slice(0, 7);
    return { content: [{ type: 'text' as const, text: `✓ stored ${kind} ${abbrev}` }] };
  },
};
