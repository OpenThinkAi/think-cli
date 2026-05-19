/**
 * Supersession LLM call — AGT-303
 *
 * Calls Claude to determine whether a new retro supersedes, duplicates, or
 * coexists with a set of same-cortex same-kind candidates. Uses a forced
 * tool_use call so the API enforces output shape server-side.
 *
 * The candidate-pull is the caller's responsibility. This module only
 * builds the prompt and calls the Anthropic SDK.
 */

// @anthropic-ai/sdk is a direct dep (not just a transitive dep via claude-agent-sdk)
// because the agent SDK does not re-export the Anthropic class or Message types.
import Anthropic from '@anthropic-ai/sdk';
import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages.js';
import { requireLlmConsent } from '../../lib/llm-consent.js';
import {
  SUPERSESSION_SYSTEM_PROMPT,
  buildSupersessionMessages,
} from './prompt.js';

// Re-export the input types so callers only need to import from call.ts.
export type { RetroEntry, RetroCandidate } from './prompt.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SupersessionResult {
  /**
   * IDs of candidates that the new retro replaces (may be empty).
   * Always empty when `isDuplicate` is true — enforced in the parser.
   */
  supersedes: string[];
  /** 1–4 short lowercase topic strings (capped at 4 in the parser). */
  topics: string[];
  /**
   * True when the new retro is essentially a duplicate of an existing one.
   * When true the daemon MUST skip storing the new retro.
   * `supersedes` will be empty in this case — callers MUST NOT delete
   * any candidate when `isDuplicate` is true.
   *
   * The tool input_schema uses `is_duplicate` (snake_case) — the parser
   * maps it to this camelCase field on the way out.
   */
  isDuplicate: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 300;
const TEMPERATURE = 0.1;

const SUPERSESSION_TOOL: Tool = {
  name: 'submit_supersession',
  description:
    'Submit the supersession judgment: which candidates the new retro replaces, topic tags, and a duplicate flag.',
  input_schema: {
    type: 'object',
    properties: {
      supersedes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Candidate ids the new retro replaces. Must be empty when is_duplicate is true.',
      },
      topics: {
        type: 'array',
        items: { type: 'string' },
        description: '1–4 short lowercase topic tags.',
      },
      is_duplicate: {
        type: 'boolean',
        description: 'True when the new retro is essentially a duplicate of an existing candidate.',
      },
    },
    required: ['supersedes', 'topics', 'is_duplicate'],
  },
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseSupersessionToolInput(input: unknown): SupersessionResult {
  if (!input || typeof input !== 'object') {
    throw new Error('Supersession tool_use.input is not an object');
  }
  const obj = input as Record<string, unknown>;

  const isDuplicate = typeof obj.is_duplicate === 'boolean' ? obj.is_duplicate : false;

  // When isDuplicate is true, callers must NOT delete any candidate —
  // treat it as a skip-storage-only result. Enforce here rather than
  // relying on callers to read the JSDoc.
  const supersedes = isDuplicate
    ? []
    : Array.isArray(obj.supersedes)
      ? obj.supersedes.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];

  // Cap at 4 to match the system prompt contract ("1–4 short lowercase strings").
  const topics = (
    Array.isArray(obj.topics)
      ? obj.topics.filter((t): t is string => typeof t === 'string' && t.length > 0)
      : []
  ).slice(0, 4);

  return { supersedes, topics, isDuplicate };
}

function extractToolUseInput(response: Anthropic.Message): unknown {
  for (const block of response.content) {
    if (block.type === 'tool_use' && block.name === SUPERSESSION_TOOL.name) {
      return block.input;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the supersession check for a new retro against a set of candidates.
 *
 * Uses Haiku 4.5 with forced tool_use so the API enforces output shape
 * server-side. alpha.11 tried Haiku with freeform JSON and hit 100% downstream
 * parse failures (reverted in alpha.13); this iteration moves to tool_use so
 * structural conformance is no longer the model's job. Retries once on a
 * missing tool_use block (transient non-determinism).
 *
 * `max_tokens: 300` is sized for the compact tool input. If the candidate
 * count is ever raised significantly (> ~20 long IDs), revisit this limit.
 *
 * The caller is responsible for fetching the candidate list (filter by
 * `kind = 'retro'` AND same cortex via vector search) before calling this.
 *
 * @param newRetro    The new retro entry being ingested.
 * @param candidates  Same-cortex, same-kind candidates above the similarity threshold.
 */
export async function runSupersession(
  newRetro: RetroEntry,
  candidates: RetroCandidate[],
): Promise<SupersessionResult> {
  requireLlmConsent();

  const client = new Anthropic();
  const { messages } = buildSupersessionMessages(newRetro, candidates);

  const callClaude = (): Promise<Anthropic.Message> =>
    client.messages.create({
      model: MODEL,
      temperature: TEMPERATURE,
      max_tokens: MAX_TOKENS,
      system: [
        {
          type: 'text',
          text: SUPERSESSION_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: [SUPERSESSION_TOOL],
      tool_choice: {
        type: 'tool',
        name: SUPERSESSION_TOOL.name,
        disable_parallel_tool_use: true,
      },
      messages,
    });

  // First attempt
  const response = await callClaude();
  if (response.stop_reason === 'max_tokens') {
    throw new Error(
      `Supersession response truncated at max_tokens=${MAX_TOKENS} — increase budget or reduce candidate count`,
    );
  }
  const toolInput = extractToolUseInput(response);
  if (toolInput !== null) {
    try {
      return parseSupersessionToolInput(toolInput);
    } catch (firstErr) {
      console.warn(`[supersession] parse failed on attempt 1, retrying`, firstErr);
    }
  } else {
    console.warn('[supersession] no tool_use block on attempt 1, retrying');
  }

  // Retry once on missing or unparseable tool_use (transient non-determinism).
  const retryResponse = await callClaude();
  if (retryResponse.stop_reason === 'max_tokens') {
    throw new Error(
      `Supersession response truncated at max_tokens=${MAX_TOKENS} — increase budget or reduce candidate count`,
    );
  }
  const retryToolInput = extractToolUseInput(retryResponse);
  if (retryToolInput === null) {
    throw new Error('Supersession response missing tool_use block after retry');
  }
  return parseSupersessionToolInput(retryToolInput);
}
