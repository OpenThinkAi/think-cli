/**
 * think_expand MCP tool — AGT-316
 *
 * Wraps the daemon expand RPC for agent use via MCP.
 * Description: Drill into the raw provenance of a compacted entry, or see the compactions that fold a given raw entry.
 */

import type { ThinkToolEntry } from '../server.js';
import { getConfig } from '../../lib/config.js';
import type { ExpandResult } from '../../daemon/expand.js';

const EXPAND_TOOL_DESCRIPTION =
  "Drill into the raw provenance of a compacted entry, or see the compactions that fold a given raw entry.";

function formatExpandResult(r: ExpandResult): string {
  const lines: string[] = [];
  const p = r.primary;
  lines.push("## Entry " + p.id);
  lines.push("- kind: " + (p.kind ?? "memory"));
  lines.push("- cortex: " + p.cortex);
  lines.push("- ts: " + p.ts);
  lines.push("- author: " + p.author);
  if (p.deleted_at) lines.push("- deleted_at: " + p.deleted_at);
  lines.push('');
  lines.push("**Content:**");
  lines.push(p.content);
  if (r.raws.length > 0) {
    lines.push('');
    lines.push("## Raw entries (" + r.raws.length + ") compacted into primary");
    for (const raw of r.raws) {
      lines.push("### " + raw.id);
      lines.push("- ts: " + raw.ts);
      if (raw.deleted_at) lines.push("- deleted_at: " + raw.deleted_at);
      lines.push(raw.content);
    }
  }
  if (r.compactions.length > 0) {
    lines.push('');
    lines.push("## Compactions (" + r.compactions.length + ") that fold this entry");
    for (const c of r.compactions) {
      lines.push("### " + c.id);
      lines.push("- ts: " + c.ts);
      if (c.deleted_at) lines.push("- deleted_at: " + c.deleted_at);
      lines.push(c.content);
    }
  }
  if (r.raws.length === 0 && r.compactions.length === 0) {
    lines.push('');
    lines.push("_(no raw or compaction relationships — standalone entry)_");
  }
  return lines.join("\n");
}

export const thinkExpandTool: ThinkToolEntry = {
  tool: {
    name: 'think_expand',
    description: EXPAND_TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        entry_id: { type: 'string', description: 'ID of the entry to expand.' },
        cortex: { type: 'string', description: 'Cortex containing the entry. Defaults to the active cortex.' },
      },
      required: ['entry_id'],
    },
  },

  async handler(params, client) {
    const cortexParam = typeof params['cortex'] === 'string' ? params['cortex'] : undefined;
    const cortex = cortexParam ?? getConfig().cortex?.active;
    if (!cortex) {
      return {
        content: [{ type: 'text' as const, text: 'think_expand: no cortex specified and no active cortex configured. Pass cortex or run: think cortex switch <name>' }],
        isError: true,
      };
    }

    const entryId = params['entry_id'];
    if (typeof entryId !== 'string' || entryId.trim().length === 0) {
      return {
        content: [{ type: 'text' as const, text: 'think_expand: entry_id must be a non-empty string' }],
        isError: true,
      };
    }

    let result: unknown;
    try {
      result = await client.call('expand', { cortex, entry_id: entryId.trim() });
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: "think_expand: daemon error — " + (err instanceof Error ? err.message : String(err)) }],
        isError: true,
      };
    }

    const bundle = result as ExpandResult;
    return { content: [{ type: 'text' as const, text: formatExpandResult(bundle) }] };
  },
};