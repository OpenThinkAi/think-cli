/**
 * Compaction SDK call — AGT-298
 *
 * Wraps the Anthropic SDK `messages.create` call for the compaction worker.
 * Uses a cached system prompt (cache_control: ephemeral) and a forced tool_use
 * call so the API enforces the JSON output shape server-side. Retries once on
 * any invalid response.
 *
 * Network errors (5xx, rate limit) are NOT caught here — they bubble up to
 * the queue layer (AGT-299) for retry with backoff.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { TextBlockParam, Tool } from '@anthropic-ai/sdk/resources/messages/messages.js';
import {
  COMPACTION_SYSTEM_PROMPT,
  buildCompactionMessages,
} from './prompt.js';
import type { NewEntry, CandidateEntry } from './prompt.js';
import { requireLlmConsent } from '../../lib/llm-consent.js';
import { resolveThinkApiKey } from '../../lib/curator.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { NewEntry, CandidateEntry };

/**
 * Successful compaction result. All three fields are validated before this
 * type is returned — invalid shapes from the model go through one retry and
 * then become `CompactionResponseInvalid`.
 */
export interface CompactionSuccess {
  status: 'ok';
  compacted_text: string;
  supersedes: string[];
  topics: string[];
}

/**
 * Returned when the model response is unusable after one retry. Covers three
 * distinct failure modes: no tool_use block, schema validation failure
 * (e.g. empty compacted_text), or empty topics array. The queue (AGT-299)
 * marks the entry as compaction-skipped (AGT-304) on receiving this.
 */
export interface CompactionResponseInvalid {
  status: 'response_invalid';
}

export type CompactionResult = CompactionSuccess | CompactionResponseInvalid;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Compaction model. Haiku 4.5 — alpha.11 tried Haiku with freeform JSON and
// hit 100% validateShape failures (reverted in alpha.13). This iteration uses
// forced tool_use with a server-validated input_schema so structural conformance
// is no longer the model's job. validateShape() remains as a belt-and-braces
// check for business rules (non-empty compacted_text, non-empty topics).
const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 600;
const TEMPERATURE = 0.2;

const COMPACTION_TOOL: Tool = {
  name: 'submit_compaction',
  description:
    'Submit the compacted entry, list of superseded entry ids, and topic tags.',
  input_schema: {
    type: 'object',
    properties: {
      compacted_text: {
        type: 'string',
        description: 'One-line self-contained rewrite of the new entry.',
      },
      supersedes: {
        type: 'array',
        items: { type: 'string' },
        description: 'IDs of context entries that the new entry replaces.',
      },
      topics: {
        type: 'array',
        items: { type: 'string' },
        description: '1–4 short lowercase topic tags.',
      },
    },
    required: ['compacted_text', 'supersedes', 'topics'],
  },
};

// ---------------------------------------------------------------------------
// Response shape validation
// ---------------------------------------------------------------------------

/**
 * Validate business rules on tool_use.input. The API has already enforced the
 * structural shape via input_schema; this only catches semantic problems an
 * input_schema can't express (empty compacted_text → data loss if caller
 * deletes superseded entries).
 *
 * Returns the typed result or null on failure.
 */
function validateShape(parsed: unknown): CompactionSuccess | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.compacted_text !== 'string' || obj.compacted_text.trim() === '') return null;
  if (!Array.isArray(obj.supersedes)) return null;
  if (!obj.supersedes.every((s) => typeof s === 'string')) return null;
  if (!Array.isArray(obj.topics)) return null;
  if (!obj.topics.every((t) => typeof t === 'string')) return null;

  return {
    status: 'ok',
    compacted_text: obj.compacted_text,
    supersedes: obj.supersedes as string[],
    topics: obj.topics as string[],
  };
}

// ---------------------------------------------------------------------------
// Single attempt
// ---------------------------------------------------------------------------

async function attemptCompaction(
  client: Anthropic,
  newEntry: NewEntry,
  candidates: CandidateEntry[],
): Promise<CompactionSuccess | null> {
  const { messages } = buildCompactionMessages(newEntry, candidates);

  const systemBlock: TextBlockParam = {
    type: 'text',
    text: COMPACTION_SYSTEM_PROMPT,
    cache_control: { type: 'ephemeral' },
  };

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    system: [systemBlock],
    tools: [COMPACTION_TOOL],
    tool_choice: {
      type: 'tool',
      name: COMPACTION_TOOL.name,
      disable_parallel_tool_use: true,
    },
    messages,
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === COMPACTION_TOOL.name,
  );
  if (!toolUse) return null;

  return validateShape(toolUse.input);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the compaction call against the Anthropic API.
 *
 * - Enforces LLM consent gate before any network call.
 * - On any invalid response (no tool_use block or business-rule failure):
 *   retries once with the identical prompt.
 * - On second failure: returns `{ status: "response_invalid" }`.
 * - Network errors (5xx, rate limit) bubble up to the caller unchanged.
 *
 * @param newEntry   The new memory entry to compact.
 * @param candidates Top-K similar candidate entries from the vector store.
 */
export async function runCompaction(
  newEntry: NewEntry,
  candidates: CandidateEntry[],
): Promise<CompactionResult> {
  requireLlmConsent();

  const client = new Anthropic({ apiKey: resolveThinkApiKey() });

  const first = await attemptCompaction(client, newEntry, candidates);
  if (first !== null) return first;

  const second = await attemptCompaction(client, newEntry, candidates);
  if (second !== null) return second;

  return { status: 'response_invalid' };
}
